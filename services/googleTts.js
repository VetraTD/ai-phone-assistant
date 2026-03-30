import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import crypto from "crypto";
import { buildSayContent } from "../lib/twiml.js";

// ---------------------------------------------------------------------------
// In-memory audio store: UUID → { buffer, ts }
// Entries are deleted immediately when consumed (Twilio fetches the Play URL).
// A TTL cleanup runs every minute to remove entries that were never fetched.
// ---------------------------------------------------------------------------

const audioStore = new Map();


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
// Core synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesize text to an MP3 buffer using Google Cloud TTS.
 * Results are cached by hash(voiceName + "|" + text).
 *
 * @param {string} text - Plain text to speak (abbreviation expansion + SSML breaks added automatically)
 * @param {string} voiceName - Google voice name, e.g. "en-US-Neural2-F" or "en-US-Chirp3-HD-Aoede"
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
export async function synthesize(text, voiceName) {
  const cacheKey = crypto
    .createHash("sha256")
    .update(voiceName + "|" + text)
    .digest("hex");

  if (audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey);
  }

  // Derive BCP-47 language code from the voice name ("en-US-Neural2-F" → "en-US")
  const languageCode = voiceName.split("-").slice(0, 2).join("-");

  // Reuse the existing SSML helper (abbreviation expansion + sentence break injection)
  // then wrap in <speak> root element required by Google TTS
  const ssml = `<speak>${buildSayContent(text)}</speak>`;

  const [response] = await getClient().synthesizeSpeech({
    input: { ssml },
    voice: { languageCode, name: voiceName },
    audioConfig: { audioEncoding: "MP3" },
  });

  const buffer = Buffer.from(response.audioContent, "binary");

  // Simple LRU-by-insertion eviction: remove oldest entry when cache is full
  if (audioCache.size >= CACHE_MAX) {
    audioCache.delete(audioCache.keys().next().value);
  }
  audioCache.set(cacheKey, buffer);

  return buffer;
}

// ---------------------------------------------------------------------------
// One-time audio store (serve once → delete)
// ---------------------------------------------------------------------------

/**
 * Store an audio buffer and return a one-time UUID for fetching it.
 * @param {Buffer} buffer - MP3 audio data
 * @returns {string} UUID key
 */
export function storeAudio(buffer) {
  const id = crypto.randomUUID();
  audioStore.set(id, { buffer, ts: Date.now() });
  return id;
}

/**
 * Retrieve and immediately delete an audio buffer by UUID.
 * Returns null if the ID is not found (already consumed or expired).
 * @param {string} id - UUID returned by storeAudio
 * @returns {Buffer|null}
 */
export function consumeAudio(id) {
  const entry = audioStore.get(id);
  if (!entry) return null;
  audioStore.delete(id);
  return entry.buffer;
}

/**
 * Synthesize text and store the resulting audio buffer.
 * Returns the UUID to use in the /audio/:id route.
 * @param {string} text
 * @param {string} voiceName
 * @returns {Promise<string>} UUID
 */
export async function synthesizeAndStore(text, voiceName) {
  const buffer = await synthesize(text, voiceName);
  return storeAudio(buffer);
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
 * Cached separately from MP3 buffers (cache key prefixed with "mulaw|").
 *
 * @param {string} text      - Plain text to speak
 * @param {string} voiceName - Google voice name, e.g. "en-US-Chirp3-HD-Aoede"
 * @returns {Promise<Buffer>} Raw mulaw audio bytes (no container/header)
 */
export async function synthesizeMulaw(text, voiceName) {
  const cacheKey = crypto
    .createHash("sha256")
    .update("mulaw|" + voiceName + "|" + text)
    .digest("hex");

  if (audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey);
  }

  const languageCode = voiceName.split("-").slice(0, 2).join("-");
  const ssml = `<speak>${buildSayContent(text)}</speak>`;

  const [response] = await getClient().synthesizeSpeech({
    input: { ssml },
    voice: { languageCode, name: voiceName },
    audioConfig: { audioEncoding: "MULAW", sampleRateHertz: 8000 },
  });

  // Google TTS MULAW output is a WAV container — strip the WAV header so
  // Twilio receives raw mulaw bytes (otherwise the header bytes play as a click).
  const raw = Buffer.from(response.audioContent, "binary");
  const buffer = stripWavHeader(raw);

  if (audioCache.size >= CACHE_MAX) {
    audioCache.delete(audioCache.keys().next().value);
  }
  audioCache.set(cacheKey, buffer);

  return buffer;
}

// ---------------------------------------------------------------------------
// TTL cleanup — remove stale entries that were never fetched (e.g. Twilio error)
// ---------------------------------------------------------------------------

const AUDIO_TTL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const cutoff = Date.now() - AUDIO_TTL_MS;
  for (const [id, { ts }] of audioStore) {
    if (ts < cutoff) {
      audioStore.delete(id);
    }
  }
}, 60_000).unref();
