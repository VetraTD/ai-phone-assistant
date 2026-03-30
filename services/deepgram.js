import { DeepgramClient } from "@deepgram/sdk";
import { log } from "../lib/logger.js";
import { captureException } from "../lib/sentry.js";

// ---------------------------------------------------------------------------
// Deepgram streaming STT — one connection per active call
// Uses the @deepgram/sdk v5 API (listen.v1.connect → V1Socket).
// ---------------------------------------------------------------------------

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

/**
 * Create a Deepgram live-transcription connection for one call.
 *
 * The returned socket is already connected — call `sendAudio(socket, chunk)`
 * to pipe audio in and register event callbacks via the opts parameter.
 *
 * @param {object} opts
 * @param {string}   [opts.language]       - BCP-47 language (default "en-US")
 * @param {function} opts.onTranscript     - Called with (text: string) on final transcript
 * @param {function} opts.onSpeechStart    - Called (no args) when VAD detects speech (for barge-in)
 * @param {function} [opts.onUtteranceEnd] - Called when speaker pauses (utterance boundary)
 * @param {function} [opts.onError]        - Called with (err) on connection error
 * @param {function} [opts.onClose]        - Called when the connection closes
 * @returns {Promise<object>} V1Socket — has .sendMedia(), .close(), .readyState
 */
export async function createStream({
  language = "en-US",
  onTranscript,
  onSpeechStart,
  onUtteranceEnd,
  onError,
  onClose,
  callSid,
}) {
  if (!DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is not set");
  }

  const client = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });

  // connect() creates the V1Socket but doesn't open the underlying WebSocket.
  // Call socket.connect() to call reconnect() on the ReconnectingWebSocket,
  // then await waitForOpen() before returning so audio can be sent immediately.
  const socket = await client.listen.v1.connect({
    model: "nova-2-phonecall",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    language,
    smart_format: true,
    interim_results: true,
    utterance_end_ms: 3000, // 3 s — gives callers time to pause mid-thought without cutting off
    vad_events: true,
    Authorization: `Token ${DEEPGRAM_API_KEY}`,
  });

  socket.connect(); // initiates the WebSocket connection
  await socket.waitForOpen(); // wait until the connection is ready
  log.info("deepgram_open", { callSid, language });

  // Accumulate is_final transcript segments until UtteranceEnd fires.
  // This ensures we capture the full utterance before calling Gemini.
  let utteranceBuffer = "";

  socket.on("message", (msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "Results": {
        const alt = msg.channel?.alternatives?.[0];
        if (!alt) return;
        const transcript = alt.transcript || "";
        if (!transcript) return;

        if (msg.is_final) {
          utteranceBuffer += (utteranceBuffer ? " " : "") + transcript;
        }

        // speech_final means Deepgram detected end-of-turn within this event
        if (msg.speech_final && utteranceBuffer) {
          const text = utteranceBuffer.trim();
          utteranceBuffer = "";
          if (text) {
            log.debug("deepgram_transcript", { callSid, text: text.slice(0, 100), wordCount: text.split(/\s+/).length });
            onTranscript(text);
          }
        }
        break;
      }

      case "UtteranceEnd": {
        if (utteranceBuffer) {
          const text = utteranceBuffer.trim();
          utteranceBuffer = "";
          if (text) {
            log.debug("deepgram_utterance_end", { callSid, text: text.slice(0, 100), wordCount: text.split(/\s+/).length });
            onTranscript(text);
          }
        }
        if (onUtteranceEnd) onUtteranceEnd();
        break;
      }

      case "SpeechStarted": {
        log.debug("deepgram_speech_started", { callSid });
        if (onSpeechStart) onSpeechStart();
        break;
      }
    }
  });

  socket.on("error", (err) => {
    log.error("deepgram_error", { callSid, message: err?.message });
    captureException(err, { callSid, context: "deepgram" });
    if (onError) onError(err);
  });

  socket.on("close", () => {
    // Flush any remaining buffered text
    if (utteranceBuffer) {
      const text = utteranceBuffer.trim();
      utteranceBuffer = "";
      if (text) onTranscript(text);
    }
    log.debug("deepgram_closed", { callSid });
    if (onClose) onClose();
  });

  return socket;
}

/**
 * Send a raw mulaw audio chunk to an active Deepgram V1Socket.
 * @param {object} socket - Deepgram V1Socket
 * @param {Buffer} chunk  - Raw mulaw bytes
 */
let _audioChunkCount = 0;
export function sendAudio(socket, chunk, callSid = null) {
  try {
    socket.sendMedia(chunk);
    _audioChunkCount++;
    // Only log periodically to reduce noise (every 500 chunks ~= once per 2-3 seconds)
    if (_audioChunkCount % 500 === 0) {
      log.debug("deepgram_audio_status", { callSid, chunks: _audioChunkCount, readyState: socket.readyState });
    }
  } catch (err) {
    if (_audioChunkCount % 500 === 0) {
      log.error("deepgram_audio_drop", { callSid, chunks: _audioChunkCount, reason: err?.message });
    }
    _audioChunkCount++;
  }
}

/**
 * Gracefully close a Deepgram V1Socket.
 * @param {object} socket - Deepgram V1Socket
 */
export function closeStream(socket) {
  try {
    socket.close();
  } catch {
    // already closed
  }
}
