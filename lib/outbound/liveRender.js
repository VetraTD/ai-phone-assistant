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
 * H1 (2026-09-26 paid run): the transcript is Gemini's own, and it sometimes
 * glues two of the line's words together with no space ("isthat", "AI
 * assistant" -> "AIassistant") even when every word was spoken correctly. A
 * transcript token that is not itself one of the line's words is re-split
 * into a run of the line's OWN words when it can be fully segmented that way
 * and only then, before overlap, ratio and the disclosure check all see it
 * (one shared path, `words(text, vocab)`) -- so this can only ever recover
 * words the line already contains, never let a wrong word through.
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
import { foldDottedAI } from "./campaignSchema.js";
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

/**
 * h2 (checkpoint 2b review, paid-run evidence). Live's own `turnComplete`
 * says generation finished, not that `outputTranscription` has arrived --
 * session 2c, speaks-first #4, produced 172 audio-out tokens (first audio
 * 1,013 ms) with turnComplete carrying an EMPTY transcription, refused as
 * transcript_mismatch overlap 0. This is how long renderOne keeps listening
 * for trailing outputTranscription once turnComplete has already fired and
 * the transcript so far does not yet cover the line -- bounded, so a
 * transcript that never arrives still resolves (refused, correctly, by the
 * unchanged verification in `one()`) rather than holding the render open.
 */
export const RENDER_TRANSCRIPT_GRACE_MS = 1500;

/** The §7 disclosure (campaignSchema.js AI_DISCLOSURE_RE), over normalised text. */
const DISCLOSURE_NORMALISED_RE = /\b(ai|artificial intelligence|automated assistant|virtual assistant)\b/;

/**
 * Lower-case words, as a transcript and a template can both be compared:
 * "A.I." -> "ai", "It's" -> "its", punctuation dropped, and a run of digit
 * groups ("01372 656 055") joined into one token so a transcript that writes
 * the number without spaces still matches.
 *
 * H1 (2026-09-26 paid run): Gemini's output transcription sometimes glues two
 * of the line's words together with no space ("isthat", "It'sAva",
 * "AIassistant") -- the clip was right, only the transcript's spacing was
 * wrong. When `vocab` is given (the LINE's own words, as a Set), a token that
 * is not itself in `vocab` is re-split into a run of `vocab` words when --
 * and only when -- it can be fully segmented that way, with nothing left
 * over (a small word-break DP over `vocab`, which is one line's own words, so
 * it stays cheap). A token that cannot be fully segmented is left as-is. This
 * can only ever produce words the line itself contains, in the letters
 * actually spoken, so it can never turn a wrong render into an accepted one.
 */
/**
 * Exported for lib/outbound/firstSeconds.js's own disclosure check (M3,
 * checkpoint 2b review): the Live session's own transcript glues words the
 * same way a render's does, and this is the one shared implementation --
 * firstSeconds.js builds its own vocab (the disclosure words plus the
 * business name's) rather than copying this function.
 */
export function words(text, vocab) {
  // The shared dotted-AI fold first (campaignSchema.js), so "A. I." counts as
  // the disclosure here exactly as it does in the session's first-turn check.
  const cleaned = foldDottedAI(text || "")
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
  if (!vocab) return joined;
  const resplit = [];
  for (const t of joined) {
    if (vocab.has(t)) {
      resplit.push(t);
      continue;
    }
    const segmented = segmentFromVocab(t, vocab);
    if (segmented) resplit.push(...segmented);
    else resplit.push(t);
  }
  return resplit;
}

/**
 * `token` fully partitioned into words from `vocab` (a Set), or null when no
 * such partition exists. Standard word-break DP: for each end position, try
 * every start whose prefix is already reachable and whose piece is itself a
 * vocab word: any valid split ending at a position is as good as any other,
 * since every piece is a real word from the line, so the loop stops at the
 * first one found.
 * @returns {string[]|null}
 */
function segmentFromVocab(token, vocab) {
  const n = token.length;
  const reach = new Array(n + 1).fill(null);
  reach[0] = [];
  for (let end = 1; end <= n; end++) {
    for (let start = 0; start < end; start++) {
      if (reach[start] === null) continue;
      const piece = token.slice(start, end);
      if (vocab.has(piece)) {
        reach[end] = [...reach[start], piece];
        break;
      }
    }
  }
  return reach[n];
}

/**
 * The share of the line's words the transcript contains (a multiset match,
 * so a repeated word must be said as often as it is written). Glued
 * transcript tokens are re-split against the line's own vocabulary first (H1).
 * @returns {number} 0..1
 */
export function wordOverlap(line, transcript) {
  const want = words(line);
  if (want.length === 0) return 0;
  const vocab = new Set(want);
  const have = new Map();
  for (const w of words(transcript, vocab)) have.set(w, (have.get(w) || 0) + 1);
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
  const lineWords = words(line);
  const lineHas = DISCLOSURE_NORMALISED_RE.test(lineWords.join(" "));
  if (!lineHas) return true;
  return DISCLOSURE_NORMALISED_RE.test(words(transcript, new Set(lineWords)).join(" "));
}

/** The transcript's word count over the line's. Glued tokens re-split first (H1). */
export function wordRatio(line, transcript) {
  const lineWords = words(line);
  const want = lineWords.length;
  return want === 0 ? Infinity : words(transcript, new Set(lineWords)).length / want;
}

/**
 * h2's own question, asked of a transcript so far: would `one()`'s
 * verification (below) ACCEPT this line/transcript pair right now? The three
 * tests are exactly `one()`'s three refusal conditions, inverted -- one
 * shared implementation, so renderOne's "stop waiting" decision can never
 * drift from what actually gets accepted.
 * @returns {boolean}
 */
function transcriptCoversLine(line, transcript) {
  return (
    wordOverlap(line, transcript) >= RENDER_MIN_OVERLAP &&
    wordRatio(line, transcript) <= RENDER_MAX_WORD_RATIO &&
    disclosureKept(line, transcript)
  );
}

/**
 * One line through one short Live session. Resolves, never rejects.
 * @returns {Promise<{audio: Buffer|null, transcript: string, reason: string, usage: object}>}
 */
function renderOne(line, { voiceName, languageCode, connect, env, model, timeoutMs, graceMs = RENDER_TRANSCRIPT_GRACE_MS }) {
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
    // h2: turnComplete has fired (generation is done) but the transcript so
    // far does not yet cover the line -- audio after this point is dropped
    // (the reply is already fully captured), and `graceTimer` is the bound on
    // how long trailing outputTranscription is still awaited.
    let turnCompleted = false;
    let graceTimer = null;

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
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
              // Audio after turnComplete is not appended: generation is over,
              // so any further modelTurn part is not more of this line.
              if (!turnCompleted) {
                for (const part of sc.modelTurn?.parts || []) {
                  if (part.inlineData?.data) chunks.push(downsampler.process(Buffer.from(part.inlineData.data, "base64")));
                }
              }
              if (sc.outputTranscription?.text) {
                transcript += sc.outputTranscription.text;
                // Trailing transcription, arrived during the grace window:
                // finish as soon as it covers the line rather than waiting
                // out the rest of the grace for nothing.
                if (turnCompleted && transcriptCoversLine(line, transcript)) finish("complete");
              }
              if (sc.turnComplete && !turnCompleted) {
                turnCompleted = true;
                if (transcriptCoversLine(line, transcript)) {
                  // Covered already: no added delay.
                  finish("complete");
                } else {
                  graceTimer = setTimeout(() => finish("complete"), graceMs);
                }
              }
            },
            // Once turnComplete has fired, the audio is already fully
            // captured -- a close or an error arriving during the grace
            // window (the vendor tearing the session down right after
            // generating) must not discard it by resolving with a reason
            // other than "complete"; only the still-incomplete transcript is
            // lost, and the unchanged verification in `one()` fails that
            // closed exactly as a transcript that never arrived at all would.
            onerror: () => finish(turnCompleted ? "complete" : "error"),
            onclose: () => finish(turnCompleted ? "complete" : "closed"),
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
  // S3-4 (D6): the fixed transfer-miss line goes through the SAME verified-
  // not-trusted pipeline as the opener/voicemail -- a refused render just
  // means the door falls back to today's <Say> (doorRoutes.js), never a
  // wrong or unverified clip played to the caller.
  transfer_miss: "outbound_transfer_miss_render_refused",
};

/**
 * @param {object} args
 * @param {{opener?: string, voicemail?: string, transfer_miss?: string}} args.lines - the TEXT, already rendered and budget-checked by dispatch
 * @param {string} args.voiceName - the call's Live voice (resolveLiveVoice, from the BUSINESS)
 * @param {string} args.languageCode - the call's language (resolveLiveLanguage, from the BUSINESS number)
 * @param {Function} [args.connect] - connectLive, injectable
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {string} [args.model]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.graceMs] - h2: how long renderOne keeps listening for trailing outputTranscription after turnComplete
 * @param {object} [args.log]
 * @param {object} [args.logFields] - ids only, attached to every refusal and usage line
 * @param {(kind: "opener"|"voicemail"|"transfer_miss", audio: Buffer) => (void|Promise<void>)} [args.onLine] -
 *   called with each VERIFIED clip as soon as its own render finishes, before the
 *   other line's; awaited, and a throw from it is logged, never propagated
 * @returns {Promise<{opener?: Buffer|null, voicemail?: Buffer|null, transfer_miss?: Buffer|null}>} a key per line asked for; null when refused
 */
export async function renderLines({
  lines,
  voiceName,
  languageCode,
  connect = connectLive,
  env = process.env,
  model,
  timeoutMs = RENDER_TIMEOUT_MS,
  graceMs = RENDER_TRANSCRIPT_GRACE_MS,
  log = defaultLog,
  logFields = {},
  onLine,
} = {}) {
  // S3-4: transfer_miss is a THIRD, independent line -- the campaign's own
  // capabilities list gates whether dispatch asks for it at all (never its
  // own budget check: the text is fixed, not templated per tenant).
  const keys = ["opener", "voicemail", "transfer_miss"].filter((k) => typeof lines?.[k] === "string" && lines[k].trim());

  /** Render, meter, verify, hand over: one line, independently of the other. */
  async function one(key) {
    const line = lines[key];
    const { audio, transcript, reason, usage } = await renderOne(line, { voiceName, languageCode, connect, env, model, timeoutMs, graceMs });

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
    // S3-6: the campaign's own `language`, when set, so the pre-rendered
    // clip and the live session (lib/voice/live/index.js) resolve to the
    // same language the same way.
    const language = resolveLiveLanguage(config, row.config?.caller_id, env, row.config?.language);
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
    return { opener: out.opener ?? null, voicemail: out.voicemail ?? null, transfer_miss: out.transfer_miss ?? null };
  };
}
