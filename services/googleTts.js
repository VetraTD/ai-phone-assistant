import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import crypto from "crypto";
import { buildSayContent } from "../lib/twiml.js";
import { log } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// In-memory synthesis cache: hash(voice|text) → Buffer
// Prevents calling Google TTS repeatedly for the same text (e.g. greeting).
// ---------------------------------------------------------------------------

const audioCache = new Map();
const CACHE_MAX = 200;

// ---------------------------------------------------------------------------
// Google TTS client (lazy singleton)
// ---------------------------------------------------------------------------

let ttsClient = null;

/**
 * Returns true if Google TTS credentials are configured in the environment.
 * When false, all synthesis calls are skipped and Twilio <Say> is used instead.
 */
export function isConfigured() {
  return !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_TTS_API_KEY);
}

function getClient() {
  if (!ttsClient) {
    ttsClient = process.env.GOOGLE_TTS_API_KEY
      ? new TextToSpeechClient({ apiKey: process.env.GOOGLE_TTS_API_KEY })
      : new TextToSpeechClient(); // picks up GOOGLE_APPLICATION_CREDENTIALS automatically
  }
  return ttsClient;
}

// ---------------------------------------------------------------------------
// WAV header stripper
// ---------------------------------------------------------------------------

/**
 * Strip the WAV container header from a Google TTS MULAW response.
 * Google returns MULAW audio wrapped in a WAV container. Twilio expects raw
 * mulaw bytes — the WAV header plays as a loud click if not removed.
 *
 * Searches for the "data" chunk marker and returns everything after the
 * 8-byte chunk descriptor (4-byte "data" tag + 4-byte data length).
 *
 * @param {Buffer} buffer - WAV-wrapped mulaw bytes from Google TTS
 * @returns {Buffer} Raw mulaw bytes
 */
function stripWavHeader(buffer) {
  const dataMarker = Buffer.from("data");
  const idx = buffer.indexOf(dataMarker);
  if (idx === -1) return buffer; // not a WAV container — return as-is
  return buffer.subarray(idx + 8); // skip "data" (4 bytes) + data-chunk size (4 bytes)
}

// ---------------------------------------------------------------------------
// Mulaw synthesis (for Media Streams — Twilio WebSocket expects mulaw 8kHz)
// ---------------------------------------------------------------------------

/**
 * Synthesize text to a raw mulaw 8 kHz buffer using Google Cloud TTS.
 * Cache key is prefixed with "mulaw|" to namespace it within audioCache.
 *
 * @param {string} text      - Plain text to speak
 * @param {string} voiceName - Google voice name, e.g. "en-US-Chirp3-HD-Aoede"
 * @param {string|null} callSid - Optional call ID for logging
 * @returns {Promise<Buffer>} Raw mulaw audio bytes (no container/header)
 */
export async function synthesizeMulaw(text, voiceName, callSid = null) {
  const cacheKey = crypto
    .createHash("sha256")
    .update("mulaw|" + voiceName + "|" + text)
    .digest("hex");

  if (audioCache.has(cacheKey)) {
    log.debug("tts_cache_hit", { callSid, text: text.slice(0, 40) });
    return audioCache.get(cacheKey);
  }

  log.debug("tts_synthesizing", { callSid, voiceName, text: text.slice(0, 40) });
  const languageCode = voiceName.split("-").slice(0, 2).join("-");
  const ssml = `<speak>${buildSayContent(text)}</speak>`;

  try {
    const start = Date.now();
    const [response] = await getClient().synthesizeSpeech({
      input: { ssml },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "MULAW", sampleRateHertz: 8000 },
    });
    const elapsed = Date.now() - start;
    log.debug("tts_synthesized", { callSid, latencyMs: elapsed, audioBytes: response.audioContent?.length || 0 });

    // Google TTS MULAW output is a WAV container — strip the WAV header so
    // Twilio receives raw mulaw bytes (otherwise the header bytes play as a click).
    const raw = Buffer.from(response.audioContent, "binary");
    const buffer = stripWavHeader(raw);
    log.debug("tts_wav_stripped", { callSid, bytes: buffer.length });

    if (audioCache.size >= CACHE_MAX) {
      audioCache.delete(audioCache.keys().next().value);
    }
    audioCache.set(cacheKey, buffer);

    return buffer;
  } catch (err) {
    log.error("tts_error", { callSid, text: text.slice(0, 80), error: err.message });
    throw err;
  }
}
