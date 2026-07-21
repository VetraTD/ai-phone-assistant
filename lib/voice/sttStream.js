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
 * @returns {object}
 */
// Deploy-time latency knob: lets the STT tail be tuned (e.g. 250) without a
// code change, once /api/debug/latency data justifies it. Defaults to 300 —
// see the plan note: turn-taking fixes live in the decision layer, not here.
const DEFAULT_ENDPOINTING_MS = (() => {
  const v = parseInt(process.env.STT_ENDPOINTING_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 2000 ? v : 300;
})();

function buildConnectOptions(language, apiKey, endpointing = DEFAULT_ENDPOINTING_MS) {
  return {
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
 * @param {string}   [opts.callSid]          - Call identifier, used for log correlation
 * @param {function} [opts.onFinal]          - (text: string) => void — full utterance, no filtering
 * @param {function} [opts.onInterim]        - (text: string, meta: {confidence: number}) => void
 * @param {function} [opts.onUtteranceEnd]   - () => void — fired after any onFinal flush
 * @param {function} [opts.onSpeechStarted]  - () => void — Deepgram VAD SpeechStarted event
 * @param {function} [opts.onError]          - (err: Error) => void — fired when reconnect is exhausted
 * @param {function} [opts.onReconnect]      - (attempt: number) => void — fired after a successful reconnect
 * @returns {Promise<{sendAudio: function(Buffer): void, close: function(): void, isAlive: function(): boolean}>}
 */
export async function createSttStream({
  language = "en-US",
  endpointing,
  callSid,
  onFinal,
  onInterim,
  onUtteranceEnd,
  onSpeechStarted,
  onError,
  onReconnect,
} = {}) {
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
  if (!DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is not set");
  }

  const connectOptions =
    endpointing != null
      ? buildConnectOptions(language, DEEPGRAM_API_KEY, endpointing)
      : buildConnectOptions(language, DEEPGRAM_API_KEY);

  let socket = null;
  let connected = false;
  let closed = false; // true once close() has been called intentionally
  let reconnecting = false;
  let keepAliveTimer = null;
  let utteranceBuffer = "";
  let audioQueue = [];
  let queuedBytes = 0;

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

  function flushAudioQueue() {
    const pending = audioQueue;
    audioQueue = [];
    queuedBytes = 0;
    for (const chunk of pending) {
      try {
        socket.sendMedia(chunk);
      } catch (err) {
        log.error("stt_audio_flush_failed", { callSid, reason: err?.message });
      }
    }
  }

  function flushFinal() {
    if (utteranceBuffer) {
      const text = utteranceBuffer.trim();
      utteranceBuffer = "";
      if (text) {
        onFinal?.(text);
      }
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
          if (transcript) {
            utteranceBuffer += (utteranceBuffer ? " " : "") + transcript;
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
      socket.sendMedia(chunk);
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

  socket = await connectSocket();
  connected = true;
  startKeepAlive();
  log.info("stt_open", { callSid, language });

  return { sendAudio, close, isAlive };
}
