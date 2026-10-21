// ---------------------------------------------------------------------------
// The recorded greeting (pronunciation build, Step 2, 2026-10-20).
//
// gemini-3.8-live cannot be made to say a name right every time; a recording
// can. So an inbound call opens with a clip made ahead of time by Google TTS,
// in the Chirp 3 HD voice with the same name as the business's live voice
// (owner's pick by ear: phonetic spelling, en-GB-Chirp3-HD-Kore), and the
// model is told the greeting was already said.
//
// THE ONE RULE: a clip plays only if it was made from exactly what would be
// said now -- same text (greeting, disclosure, pronunciations), same voice,
// same language. The stored `input_hash` is a hash of the SSML and the TTS
// voice; anything else is a miss, the AI speaks the greeting itself as before,
// and a fresh clip is made in the background for the next call. A stale clip
// can therefore never play.
//
// Variants: "custom" for a business's own greeting; "morning" / "afternoon" /
// "evening" for the time-of-day default (owner, 2026-10-20), chosen by the
// business's own clock at pickup.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { greetingTextFor } from "./greeting.js";
import { toSpoken, toSsml } from "./pronunciation.js";

/** Bump when the SSML or render settings change, so every stored clip is remade. */
export const GREETING_CLIP_VERSION = 1;
export const GREETING_CLIP_LOAD_TIMEOUT_MS = 300;

const VARIANT_HOURS = { morning: 9, afternoon: 14, evening: 19 };
export const TOD_VARIANTS = Object.keys(VARIANT_HOURS);

/** On only when GREETING_CLIP=on (default off until verified on a live call). */
export function greetingClipEnabled(env = process.env) {
  return String(env?.GREETING_CLIP || "").trim().toLowerCase() === "on";
}

/**
 * Which clip this call needs. Same hour thresholds as greetingTextFor.
 * @param {object} config
 * @param {Date} [now]
 */
export function greetingVariant(config, now = new Date()) {
  if (config?._hasCustomGreeting) return "custom";
  const tz = config?.timezone || "America/Chicago";
  const hour = parseInt(now.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }).split(":")[0], 10);
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

/**
 * Everything a clip is made from, and the hash that identifies it.
 * @param {object} config - the WRITTEN config (loadConfig)
 * @param {{languageCode: string, liveVoice: string, variant: string}} o
 */
export function greetingClipSpec(config, { languageCode, liveVoice, variant }) {
  const hour = VARIANT_HOURS[variant];
  const writtenText = greetingTextFor(config, Number.isInteger(hour) ? { hour } : {});
  const map = config?.pronunciations;
  const ttsVoice = `${languageCode}-Chirp3-HD-${liveVoice}`;
  const ssml = toSsml(writtenText, map);
  const hash = createHash("sha256")
    .update(JSON.stringify({ v: GREETING_CLIP_VERSION, ttsVoice, ssml }))
    .digest("hex")
    .slice(0, 32);
  return { variant, languageCode, ttsVoice, writtenText, spokenText: toSpoken(writtenText, map), ssml, hash };
}

const inFlight = new Map();
/** key -> when its render last failed, so a broken TTS is not retried on every call. */
const failedAt = new Map();
export const GREETING_CLIP_RETRY_MS = 10 * 60_000;
const ACTOR = { actor: { type: "system", id: "greeting-clip" } };

/**
 * Make (or remake) every clip this business needs in this language, skipping
 * those already current. Single-flight per business + language + WHAT IS BEING
 * RENDERED (the specs' hashes): a request for new settings never joins a render
 * still running for the old ones (Opus review). A failed render is not retried
 * for GREETING_CLIP_RETRY_MS; any settings change is a new key and goes at once.
 * @returns {Promise<string[]>} the variants rendered
 */
export async function ensureGreetingClips({ database, businessId, config, languageCode, liveVoice, synthesize, log, now = Date.now }) {
  const variants = config?._hasCustomGreeting ? ["custom"] : TOD_VARIANTS;
  const specs = variants.map((variant) => greetingClipSpec(config, { languageCode, liveVoice, variant }));
  const key = `${businessId}|${languageCode}|${specs.map((s) => s.hash).join(",")}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const last = failedAt.get(key);
  if (last !== undefined && now() - last < GREETING_CLIP_RETRY_MS) {
    throw new Error("greeting clip render failed recently; retrying later");
  }
  const run = (async () => {
    const made = [];
    for (const spec of specs) {
      const { variant } = spec;
      // withTenant, not withTenantSafe: a write that failed must throw, never
      // read as a clip that was stored.
      const row = await database.withTenant(businessId, () => database.fetchGreetingClip(businessId, variant, languageCode), ACTOR);
      if (row?.input_hash === spec.hash && row?.audio?.length) continue;
      const audio = await synthesize(spec.ssml, spec.ttsVoice);
      if (!audio?.length) throw new Error(`empty render for ${variant}`);
      await database.withTenant(
        businessId,
        () =>
          database.upsertGreetingClip({
            businessId,
            variant,
            languageCode,
            inputHash: spec.hash,
            spokenText: spec.spokenText,
            voiceName: spec.ttsVoice,
            audio,
          }),
        ACTOR
      );
      made.push(variant);
    }
    if (made.length) log?.info?.("greeting_clip_rendered", { businessId, languageCode, variants: made });
    failedAt.delete(key);
    return made;
  })()
    .catch((err) => {
      for (const [k, t] of failedAt) if (now() - t >= GREETING_CLIP_RETRY_MS) failedAt.delete(k);
      failedAt.set(key, now());
      throw err;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * At pickup: the clip for this call, or null (the AI greets as before). A miss
 * starts a background remake; it never delays the call.
 * @returns {Promise<{audio: Buffer, spokenText: string, writtenText: string, variant: string}|null>}
 */
export async function loadGreetingClip({
  database,
  businessId,
  config,
  languageCode,
  liveVoice,
  now = new Date(),
  timeoutMs = GREETING_CLIP_LOAD_TIMEOUT_MS,
  synthesize,
  log,
  callSid,
}) {
  if (!businessId || !languageCode || !liveVoice) return null;
  const variant = greetingVariant(config, now);
  const spec = greetingClipSpec(config, { languageCode, liveVoice, variant });
  let row = null;
  let reason = "missing";
  let timer = null;
  try {
    row = await Promise.race([
      database.withTenantSafe(businessId, () => database.fetchGreetingClip(businessId, variant, languageCode), {
        operation: "fetchGreetingClip",
        callSid,
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (row === TIMED_OUT) {
      row = null;
      reason = "timeout";
    }
  } catch (err) {
    clearTimeout(timer);
    reason = "read_failed";
    log?.error?.("greeting_clip_read_failed", { callSid, reason: err?.message, severity: "warn" });
  }
  if (row && row.input_hash === spec.hash && row.audio?.length) {
    log?.info?.("greeting_clip", { callSid, used: true, variant, voice: spec.ttsVoice });
    return { audio: Buffer.from(row.audio), spokenText: spec.spokenText, writtenText: spec.writtenText, variant };
  }
  if (row) reason = "stale";
  log?.info?.("greeting_clip", { callSid, used: false, variant, reason });
  if (synthesize && reason !== "timeout" && reason !== "read_failed") {
    ensureGreetingClips({ database, businessId, config, languageCode, liveVoice, synthesize, log }).catch((err) =>
      log?.error?.("greeting_clip_render_failed", { callSid, businessId, reason: err?.message, severity: "warn" })
    );
  }
  return null;
}

const TIMED_OUT = Symbol("timed-out");
