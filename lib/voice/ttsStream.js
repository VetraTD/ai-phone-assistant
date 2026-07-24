import { createTtsConnection } from "../../services/elevenlabs.js";
import { synthesizeMulaw } from "../../services/googleTts.js";
import { ttsHealth } from "./ttsHealth.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Per-turn TTS orchestration with Google TTS fallback — standalone module for
// the voice-pipeline rewrite. One `createTtsTurn(opts)` instance per AI
// speaking turn.
//
// Wraps the low-level ElevenLabs WS client (services/elevenlabs.js):
//   - forwards streamed LLM text deltas (write) and finalizes the turn (end)
//   - supports barge-in (abort) and stale-turn suppression (epoch check)
//   - if ElevenLabs fails before any audio was produced (connect timeout,
//     auth failure, socket error), falls back to Google TTS
//     (services/googleTts.js synthesizeMulaw), synthesized per sentence, on
//     end(). If ElevenLabs dies mid-turn (after some audio played), the
//     UNSPOKEN remainder of writtenText is repaired rather than dropped: the
//     voiced portion is estimated from the received mulaw byte count (duration
//     heuristic — 1 byte/sample at 8kHz -> seconds -> chars), rounded DOWN to
//     the previous sentence boundary, and the remainder from there is spoken
//     via the same Google fallback path. Slight repetition of a clause is
//     accepted; a sentence stopping dead ("cuts out") is not. onDone reports
//     the truncation plus the text actually voiced (see handleElError).
//   - if the Google fallback also fails, onError(err) is called. write/end/
//     abort never throw.
//   - opts.forceFallback=true skips ElevenLabs entirely (no connection is
//     opened) and routes the whole turn through the Google fallback path
//     from the start — for businesses configured with a non-ElevenLabs
//     voice_provider (see lib/voice/session.js resolveVoice()).
//   - opts.voiceSettings is passed through to services/elevenlabs.js's
//     createTtsConnection (merged over its defaults there).
// ---------------------------------------------------------------------------

/** Split text into trimmed, non-empty sentences for per-sentence fallback synthesis. */
function splitSentences(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  const matches = trimmed.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!matches) return [trimmed];
  return matches.map((s) => s.trim()).filter(Boolean);
}

// ulaw_8000 output is 1 byte per 8kHz sample, so received-byte count maps
// straight to seconds of audio (see the ElevenLabs handshake output_format in
// services/elevenlabs.js).
const MULAW_BYTES_PER_SEC = 8000;
// Rough speaking rate used only to turn "seconds of audio ElevenLabs produced"
// back into "characters of writtenText it had gotten through" when it dies
// mid-turn. Deliberately conservative: the boundary is rounded DOWN to a whole
// sentence afterwards, so a slight under/over-estimate at worst re-speaks one
// already-spoken clause (acceptable) rather than clipping the remainder.
const REPAIR_CHARS_PER_SEC = 15;

/**
 * Given `text` and an estimate of how many leading characters were already
 * voiced, return the index where the UNSPOKEN remainder begins — rounded DOWN
 * to the end of the last complete sentence that finished at or before the
 * estimate (including its trailing whitespace). Rounding down means a sentence
 * caught mid-word is re-spoken in full rather than resumed mid-syllable.
 * @param {string} text
 * @param {number} spokenChars
 * @returns {number} index into `text` where the remainder starts
 */
function remainderBoundary(text, spokenChars) {
  if (spokenChars <= 0) return 0;
  if (spokenChars >= text.length) return text.length;
  let boundary = 0;
  const re = /[.!?]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let end = m.index + m[0].length;
    while (end < text.length && /\s/.test(text[end])) end++;
    if (end <= spokenChars) boundary = end;
    else break;
  }
  return boundary;
}

/**
 * Create a per-turn TTS orchestrator.
 *
 * @param {object} opts
 * @param {string} opts.voiceId - ElevenLabs voice ID
 * @param {string} [opts.callSid] - call identifier, for log correlation and Google TTS fallback
 * @param {*} opts.epoch - this turn's epoch/generation token
 * @param {function} opts.getEpoch - () => current epoch; chunks are suppressed once this diverges from opts.epoch
 * @param {function} opts.onAudioChunk - (buf: Buffer) => void — raw mulaw 8kHz audio, one call per chunk
 * @param {function} [opts.onDone] - ({truncated, spokenText?, repairedFrom?, remainderChars?}) => void — turn fully finished (ElevenLabs isFinal, or fallback complete). `truncated` is true if ElevenLabs errored after some audio had already played. In that case the UNSPOKEN remainder of writtenText is estimated (duration heuristic — see handleElError) and resynthesized via the Google fallback instead of being dropped, and the payload additionally carries `repairedFrom` (the boundary method, currently always "duration"), `remainderChars` (length of the resynthesized remainder), and `spokenText` (the text actually covered by audio this turn — the voiced prefix plus whatever of the repaired remainder was emitted before any barge). Callers use `spokenText` as the accurate prosody anchor when truncated, since the full writtenText may not all have been heard.
 * @param {function} [opts.onError] - (err: Error) => void — both ElevenLabs and the Google fallback failed
 * @param {function} [opts.onFirstAudio] - () => void — fired once, on the first audio chunk of the turn
 * @param {object} [opts.voiceSettings] - merged over elevenlabs.js's defaults, sent in the ElevenLabs handshake (e.g. a catalog entry's {stability, similarity_boost} — see config/voices.js). Ignored when forceFallback is set.
 * @param {string} [opts.previousText] - the text the PREVIOUS turn actually spoke; passed to the ElevenLabs handshake as `previous_text` so this turn's prosody continues from it instead of resetting (each turn is its own socket). Trimmed to a safe length in elevenlabs.js. Ignored when forceFallback is set (Google fallback has no equivalent).
 * @param {boolean} [opts.forceFallback=false] - skip ElevenLabs entirely and speak this turn via the Google TTS fallback path from the start (e.g. a business configured with voice_provider="google" — see lib/voice/session.js resolveVoice()). No ElevenLabs connection is opened at all.
 * @param {string} [opts.googleFallbackVoice="en-US-Chirp3-HD-Aoede"]
 * @returns {{write: function(string): void, end: function(): void, abort: function(): void, getStatus: function(): {truncated: boolean, elErrored: boolean, doneFired: boolean}}}
 */
export function createTtsTurn({
  voiceId,
  callSid,
  epoch,
  getEpoch,
  onAudioChunk,
  onDone,
  onError,
  onFirstAudio,
  voiceSettings,
  previousText,
  forceFallback = false,
  googleFallbackVoice = "en-US-Chirp3-HD-Aoede",
} = {}) {
  // Circuit breaker: when ElevenLabs recently failed (credits exhausted,
  // outage), skip it entirely instead of paying the connect timeout on every
  // turn before falling back (see lib/voice/ttsHealth.js).
  if (!forceFallback && !ttsHealth.isHealthy()) {
    log.info("tts_el_skipped_breaker_open", { callSid });
    forceFallback = true;
  }

  let aborted = false;
  let ended = false;
  let doneFired = false;
  let firstAudioFired = false;
  let audioReceived = false; // any audio produced by ElevenLabs this turn
  // ElevenLabs connection has failed (or forceFallback skipped it entirely) —
  // fallback mode engaged from the start in the forceFallback case.
  let elErrored = forceFallback;
  let writtenText = ""; // all text written so far (used if EL fails before any audio)
  let fallbackText = ""; // text pending Google synthesis (the unspoken remainder once EL fails after audio played)
  let pendingEnd = false; // end() has been called; waiting on isFinal or running fallback
  let audioBytes = 0; // total mulaw bytes received from ElevenLabs this turn — the input to the mid-turn repair boundary estimate
  // Set only on a mid-turn repair (EL died after audio): the voiced prefix of
  // writtenText (up to the estimated sentence boundary), plus the boundary
  // method and remainder length, for the onDone payload / logs.
  let coveredPrefix = "";
  let repairedFrom = null;
  let remainderChars = 0;
  // Accumulates the fallback sentences actually EMITTED (not merely queued) so
  // onDone can report exactly what the caller heard — a barge mid-repair stops
  // emission partway, and the anchor must not claim the unspoken tail.
  let emittedFallbackText = "";
  // True once ElevenLabs errors after some audio had already played (most
  // notably: after end() was called, mid-flush, waiting on isFinal). In
  // that branch we deliberately don't resynthesize whatever was still
  // in-flight to ElevenLabs (see module docstring) — the turn still
  // completes via onDone(), but truncated, with no other signal that
  // happened. Exposed on the onDone payload so callers (session.js) can at
  // least log it instead of the turn silently looking normal.
  let truncated = false;

  function isSuppressed() {
    return aborted || (typeof getEpoch === "function" && getEpoch() !== epoch);
  }

  function emitAudioChunk(buf) {
    if (isSuppressed()) return;
    if (!firstAudioFired) {
      firstAudioFired = true;
      try {
        onFirstAudio?.();
      } catch (err) {
        log.error("tts_turn_first_audio_handler_error", { callSid, reason: err?.message });
      }
    }
    try {
      onAudioChunk?.(buf);
    } catch (err) {
      log.error("tts_turn_chunk_handler_error", { callSid, reason: err?.message });
    }
  }

  function finishDone() {
    if (doneFired) return;
    doneFired = true;
    const payload = { truncated };
    if (truncated) {
      // The prosody anchor must reflect only what was actually voiced: the
      // ElevenLabs-voiced prefix plus whatever repaired remainder made it out
      // before any barge cut emission short.
      payload.spokenText = coveredPrefix + emittedFallbackText;
      payload.repairedFrom = repairedFrom;
      payload.remainderChars = remainderChars;
    }
    try {
      onDone?.(payload);
    } catch (err) {
      log.error("tts_turn_done_handler_error", { callSid, reason: err?.message });
    }
  }

  /** @returns {{truncated: boolean, elErrored: boolean, doneFired: boolean}} */
  function getStatus() {
    return { truncated, elErrored, doneFired };
  }

  function fireError(err) {
    try {
      onError?.(err);
    } catch (handlerErr) {
      log.error("tts_turn_error_handler_error", { callSid, reason: handlerErr?.message });
    }
  }

  // How many Google synth requests run concurrently during fallback. Audio
  // is still EMITTED strictly in sentence order — parallelism only overlaps
  // the synthesis round-trips, so a multi-sentence fallback reply costs
  // ~max(latency) instead of sum(latency).
  const FALLBACK_SYNTH_CONCURRENCY = 3;

  async function runFallback() {
    const sentences = splitSentences(fallbackText);
    fallbackText = "";

    if (sentences.length === 0) {
      finishDone();
      return;
    }

    log.info("tts_fallback", { callSid, sentences: sentences.length, voice: googleFallbackVoice });

    // Per-sentence deferreds resolved by a small worker pool. Each promise
    // gets a no-op catch attached AT CREATION: a sentence can reject while
    // the in-order consumer below is still awaiting an earlier one, and an
    // unobserved rejection would crash the whole process (Node's default
    // --unhandled-rejections=throw), killing every live call.
    const deferreds = sentences.map(() => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      promise.catch(() => {});
      return { promise, resolve, reject };
    });
    let nextIdx = 0;
    const worker = async () => {
      // Stop synthesizing once the turn is suppressed (barge-in / stale
      // epoch) — nobody will hear the remaining sentences.
      while (nextIdx < sentences.length && !isSuppressed()) {
        const i = nextIdx++;
        try {
          deferreds[i].resolve(await synthesizeMulaw(sentences[i], googleFallbackVoice, callSid));
        } catch (err) {
          deferreds[i].reject(err);
        }
      }
      // Settle anything the pool never picked up so the consumer can't hang.
      while (nextIdx < sentences.length) {
        deferreds[nextIdx++].resolve(null);
      }
    };
    for (let k = 0; k < Math.min(FALLBACK_SYNTH_CONCURRENCY, sentences.length); k++) worker();

    try {
      for (let i = 0; i < deferreds.length; i++) {
        const buf = await deferreds[i].promise;
        // Once suppressed, stop emitting (workers have also stopped).
        if (isSuppressed() || !buf) continue;
        emitAudioChunk(buf);
        // Record what actually went out, so a mid-repair barge leaves an
        // accurate spokenText anchor (see finishDone).
        emittedFallbackText += (emittedFallbackText ? " " : "") + sentences[i];
      }
      finishDone();
    } catch (err) {
      log.error("tts_fallback_error", { callSid, reason: err?.message });
      fireError(err);
    }
  }

  function handleElError(err) {
    if (elErrored) return; // already in fallback mode
    elErrored = true;
    ttsHealth.recordFailure(err);
    log.error("tts_el_turn_error", { callSid, code: err?.code, reason: err?.message });

    if (aborted) return; // intentional teardown — no fallback needed

    if (!audioReceived) {
      // Nothing voiced yet: clean fallback for everything written so far.
      fallbackText = writtenText;
    } else {
      // Some audio already played, then the socket died with text still in
      // flight to ElevenLabs (never confirmed via isFinal — e.g. dying right
      // after end()). Rather than dropping that in-flight text (a sentence
      // stopping dead — the "cuts out" complaint), estimate how far
      // ElevenLabs got from the mulaw bytes it delivered, round DOWN to a
      // sentence boundary, and resynthesize the UNSPOKEN remainder via the
      // Google fallback. Still a real truncation of the ElevenLabs stream, so
      // keep the flag for observability — but now repaired, not silent.
      truncated = true;
      repairedFrom = "duration";
      const spokenSecs = audioBytes / MULAW_BYTES_PER_SEC;
      const spokenChars = Math.max(
        0,
        Math.min(writtenText.length, Math.floor(spokenSecs * REPAIR_CHARS_PER_SEC))
      );
      const boundary = remainderBoundary(writtenText, spokenChars);
      coveredPrefix = writtenText.slice(0, boundary);
      const remainder = writtenText.slice(boundary);
      remainderChars = remainder.length;
      fallbackText = remainder;
      log.info("tts_mid_turn_repair", {
        callSid,
        method: repairedFrom,
        audioBytes,
        spokenChars,
        boundary,
        remainderChars,
      });
    }

    if (pendingEnd) {
      runFallback();
    }
  }

  // forceFallback: skip opening an ElevenLabs connection at all — this turn
  // is Google-only from the start (elErrored is already true, above), so
  // write()/end() route straight into fallbackText/runFallback() below and
  // `conn` is never referenced.
  const conn = forceFallback
    ? null
    : createTtsConnection({
        voiceId,
        voiceSettings,
        previousText,
        onAudio: (buf) => {
          if (!audioReceived) ttsHealth.recordSuccess();
          audioReceived = true;
          audioBytes += buf?.length || 0;
          emitAudioChunk(buf);
        },
        onFinal: () => {
          if (pendingEnd && !elErrored) {
            finishDone();
            // One connection per turn — release the socket once ElevenLabs
            // confirms it has finished generating (idempotent; see close()).
            conn.close();
          }
        },
        onError: handleElError,
      });

  function write(textDelta) {
    if (aborted || ended || !textDelta) return;
    writtenText += textDelta;
    if (elErrored) {
      fallbackText += textDelta;
      return;
    }
    conn.sendText(textDelta);
  }

  function end() {
    if (aborted || ended) return;
    ended = true;
    pendingEnd = true;

    if (elErrored) {
      runFallback();
      return;
    }

    conn.flush();
    // onDone fires from conn's onFinal handler above once ElevenLabs
    // confirms {"isFinal":true}, or from handleElError -> runFallback if the
    // connection fails while we're waiting.
  }

  function abort() {
    if (aborted) return;
    aborted = true;
    ended = true;
    conn?.close();
  }

  return { write, end, abort, getStatus };
}
