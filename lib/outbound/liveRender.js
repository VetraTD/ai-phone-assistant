// lib/outbound/liveRender.js
/**
 * Render the backstop line and the voicemail as audio, with Gemini Live, in
 * the tenant's own Live voice (spec §9.3 step 1, D6 revised after spike A).
 *
 * One short Live session per line: the system prompt says to speak the user's
 * text exactly, the user turn carries the line, and the 24 kHz PCM the model
 * speaks is downsampled to the 8 kHz mu-law Twilio plays (the same
 * createDownsampler the call itself uses). Spike A: setup ~140 ms warm, first
 * audio 0.54-0.85 s after the request, verbatim 3/3. About $0.002-0.004 per
 * render. These sessions are NOT a call, so nothing else accounts for them:
 * every render logs its own token usage as `outbound_render_usage` (kind,
 * outcome, and the geminiUsage.js buckets) for operators and the Task 15
 * harness to price.
 *
 * VERIFIED, NOT TRUSTED. The backstop must say the AI disclosure and the
 * business name verbatim (spec §7, G3), and a clip is a thing the person hears
 * with no chance to correct it afterwards. So Live's own output transcript is
 * compared with the line, and a clip is REFUSED when
 *   - fewer than 90% of the line's words were said (spike A measured 1.0), or
 *   - the transcript runs more than 15% longer than the line -- "Sure! Here
 *     you go. <line> Let me know…" contains every word and is not the line, or
 *   - the line carries the §7 disclosure and the transcript does not -- the
 *     overlap alone lets "an assistant" through for "an AI assistant" (11/12).
 * A refused, failed or timed-out line is null for that key: the call then
 * takes the prompt path (outbound_backstop_missing) or skips the voicemail.
 *
 * EACH LINE IS HANDED OVER AS SOON AS IT IS VERIFIED (`onLine`), so dispatch
 * stores the opener without waiting for a longer voicemail render: the session
 * reads the clip when the person answers, which can be seconds into the ring.
 *
 * BOUNDED. Each render has a hard timeout (RENDER_TIMEOUT_MS): dispatch awaits
 * this while the phone rings, and a hung Live session must not hold it.
 */
import { connectLive } from "../voice/live/client.js";
import { createDownsampler } from "../voice/resample.js";
import { emptyUsage, addUsage } from "../voice/geminiUsage.js";
import { log as defaultLog } from "../logger.js";

/**
 * Per line, from connect to turnComplete. The opener is at most 120
 * characters (~6 s of speech) and the voicemail at most 300 (~18-20 s); Live
 * streams audio at or faster than real time, so 20 s covers the voicemail at
 * real-time pace with the ~1 s setup and first-audio lag on top, and still
 * returns well inside the 25-40 s ring. Lines render in parallel, so this is
 * also the whole render's worst case.
 */
export const RENDER_TIMEOUT_MS = 20_000;

/** Spike A measured 1.0 on 3/3; below this a clip is refused. */
export const RENDER_MIN_OVERLAP = 0.9;

/** Transcript words per line word above which a clip is refused: it said more than the line (M1). */
export const RENDER_MAX_WORD_RATIO = 1.15;

export const RENDER_SYSTEM_PROMPT = "Speak the user's text exactly, nothing else.";

/** The §7 disclosure (campaignSchema.js AI_DISCLOSURE_RE), over normalised text. */
const DISCLOSURE_NORMALISED_RE = /\b(ai|artificial intelligence|automated assistant|virtual assistant)\b/;

/**
 * Lower-case words, as a transcript and a template can both be compared:
 * "A.I." -> "ai", "It's" -> "its", punctuation dropped, and a run of digit
 * groups ("01372 656 055") joined into one token so a transcript that writes
 * the number without spaces still matches.
 */
function words(text) {
  const cleaned = String(text || "")
    .toLowerCase()
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, "$1")
    .replace(/\b([a-z])\.(?=\s|$)/g, "$1")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const joined = [];
  for (const t of tokens) {
    const prev = joined[joined.length - 1];
    if (/^\d+$/.test(t) && prev !== undefined && /^\d+$/.test(prev)) joined[joined.length - 1] = prev + t;
    else joined.push(t);
  }
  return joined;
}

/**
 * The share of the line's words the transcript contains (a multiset match,
 * so a repeated word must be said as often as it is written).
 * @returns {number} 0..1
 */
export function wordOverlap(line, transcript) {
  const want = words(line);
  if (want.length === 0) return 0;
  const have = new Map();
  for (const w of words(transcript)) have.set(w, (have.get(w) || 0) + 1);
  let hit = 0;
  for (const w of want) {
    const n = have.get(w) || 0;
    if (n > 0) {
      hit += 1;
      have.set(w, n - 1);
    }
  }
  return hit / want.length;
}

/** Does the transcript keep the line's disclosure? Vacuously true when the line has none. */
function disclosureKept(line, transcript) {
  const lineHas = DISCLOSURE_NORMALISED_RE.test(words(line).join(" "));
  return !lineHas || DISCLOSURE_NORMALISED_RE.test(words(transcript).join(" "));
}

/** The transcript's word count over the line's. */
export function wordRatio(line, transcript) {
  const want = words(line).length;
  return want === 0 ? Infinity : words(transcript).length / want;
}

/**
 * One line through one short Live session. Resolves, never rejects.
 * @returns {Promise<{audio: Buffer|null, transcript: string, reason: string, usage: object}>}
 */
function renderOne(line, { voiceName, languageCode, connect, env, model, timeoutMs }) {
  return new Promise((resolve) => {
    const downsampler = createDownsampler();
    const chunks = [];
    let transcript = "";
    let session = null;
    let done = false;
    // Gemini sends one usageMetadata per turn (lib/voice/geminiUsage.js), so it
    // is folded, not overwritten -- and read even after `done`, because the
    // bill for a timed-out render is still a bill.
    let usage = emptyUsage();

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        session?.close?.();
      } catch {
        /* already gone */
      }
      const audio = reason === "complete" ? Buffer.concat(chunks) : null;
      resolve({ audio, transcript, reason, usage });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    const config = {
      responseModalities: ["AUDIO"],
      systemInstruction: { parts: [{ text: RENDER_SYSTEM_PROMPT }] },
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } }, languageCode },
    };

    Promise.resolve()
      .then(() =>
        connect({
          env,
          model,
          config,
          callbacks: {
            onmessage: (msg) => {
              if (msg?.usageMetadata) usage = addUsage(usage, msg.usageMetadata);
              if (done) return;
              const sc = msg?.serverContent;
              if (!sc) return;
              for (const part of sc.modelTurn?.parts || []) {
                if (part.inlineData?.data) chunks.push(downsampler.process(Buffer.from(part.inlineData.data, "base64")));
              }
              if (sc.outputTranscription?.text) transcript += sc.outputTranscription.text;
              if (sc.turnComplete) finish("complete");
            },
            onerror: () => finish("error"),
            onclose: () => finish("closed"),
          },
        })
      )
      .then((connected) => {
        session = connected?.session ?? null;
        if (done) {
          try {
            session?.close?.();
          } catch {
            /* already gone */
          }
          return;
        }
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: `Say exactly: "${line}"` }] }],
          turnComplete: true,
        });
      })
      .catch(() => finish("error"));
  });
}

const REFUSED_EVENT = {
  opener: "outbound_backstop_render_refused",
  voicemail: "outbound_voicemail_render_refused",
};

/**
 * @param {object} args
 * @param {{opener?: string, voicemail?: string}} args.lines - the TEXT, already rendered and budget-checked by dispatch
 * @param {string} args.voiceName - the call's Live voice (resolveLiveVoice, from the BUSINESS)
 * @param {string} args.languageCode - the call's language (resolveLiveLanguage, from the BUSINESS number)
 * @param {Function} [args.connect] - connectLive, injectable
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {string} [args.model]
 * @param {number} [args.timeoutMs]
 * @param {object} [args.log]
 * @param {object} [args.logFields] - ids only, attached to every refusal and usage line
 * @param {(kind: "opener"|"voicemail", audio: Buffer) => (void|Promise<void>)} [args.onLine] -
 *   called with each VERIFIED clip as soon as its own render finishes, before the
 *   other line's; awaited, and a throw from it is logged, never propagated
 * @returns {Promise<{opener?: Buffer|null, voicemail?: Buffer|null}>} a key per line asked for; null when refused
 */
export async function renderLines({
  lines,
  voiceName,
  languageCode,
  connect = connectLive,
  env = process.env,
  model,
  timeoutMs = RENDER_TIMEOUT_MS,
  log = defaultLog,
  logFields = {},
  onLine,
} = {}) {
  const keys = ["opener", "voicemail"].filter((k) => typeof lines?.[k] === "string" && lines[k].trim());

  /** Render, meter, verify, hand over: one line, independently of the other. */
  async function one(key) {
    const line = lines[key];
    const { audio, transcript, reason, usage } = await renderOne(line, { voiceName, languageCode, connect, env, model, timeoutMs });

    let verdict = "accepted";
    let refusal = null;
    const overlap = audio?.length ? wordOverlap(line, transcript) : 0;
    const ratio = audio?.length ? wordRatio(line, transcript) : 0;
    if (!audio || audio.length === 0) {
      verdict = "refused";
      refusal = { reason: reason === "complete" ? "no_audio" : reason };
    } else if (overlap < RENDER_MIN_OVERLAP || ratio > RENDER_MAX_WORD_RATIO || !disclosureKept(line, transcript)) {
      verdict = "refused";
      refusal = { reason: "transcript_mismatch", overlap: Number(overlap.toFixed(3)), word_ratio: Number(ratio.toFixed(3)) };
    }

    // M2: every render is metered, accepted or not -- a refused clip was still billed.
    log.info("outbound_render_usage", { ...logFields, kind: key, outcome: verdict === "accepted" ? "accepted" : refusal.reason, ...usage });

    if (refusal) {
      log.error(REFUSED_EVENT[key], { ...logFields, ...refusal });
      return null;
    }
    if (onLine) {
      try {
        await onLine(key, audio);
      } catch (err) {
        log.error("outbound_backstop_store_refused", { ...logFields, kind: key, error: err?.message });
      }
    }
    return audio;
  }

  const results = await Promise.all(keys.map((k) => one(k)));
  const out = {};
  keys.forEach((key, i) => {
    out[key] = results[i];
  });
  return out;
}

/**
 * Dispatch's `renderAudio` (lib/outbound/dispatch.js): `({row, attemptNo,
 * lines, onClip}) -> {opener, voicemail}`, wired in buildOutboundDeps.
 * `onClip(kind, audio)` is dispatch's store, called as each verified clip is
 * ready (fix round 1, I4): the opener is stored without waiting for the
 * voicemail.
 *
 * Loads the business config the way the call will (the business row plus its
 * capability rows, `loadConfig`), under `withTenant(row.business_id)`, and
 * resolves the voice and language with the BUSINESS number -- the campaign's
 * `caller_id`, never the contact's -- through the same two functions the
 * session uses, so the clip and the live call sound like one voice.
 *
 * A business that cannot be loaded THROWS rather than rendering in a default
 * voice the call would not use; dispatch logs `outbound_backstop_render_failed`
 * and the call takes the prompt path.
 *
 * @param {{db: object, env?: NodeJS.ProcessEnv, connect?: Function, log?: object, render?: Function}} deps
 */
export function createLiveRenderAudio({ db, env = process.env, connect = connectLive, log = defaultLog, render = renderLines }) {
  return async function renderAudio({ row, attemptNo, lines, onClip }) {
    const business = await db.withTenant(
      row.business_id,
      async () => {
        const b = await db.fetchBusinessById(row.business_id);
        if (!b) return null;
        return { ...b, business_capabilities: await db.fetchBusinessCapabilities(row.business_id) };
      },
      { actor: { type: "system", id: "outbound-render" } }
    );
    if (!business) throw new Error("renderAudio: business could not be loaded");
    const config = db.loadConfig(business);

    // Imported on first use: lib/voice/live/index.js is loaded lazily by
    // server.js (only a Live call needs it), and the dispatcher must not pull
    // it in at boot.
    const { resolveLiveLanguage, resolveLiveVoice } = await import("../voice/live/index.js");
    const language = resolveLiveLanguage(config, row.config?.caller_id, env);
    const voice = resolveLiveVoice(config, language.code, env);

    const out = await render({
      lines,
      voiceName: voice.name,
      languageCode: language.code,
      connect,
      env,
      log,
      logFields: { outreachId: row.id, attemptNo },
      onLine: onClip,
    });
    return { opener: out.opener ?? null, voicemail: out.voicemail ?? null };
  };
}
