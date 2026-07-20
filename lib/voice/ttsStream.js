import { createTtsConnection } from "../../services/elevenlabs.js";
import { synthesizeMulaw } from "../../services/googleTts.js";
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
//     end(). If ElevenLabs dies mid-turn (after some audio played), fallback
//     covers only text written after the failure — text already flushed to
//     ElevenLabs before the error is not resent (acceptable simplification;
//     tracking exactly what was already spoken vs. buffered is impractical
//     at this layer).
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

/**
 * Create a per-turn TTS orchestrator.
 *
 * @param {object} opts
 * @param {string} opts.voiceId - ElevenLabs voice ID
 * @param {string} [opts.callSid] - call identifier, for log correlation and Google TTS fallback
 * @param {*} opts.epoch - this turn's epoch/generation token
 * @param {function} opts.getEpoch - () => current epoch; chunks are suppressed once this diverges from opts.epoch
 * @param {function} opts.onAudioChunk - (buf: Buffer) => void — raw mulaw 8kHz audio, one call per chunk
 * @param {function} [opts.onDone] - () => void — turn fully finished (ElevenLabs isFinal, or fallback complete)
 * @param {function} [opts.onError] - (err: Error) => void — both ElevenLabs and the Google fallback failed
 * @param {function} [opts.onFirstAudio] - () => void — fired once, on the first audio chunk of the turn
 * @param {object} [opts.voiceSettings] - merged over elevenlabs.js's defaults, sent in the ElevenLabs handshake (e.g. a catalog entry's {stability, similarity_boost} — see config/voices.js). Ignored when forceFallback is set.
 * @param {boolean} [opts.forceFallback=false] - skip ElevenLabs entirely and speak this turn via the Google TTS fallback path from the start (e.g. a business configured with voice_provider="google" — see lib/voice/session.js resolveVoice()). No ElevenLabs connection is opened at all.
 * @param {string} [opts.googleFallbackVoice="en-GB-Chirp3-HD-Aoede"]
 * @returns {{write: function(string): void, end: function(): void, abort: function(): void}}
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
  forceFallback = false,
  googleFallbackVoice = "en-GB-Chirp3-HD-Aoede",
} = {}) {
  let aborted = false;
  let ended = false;
  let doneFired = false;
  let firstAudioFired = false;
  let audioReceived = false; // any audio produced by ElevenLabs this turn
  // ElevenLabs connection has failed (or forceFallback skipped it entirely) —
  // fallback mode engaged from the start in the forceFallback case.
  let elErrored = forceFallback;
  let writtenText = ""; // all text written so far (used if EL fails before any audio)
  let fallbackText = ""; // text pending Google synthesis (reset to "" once EL fails after audio played)
  let pendingEnd = false; // end() has been called; waiting on isFinal or running fallback

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
    try {
      onDone?.();
    } catch (err) {
      log.error("tts_turn_done_handler_error", { callSid, reason: err?.message });
    }
  }

  function fireError(err) {
    try {
      onError?.(err);
    } catch (handlerErr) {
      log.error("tts_turn_error_handler_error", { callSid, reason: handlerErr?.message });
    }
  }

  async function runFallback() {
    const sentences = splitSentences(fallbackText);
    fallbackText = "";

    if (sentences.length === 0) {
      finishDone();
      return;
    }

    log.info("tts_fallback", { callSid, sentences: sentences.length, voice: googleFallbackVoice });

    try {
      for (const sentence of sentences) {
        if (isSuppressed()) break;
        const buf = await synthesizeMulaw(sentence, googleFallbackVoice, callSid);
        if (isSuppressed()) break;
        emitAudioChunk(buf);
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
    log.error("tts_el_turn_error", { callSid, code: err?.code, reason: err?.message });

    if (aborted) return; // intentional teardown — no fallback needed

    // No audio produced yet: fall back for everything written so far.
    // Audio already produced: fall back only for text written from now on.
    fallbackText = audioReceived ? "" : writtenText;

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
        onAudio: (buf) => {
          audioReceived = true;
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

  return { write, end, abort };
}
