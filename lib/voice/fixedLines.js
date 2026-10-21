// ---------------------------------------------------------------------------
// LVX174 (pronunciation build, Step 4, 2026-10-20): the fixed lines Twilio
// plays where the AI cannot speak -- CALL_LINES in lib/twiml.js (AI won't
// start or dropped, the 10-minute end, a transfer that can't happen, nobody
// answered a transfer) -- in the receptionist's own voice instead of Polly.
//
// Google TTS in the Chirp 3 HD voice with the same name as the business's live
// voice: the owner's pick by ear over a Live take and over Polly. The lines are
// generic (no business, no caller), so one clip per line, voice and language is
// shared by every business, stored once (fixed_line_clips, migration 057) and
// served by its content hash at GET /media/line/<hash>.wav for Twilio's <Play>.
//
// NOTHING ON AN ENDING WAITS FOR THIS. The endings are time-critical (the hard
// end races Google's 9:49 cut), so urlFor() is synchronous and memory-only:
// each call prepares its five clips in the background at pickup, and an ending
// that finds no clip ready says the line in Polly exactly as before.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { CALL_LINES } from "../twiml.js";
import { toSsml } from "./pronunciation.js";

export const FIXED_LINE_VERSION = 1;
export const FIXED_LINE_KEYS = Object.freeze(Object.keys(CALL_LINES));
export const FIXED_LINE_PATH_RE = /^\/media\/line\/([0-9a-f]{32})\.wav$/;
const HASH = /^[0-9a-f]{32}$/;

/** On only when FIXED_LINE_CLIPS=on (default off until verified on a live call). */
export function fixedLineClipsEnabled(env = process.env) {
  return String(env?.FIXED_LINE_CLIPS || "").trim().toLowerCase() === "on";
}

/**
 * @param {string} key - a CALL_LINES key
 * @param {{languageCode: string, liveVoice: string}} v
 */
export function lineClipSpec(key, { languageCode, liveVoice }) {
  const text = CALL_LINES[key];
  const ttsVoice = `${languageCode}-Chirp3-HD-${liveVoice}`;
  const ssml = toSsml(text, {});
  const hash = createHash("sha256")
    .update(JSON.stringify({ v: FIXED_LINE_VERSION, key, ttsVoice, ssml }))
    .digest("hex")
    .slice(0, 32);
  return { key, text, ttsVoice, ssml, hash };
}

/**
 * One per process (server.js), shared by the Live sessions and the media route.
 * @param {{database: object, synthesize: Function, baseUrl: string, log?: object, enabled?: boolean}} o
 */
export function createFixedLineClips({ database, synthesize, baseUrl, log, enabled = true }) {
  /** hash -> mu-law Buffer, for every clip known to exist. */
  const audio = new Map();
  /** "lang|voice" -> Promise, so concurrent calls share one prepare. */
  const preparing = new Map();
  /** hash -> when its render last failed: a broken TTS is not retried on every call. */
  const failedAt = new Map();
  const RETRY_MS = 10 * 60_000;
  const base = String(baseUrl || "").replace(/\/$/, "");

  async function prepare(v) {
    if (!enabled || !v?.languageCode || !v?.liveVoice) return;
    const k = `${v.languageCode}|${v.liveVoice}`;
    if (preparing.has(k)) return preparing.get(k);
    const run = (async () => {
      const specs = FIXED_LINE_KEYS.map((key) => lineClipSpec(key, v));
      const missing = specs.filter((s) => !audio.has(s.hash));
      if (!missing.length) return;
      const rows = await database.fetchFixedLineClips(missing.map((s) => s.hash));
      for (const r of rows) if (r?.audio?.length) audio.set(r.hash, Buffer.from(r.audio));
      for (const s of missing) {
        if (audio.has(s.hash)) continue;
        const last = failedAt.get(s.hash);
        if (last !== undefined && Date.now() - last < RETRY_MS) continue;
        try {
          const clip = await synthesize(s.ssml, s.ttsVoice);
          if (!clip?.length) throw new Error("empty render");
          await database.upsertFixedLineClip({ hash: s.hash, lineKey: s.key, voiceName: s.ttsVoice, audio: clip });
          audio.set(s.hash, clip);
          log?.info?.("fixed_line_clip_rendered", { line: s.key, voice: s.ttsVoice });
        } catch (err) {
          failedAt.set(s.hash, Date.now());
          log?.error?.("fixed_line_clip_render_failed", { line: s.key, voice: s.ttsVoice, reason: err?.message, severity: "warn" });
        }
      }
    })()
      .catch((err) => log?.error?.("fixed_line_clips_prepare_failed", { reason: err?.message, severity: "warn" }))
      .finally(() => preparing.delete(k));
    preparing.set(k, run);
    return run;
  }

  /** Synchronous and memory-only: a URL when the clip is ready, else null (Polly). */
  function urlFor(key, v) {
    if (!enabled || !base || !v?.languageCode || !v?.liveVoice || !CALL_LINES[key]) return null;
    const { hash } = lineClipSpec(key, v);
    return audio.has(hash) ? `${base}/media/line/${hash}.wav` : null;
  }

  /** For the media route: Twilio may fetch from an instance that never prepared it. */
  async function audioFor(hash) {
    if (typeof hash !== "string" || !HASH.test(hash)) return null;
    if (audio.has(hash)) return audio.get(hash);
    const rows = await database.fetchFixedLineClips([hash]);
    const row = rows.find((r) => r?.hash === hash && r?.audio?.length);
    if (!row) return null;
    const buf = Buffer.from(row.audio);
    audio.set(hash, buf);
    return buf;
  }

  return { prepare, urlFor, audioFor, enabled };
}
