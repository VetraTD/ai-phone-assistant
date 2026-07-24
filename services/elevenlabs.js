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
//   single space. An optional `previous_text` may ride on this same handshake
//   frame (see previousText below).
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 3000;

const DEFAULT_MODEL_ID = "eleven_flash_v2_5";

// Longest previous-utterance context we condition prosody on. ~300 chars is a
// couple of sentences — enough for the model to match cadence/energy without
// bloating the handshake.
const PREVIOUS_TEXT_MAX_CHARS = 300;

/**
 * Kill-switch for `previous_text`: cheap insurance in case ElevenLabs
 * tightens handshake validation around this (currently undocumented) field
 * in a way that starts rejecting connections. Set
 * ELEVENLABS_DISABLE_PREVIOUS_TEXT=true (or "1") to omit the field entirely,
 * with no code change or redeploy of the calling logic needed. Read at
 * call-time (not module load) so tests can flip it per-case.
 */
function previousTextDisabled() {
  const v = process.env.ELEVENLABS_DISABLE_PREVIOUS_TEXT;
  return v === "true" || v === "1";
}

const DEFAULT_VOICE_SETTINGS = {
  // Raised 0.5 -> 0.65 (Task 13): one WS per turn means the model has no
  // cross-turn prosody state, so a low stability let expression swing audibly
  // between utterances. 0.65 damps that; the per-voice catalog pass
  // (config/voices.js) fine-tunes from here pending the owner's listening test.
  stability: 0.65,
  similarity_boost: 0.8,
  use_speaker_boost: false,
  speed: 1,
};

/**
 * Trim previous-utterance text (for prosody continuity) to the last
 * `maxChars` characters, cut on a word boundary and never splitting a UTF-16
 * surrogate pair. Empty / whitespace-only / non-string input returns "".
 *
 * Prosody cares about the words immediately BEFORE the new utterance, so we
 * keep the tail, not the head.
 *
 * @param {string} text
 * @param {number} [maxChars=PREVIOUS_TEXT_MAX_CHARS]
 * @returns {string}
 */
export function trimPreviousText(text, maxChars = PREVIOUS_TEXT_MAX_CHARS) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;

  let slice = trimmed.slice(trimmed.length - maxChars);
  // If the cut landed inside a surrogate pair, the slice would start with a
  // lone low surrogate — drop it so we never emit half a code point.
  const firstCode = slice.charCodeAt(0);
  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) slice = slice.slice(1);
  // Advance past any leading partial word to the next whole-word boundary.
  const firstSpace = slice.search(/\s/);
  if (firstSpace >= 0) slice = slice.slice(firstSpace + 1);
  return slice.trim();
}

/**
 * Open a streaming ElevenLabs TTS WebSocket connection.
 *
 * @param {object} opts
 * @param {string} opts.voiceId
 * @param {string} [opts.apiKey=process.env.ELEVENLABS_API_KEY]
 * @param {string} [opts.modelId] - defaults to ELEVENLABS_MODEL env, else "eleven_flash_v2_5" (enables an eleven_turbo_v2_5 A/B by env with no code edit)
 * @param {object} [opts.voiceSettings] - merged over the defaults, sent in the handshake
 * @param {string} [opts.previousText] - the previously-spoken text this utterance continues from; when non-empty it is trimmed (trimPreviousText) and sent as `previous_text` on the handshake so the model matches prior prosody/cadence. Undocumented on the stream-input schema but accepted on the wire (verified live 2026-07-24) — silently ignored if unsupported, so it is safe to always send. Omitted entirely when ELEVENLABS_DISABLE_PREVIOUS_TEXT=true|1 (see previousTextDisabled()).
 * @param {function} [opts.onAudio] - (buf: Buffer) => void — raw mulaw 8kHz, no container
 * @param {function} [opts.onFinal] - () => void — fired on {"isFinal":true}
 * @param {function} [opts.onError] - (err: Error) => void — socket error, unexpected close, or connect timeout
 * @returns {{sendText: function(string): void, flush: function(): void, close: function(): void, isOpen: function(): boolean}}
 */
export function createTtsConnection({
  voiceId,
  apiKey = process.env.ELEVENLABS_API_KEY,
  modelId = process.env.ELEVENLABS_MODEL?.trim() || DEFAULT_MODEL_ID,
  voiceSettings,
  previousText,
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
    const initFrame = { text: " ", voice_settings: settings };
    const prev = previousTextDisabled() ? "" : trimPreviousText(previousText);
    if (prev) initFrame.previous_text = prev;
    rawSend(initFrame);
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

  ws.on("close", (code, reason) => {
    clearConnectTimer();
    open = false;
    if (closed) return; // already handled (intentional close, connect timeout, or prior error)
    closed = true;
    const reasonText = reason?.toString?.() || "";
    const err = new Error(
      `ElevenLabs TTS connection closed unexpectedly${reasonText ? ` (${reasonText})` : ""}`
    );
    err.code = "TTS_CONNECTION_CLOSED";
    // WS close code (1008 = policy violation, ElevenLabs's quota/auth
    // signature) — consumed by lib/voice/ttsHealth.js's circuit breaker.
    err.closeCode = code;
    log.error("tts_el_unexpected_close", { voiceId, closeCode: code, reason: reasonText });
    onError?.(err);
  });

  function sendText(text) {
    if (!text) return;
    const payload = text.endsWith(" ") ? text : text + " ";
    enqueueOrSend({ text: payload });
  }

  /**
   * Signal end-of-input for this turn and ask the server to finish generating.
   *
   * This sends the empty-text frame, NOT `{flush: true}`. With
   * `auto_mode=true` the server already generates as text arrives, and a
   * `{flush:true}` frame streams the remaining audio but never replies with
   * `{"isFinal":true}` — verified against the live API: identical audio, no
   * isFinal, socket then idles until the server times it out after 20s with
   * close code 1008. Because the turn's completion mark is only emitted on
   * isFinal, that made every mark arrive ~20 seconds late (dead air after
   * the greeting, silence nudges armed far too late) and made a healthy
   * connection look like a failure to the circuit breaker.
   *
   * The empty-text frame is the documented end-of-input signal and returns
   * isFinal in ~280ms. One connection per turn, so end-of-input is exactly
   * the right semantic here.
   */
  function flush() {
    enqueueOrSend({ text: "" });
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
