import WebSocket from "ws";
import { log } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Low-level ElevenLabs WebSocket streaming TTS client.
//
// One `createTtsConnection(opts)` per ElevenLabs stream. This module has no
// notion of "turns" or fallback — it only owns the WS socket lifecycle,
// message framing, and audio decoding. Turn orchestration (barge-in, epoch
// suppression, Google TTS fallback) lives in `lib/voice/ttsStream.js`.
//
// Endpoint / handshake / auth per the verified API cheat-sheet (July 2026):
//   wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input
//     ?model_id=...&output_format=ulaw_8000&auto_mode=true
//   Auth: `xi-api-key` HTTP header on the WS handshake (NOT a query param —
//   verify it actually reaches the wire via the `ws` constructor's
//   `options.headers`, not just present in this file's source).
//   Handshake body: {"text":" ","voice_settings":{...}} — text MUST be a
//   single space.
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 3000;

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.8,
  use_speaker_boost: false,
  speed: 1,
};

/**
 * Open a streaming ElevenLabs TTS WebSocket connection.
 *
 * @param {object} opts
 * @param {string} opts.voiceId
 * @param {string} [opts.apiKey=process.env.ELEVENLABS_API_KEY]
 * @param {string} [opts.modelId="eleven_flash_v2_5"]
 * @param {object} [opts.voiceSettings] - merged over the defaults, sent in the handshake
 * @param {function} [opts.onAudio] - (buf: Buffer) => void — raw mulaw 8kHz, no container
 * @param {function} [opts.onFinal] - () => void — fired on {"isFinal":true}
 * @param {function} [opts.onError] - (err: Error) => void — socket error, unexpected close, or connect timeout
 * @returns {{sendText: function(string): void, flush: function(): void, close: function(): void, isOpen: function(): boolean}}
 */
export function createTtsConnection({
  voiceId,
  apiKey = process.env.ELEVENLABS_API_KEY,
  modelId = "eleven_flash_v2_5",
  voiceSettings,
  onAudio,
  onFinal,
  onError,
} = {}) {
  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=ulaw_8000&auto_mode=true`;

  let open = false;
  let closed = false; // true once close() was called (intentionally) OR a terminal error/timeout fired
  let handshakeSent = false;
  let sendQueue = [];
  let connectTimer = null;

  const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });

  function clearConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function rawSend(payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      log.error("tts_el_send_failed", { reason: err?.message });
      onError?.(err);
    }
  }

  // Text/flush frames sent before the socket is open (and before the
  // handshake frame goes out) are queued rather than dropped — the LLM can
  // start streaming deltas before the WS handshake completes.
  function enqueueOrSend(payload) {
    if (closed) return;
    if (open && handshakeSent) {
      rawSend(payload);
    } else {
      sendQueue.push(payload);
    }
  }

  connectTimer = setTimeout(() => {
    if (open || closed) return;
    const err = new Error("ElevenLabs TTS connection timed out");
    err.code = "TTS_CONNECT_TIMEOUT";
    closed = true;
    try {
      ws.terminate ? ws.terminate() : ws.close();
    } catch {
      // socket already gone
    }
    log.error("tts_el_connect_timeout", { voiceId });
    onError?.(err);
  }, CONNECT_TIMEOUT_MS);
  connectTimer.unref?.();

  ws.on("open", () => {
    if (closed) return; // timed out right at the wire; ignore a late open
    open = true;
    clearConnectTimer();

    const settings = { ...DEFAULT_VOICE_SETTINGS, ...voiceSettings };
    rawSend({ text: " ", voice_settings: settings });
    handshakeSent = true;

    const queued = sendQueue;
    sendQueue = [];
    queued.forEach(rawSend);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      log.error("tts_el_parse_error", { reason: err?.message });
      return;
    }

    if (msg.audio) {
      try {
        onAudio?.(Buffer.from(msg.audio, "base64"));
      } catch (err) {
        log.error("tts_el_audio_handler_error", { reason: err?.message });
      }
    }
    if (msg.isFinal) {
      onFinal?.();
    }
  });

  ws.on("error", (err) => {
    clearConnectTimer();
    if (closed) return;
    closed = true;
    log.error("tts_el_socket_error", { voiceId, reason: err?.message });
    onError?.(err);
  });

  ws.on("close", () => {
    clearConnectTimer();
    open = false;
    if (closed) return; // already handled (intentional close, connect timeout, or prior error)
    closed = true;
    const err = new Error("ElevenLabs TTS connection closed unexpectedly");
    err.code = "TTS_CONNECTION_CLOSED";
    log.error("tts_el_unexpected_close", { voiceId });
    onError?.(err);
  });

  function sendText(text) {
    if (!text) return;
    const payload = text.endsWith(" ") ? text : text + " ";
    enqueueOrSend({ text: payload });
  }

  function flush() {
    enqueueOrSend({ text: "", flush: true });
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    clearConnectTimer();
    sendQueue = [];
    if (open && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ text: "" }));
      } catch {
        // best-effort — closing anyway
      }
    }
    try {
      ws.close();
    } catch {
      // already gone
    }
  }

  function isOpen() {
    return open && !closed && ws.readyState === WebSocket.OPEN;
  }

  return { sendText, flush, close, isOpen };
}
