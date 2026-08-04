import { performance } from "node:perf_hooks";
import { DeepgramClient } from "@deepgram/sdk";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Deepgram streaming STT — standalone module for the voice-pipeline rewrite.
//
// This is a NEW module (not yet wired into the live call path). It differs
// from services/deepgram.js in two ways:
//   1. model is "nova-3" (not "nova-2-phonecall"), per the verified API
//      cheat-sheet — "nova-3-phonecall" does not exist.
//   2. It adds connection reliability: a 5s KeepAlive heartbeat and automatic
//      reconnect (up to 3 attempts, 250ms apart) with an in-memory audio
//      buffer (capped at 16,000 bytes) so a transient socket drop doesn't
//      lose audio or require the caller to repeat themselves.
//
// Utterance handling mirrors services/deepgram.js: is_final fragments
// accumulate into a buffer, flushed to onFinal on speech_final OR on
// UtteranceEnd (whichever comes first). No punctuation gating, no minimum
// word count, no debounce — filtering policy belongs to the turn manager,
// not this layer.
// ---------------------------------------------------------------------------

const KEEPALIVE_INTERVAL_MS = 5000; // Deepgram times out after 10s idle
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 250;
const MAX_BUFFERED_BYTES = 16000; // ~2s of 8kHz mulaw
const MULAW_BYTES_PER_MS = 8; // 8kHz, 1 byte per sample

// ---------------------------------------------------------------------------
// Reconstructing when the caller actually stopped talking.
//
// A final arrives well after the speech it describes: Deepgram waits out its
// endpointing window (default 300ms), runs inference, and the result crosses
// the network. Everything in that gap is time the caller spends waiting, and
// it is invisible to this process — `performance.now()` at the moment the
// final lands is already too late.
//
// Deepgram does tell us where the speech ended, but on ITS clock: word `end`
// times are seconds since the stream opened. Counting the mu-law bytes we have
// actually handed to the socket gives us the same clock (8 bytes = 1ms), so
// the difference between "audio we have streamed" and "where the last word
// ended" is the tail. Subtracting that from now() yields the wall-clock
// instant the caller went quiet.
//
// Two things keep the clocks aligned, and both are load-bearing:
//   - only audio genuinely delivered to Deepgram advances the counter (audio
//     dropped by the reconnect buffer's cap never reaches it), and
//   - the counter resets on reconnect, because a new socket restarts
//     Deepgram's stream time at zero.
// ---------------------------------------------------------------------------

/**
 * Build the Deepgram live-transcription connection options.
 *
 * NOTE: `Authorization` is load-bearing, not decorative. `V1Client.connect()`
 * builds the WS handshake's Authorization header only from the options passed
 * to `connect()` — it does NOT consult the client's authProvider (that's wired
 * for the HTTP clients only), and `mergeOnlyDefinedHeaders` silently drops an
 * absent header. Without this field every real connection fails the
 * handshake. Read the key fresh at connect time (not module load) since this
 * is called on every (re)connect attempt.
 *
 * @param {string} language
 * @param {string} apiKey
 * @param {number} [endpointing=300] - ms of silence before finalizing an
 *   utterance. Deepgram recommends a shorter value (e.g. 100) for
 *   language="multi" code-switching — see createSttStream's jsdoc.
 * @param {string[]} [keyterms=[]] - business-domain terms to boost recognition
 *   of (business name, custom identity labels). Included ONLY for English calls
 *   (see below); ignored otherwise.
 * @returns {object}
 */
// Deploy-time latency knob: lets the STT tail be tuned without a code change.
//
// Lowered 300 -> 150 on 2026-08-04, once probe data justified it. Measured
// stt_endpoint_ms is ~700ms, but only the endpointing window is ours to spend —
// the remainder is Deepgram inference plus network and is not tunable, so the
// realistic ceiling here is ~150ms of a ~2,570ms turn.
//
// The trade this buys is finals that arrive sooner but are more often
// mid-sentence. classifyHold exists to catch exactly that, and on realistic
// speech it currently never fires (probe D: 0 of 120 turns, stt_tail_ms p50 0),
// so there is headroom for it to absorb some. If it starts firing, the win
// moves from stt_endpoint_ms into stt_tail_ms and nets out — which is the
// comparison recorded in docs/latency-and-tts-tests.md. Revert by restoring
// 150 -> 300 here, or set STT_ENDPOINTING_MS without a deploy.
const DEFAULT_ENDPOINTING_MS = (() => {
  const v = parseInt(process.env.STT_ENDPOINTING_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 2000 ? v : 150;
})();

// Keyterm prompting (nova-3) is gated to English. The current Deepgram docs
// claim monolingual+multilingual support, but efficacy on non-English/code-
// switching calls is unproven and our terms are English business names, so we
// stay conservative: boost only when the call is running in an English locale,
// and never for language="multi".
function isEnglishLanguage(language) {
  return typeof language === "string" && /^en(-|$)/i.test(language);
}

function buildConnectOptions(
  language,
  apiKey,
  endpointing = DEFAULT_ENDPOINTING_MS,
  keyterms = []
) {
  const options = {
    model: "nova-3",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    language,
    smart_format: true,
    punctuate: true,
    numerals: true,
    interim_results: true,
    endpointing,
    utterance_end_ms: 1000,
    vad_events: true,
    Authorization: `Token ${apiKey}`,
  };

  // Deepgram's API takes REPEATED `keyterm=` query params. The SDK's top-level
  // `keyterm` option JSON-encodes an array into a SINGLE param (verified in
  // node_modules/@deepgram/sdk .../v1/client/Client.js), which the API reads as
  // one garbage keyterm. The `queryParams` passthrough is instead serialized by
  // the ws layer with arrayFormat:"repeat" -> keyterm=A&keyterm=B, so pass the
  // array there. Skip entirely for non-English / "multi" (see above).
  if (Array.isArray(keyterms) && keyterms.length > 0 && isEnglishLanguage(language)) {
    options.queryParams = { keyterm: keyterms };
  }

  return options;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a reconnecting Deepgram nova-3 streaming STT connection for one call.
 *
 * @param {object} opts
 * @param {string}   [opts.language="en-US"] - BCP-47 language (or "multi" for code-switching)
 * @param {number}   [opts.endpointing=300]  - ms of silence before finalizing an utterance (Deepgram recommends 100 for language="multi")
 * @param {string[]} [opts.keyterms=[]]      - business-domain terms to boost (English calls only)
 * @param {string}   [opts.callSid]          - Call identifier, used for log correlation
 * @param {function} [opts.onFinal]          - (text: string) => void — full utterance, no filtering
 * @param {function} [opts.onInterim]        - (text: string, meta: {confidence: number}) => void
 * @param {function} [opts.onUtteranceEnd]   - () => void — fired after any onFinal flush
 * @param {function} [opts.onSpeechStarted]  - () => void — Deepgram VAD SpeechStarted event
 * @param {function} [opts.onError]          - (err: Error) => void — fired when reconnect is exhausted
 * @param {function} [opts.onReconnect]      - (attempt: number) => void — fired after a successful reconnect
 * @param {function} [opts.now]              - injectable clock (ms), defaults to performance.now()
 * @returns {Promise<{sendAudio: function(Buffer): void, close: function(): void, isAlive: function(): boolean, getLastSpeechEndAt: function(): number|null}>}
 */
export async function createSttStream({
  language = "en-US",
  endpointing,
  keyterms = [],
  callSid,
  onFinal,
  onInterim,
  onUtteranceEnd,
  onSpeechStarted,
  onError,
  onReconnect,
  now = () => performance.now(),
} = {}) {
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
  if (!DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is not set");
  }

  // Pass `undefined` for endpointing to fall through to buildConnectOptions'
  // default; keyterms are always forwarded (gated to English inside).
  const connectOptions = buildConnectOptions(
    language,
    DEEPGRAM_API_KEY,
    endpointing != null ? endpointing : undefined,
    keyterms
  );

  let socket = null;
  let connected = false;
  let closed = false; // true once close() has been called intentionally
  let reconnecting = false;
  let keepAliveTimer = null;
  let utteranceBuffer = "";
  /** Lowest confidence among the fragments making up the pending final. */
  let utteranceMinConfidence;
  let audioQueue = [];
  let queuedBytes = 0;
  // ms of audio Deepgram has actually received on the CURRENT socket — the
  // shared clock that makes its word timings comparable to ours.
  let deliveredAudioMs = 0;
  let lastSpeechEndAt = null;

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      try {
        socket?.sendKeepAlive({ type: "KeepAlive" });
      } catch (err) {
        log.error("stt_keepalive_failed", { callSid, reason: err?.message });
      }
    }, KEEPALIVE_INTERVAL_MS);
    keepAliveTimer.unref?.();
  }

  function bufferAudio(chunk) {
    audioQueue.push(chunk);
    queuedBytes += chunk.length;
    while (queuedBytes > MAX_BUFFERED_BYTES && audioQueue.length > 0) {
      const dropped = audioQueue.shift();
      queuedBytes -= dropped.length;
    }
  }

  /**
   * Hand one chunk to Deepgram and advance the shared audio clock by exactly
   * what it received. Throws to the caller so a failed send can be re-buffered
   * without the clock counting audio that never arrived.
   * @param {Buffer} chunk
   */
  function deliver(chunk) {
    socket.sendMedia(chunk);
    deliveredAudioMs += chunk.length / MULAW_BYTES_PER_MS;
  }

  function flushAudioQueue() {
    const pending = audioQueue;
    audioQueue = [];
    queuedBytes = 0;
    for (const chunk of pending) {
      try {
        deliver(chunk);
      } catch (err) {
        log.error("stt_audio_flush_failed", { callSid, reason: err?.message });
      }
    }
  }

  function flushFinal() {
    if (utteranceBuffer) {
      const text = utteranceBuffer.trim();
      utteranceBuffer = "";
      // Reported alongside the text so turnManager can refuse to let a
      // low-confidence scrap interrupt the assistant. The MINIMUM across the
      // fragments, not the last or the mean: a final is assembled from several
      // is_final results, and the question being asked is "could any part of
      // this be noise?", for which the weakest link is the honest answer.
      const confidence = utteranceMinConfidence;
      utteranceMinConfidence = undefined;
      if (text) {
        onFinal?.(text, { confidence });
      }
    }
  }

  /**
   * Convert a final's audio-relative end time into a wall-clock instant.
   * Prefers the last word's `end` (the actual end of speech) and falls back to
   * the result window's `start + duration`, which includes trailing silence
   * and so under-reports the tail rather than inventing one.
   * @param {object} msg - the Deepgram Results message
   * @param {object} alt - msg.channel.alternatives[0]
   */
  function recordSpeechEnd(msg, alt) {
    try {
      const words = alt?.words;
      const lastWordEnd = Array.isArray(words) && words.length ? words[words.length - 1]?.end : null;
      const windowEnd =
        typeof msg.start === "number" && typeof msg.duration === "number"
          ? msg.start + msg.duration
          : null;
      const endSec = typeof lastWordEnd === "number" ? lastWordEnd : windowEnd;
      if (typeof endSec !== "number" || !Number.isFinite(endSec)) return;

      // A negative tail would mean Deepgram described audio we have not sent —
      // impossible, so treat it as a desynced clock and don't back-date at all.
      const tailMs = Math.max(0, deliveredAudioMs - endSec * 1000);
      lastSpeechEndAt = now() - tailMs;
    } catch {
      // Instrumentation must never break a call.
    }
  }

  function handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "Results": {
        const alt = msg.channel?.alternatives?.[0];
        if (!alt) return;
        const transcript = alt.transcript || "";

        if (msg.is_final) {
          recordSpeechEnd(msg, alt);
          if (transcript) {
            utteranceBuffer += (utteranceBuffer ? " " : "") + transcript;
            if (typeof alt.confidence === "number" && Number.isFinite(alt.confidence)) {
              utteranceMinConfidence =
                utteranceMinConfidence === undefined
                  ? alt.confidence
                  : Math.min(utteranceMinConfidence, alt.confidence);
            }
          }
          if (msg.speech_final) {
            flushFinal();
          }
        } else if (transcript) {
          onInterim?.(transcript, { confidence: alt.confidence });
        }
        break;
      }

      case "UtteranceEnd": {
        flushFinal();
        onUtteranceEnd?.();
        break;
      }

      case "SpeechStarted": {
        log.debug("stt_speech_started", { callSid });
        onSpeechStarted?.();
        break;
      }
    }
  }

  // Detach our handlers from a socket we're abandoning so any further events
  // it fires (including the synchronous close callback the SDK invokes from
  // inside its own close()) are inert, then close it. This matters because
  // the SDK's underlying ReconnectingWebSocket auto-reconnects on its own
  // (up to 30 retries) unless explicitly closed — an abandoned socket left
  // with our handlers attached could silently reconnect later and deliver
  // duplicate transcripts, or fire a late close that re-triggers reconnect
  // logic after we've already recovered.
  function teardownSocket(s) {
    if (!s) return;
    try {
      s.on("message", () => {});
      s.on("error", () => {});
      s.on("close", () => {});
    } catch (err) {
      log.error("stt_teardown_detach_failed", { callSid, reason: err?.message });
    }
    try {
      s.close();
    } catch (err) {
      log.error("stt_teardown_close_failed", { callSid, reason: err?.message });
    }
  }

  function triggerReconnectIfNeeded() {
    if (closed || reconnecting) return;
    reconnecting = true;
    const staleSocket = socket;
    socket = null;
    teardownSocket(staleSocket);
    attemptReconnect();
  }

  function handleSocketError(err) {
    log.error("stt_socket_error", { callSid, message: err?.message });
    connected = false;
    stopKeepAlive();
    triggerReconnectIfNeeded();
  }

  function handleSocketClose() {
    connected = false;
    stopKeepAlive();
    triggerReconnectIfNeeded();
  }

  async function connectSocket() {
    const client = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });
    const s = await client.listen.v1.connect({ ...connectOptions });
    s.connect();
    await s.waitForOpen();
    s.on("message", handleMessage);
    s.on("error", handleSocketError);
    s.on("close", handleSocketClose);
    return s;
  }

  async function attemptReconnect() {
    let attempt = 0;
    let newSocket = null;

    while (attempt < MAX_RECONNECT_ATTEMPTS && !closed) {
      attempt++;
      await delay(RECONNECT_DELAY_MS);
      if (closed) break;
      try {
        newSocket = await connectSocket();
        break;
      } catch (err) {
        log.error("stt_reconnect_attempt_failed", { callSid, attempt, reason: err?.message });
        newSocket = null;
      }
    }

    reconnecting = false;

    if (closed) {
      if (newSocket) {
        try {
          newSocket.close();
        } catch {
          // already gone
        }
      }
      return;
    }

    if (newSocket) {
      socket = newSocket;
      connected = true;
      bufferingWarned = false;
      // A new socket is a new Deepgram stream whose word timings restart at 0,
      // so our matching audio clock has to restart with it. Reset BEFORE the
      // flush so replayed buffered audio is counted against the new stream.
      deliveredAudioMs = 0;
      startKeepAlive();
      flushAudioQueue();
      log.info("stt_reconnected", { callSid, attempt });
      onReconnect?.(attempt);
    } else {
      flushFinal();
      const err = new Error(`STT reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      err.code = "STT_RECONNECT_FAILED";
      log.error("stt_reconnect_exhausted", { callSid, attempts: MAX_RECONNECT_ATTEMPTS });
      onError?.(err);
    }
  }

  // Logged once per buffering episode (not per chunk) to avoid spamming logs
  // for every ~20ms audio frame while a reconnect is in flight.
  let bufferingWarned = false;

  function sendAudio(chunk) {
    if (!chunk || closed) return;
    if (!connected || !socket) {
      if (!bufferingWarned) {
        log.error("stt_audio_buffering", { callSid, reason: "socket_not_connected" });
        bufferingWarned = true;
      }
      bufferAudio(chunk);
      return;
    }
    try {
      deliver(chunk);
    } catch (err) {
      log.error("stt_audio_send_failed", { callSid, reason: err?.message });
      bufferAudio(chunk);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    connected = false;
    stopKeepAlive();
    audioQueue = [];
    queuedBytes = 0;
    if (socket) {
      try {
        socket.close();
      } catch (err) {
        log.error("stt_close_failed", { callSid, reason: err?.message });
      }
    }
    log.info("stt_closed", { callSid });
  }

  function isAlive() {
    return !closed && connected;
  }

  /**
   * Wall-clock instant (same base as the injected clock) at which the caller
   * stopped speaking for the most recent final, or null before any final.
   * Returned as an absolute timestamp rather than a lag so callers can't
   * mis-anchor it: the lag is only meaningful against the moment the final
   * arrived, which is not the moment a consumer gets around to asking.
   * @returns {number|null}
   */
  function getLastSpeechEndAt() {
    return lastSpeechEndAt;
  }

  socket = await connectSocket();
  connected = true;
  startKeepAlive();
  log.info("stt_open", { callSid, language });

  return { sendAudio, close, isAlive, getLastSpeechEndAt };
}
