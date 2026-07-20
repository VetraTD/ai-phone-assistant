// UNVERIFIED — ELEVENLABS_API_KEY is not present in this environment's .env,
// so these voice IDs could not be checked against GET
// https://api.elevenlabs.io/v1/voices before landing this catalog. The IDs
// below are ElevenLabs' well-known classic premade voices (stable, widely
// documented) but MUST be re-verified against /v1/voices before launch —
// ElevenLabs occasionally retires/renames premade voices.

/**
 * Curated ElevenLabs voice picker for the per-business voice-selection
 * dashboard (see database/015_voice_settings.sql, services/supabase.js
 * loadConfig -> config.voiceId). Each entry's `voiceSettings` is used by
 * lib/voice/session.js's resolveVoice() whenever config.voiceId matches
 * `elevenVoiceId`, threaded through to ttsStream.js/elevenlabs.js's
 * voiceSettings passthrough.
 *
 * @typedef {object} VoiceCatalogEntry
 * @property {string} id - stable catalog key (dashboard-facing)
 * @property {string} elevenVoiceId - ElevenLabs voice ID
 * @property {string} label
 * @property {string} description
 * @property {"male"|"female"} gender
 * @property {string} accent
 * @property {string} previewText - receptionist-flavored sample line
 * @property {{stability: number, similarity_boost: number}} voiceSettings
 */

/** @type {VoiceCatalogEntry[]} */
export const VOICE_CATALOG = [
  {
    id: "rachel",
    elevenVoiceId: "21m00Tcm4TlvDq8ikWAM",
    label: "Rachel",
    description: "Calm, professional US female voice.",
    gender: "female",
    accent: "US",
    previewText: "Thanks for calling — how can I help you today?",
    voiceSettings: { stability: 0.6, similarity_boost: 0.75 },
  },
  {
    id: "adam",
    elevenVoiceId: "pNInz6obpgDQGcFmaJgB",
    label: "Adam",
    description: "Deep, confident US male voice.",
    gender: "male",
    accent: "US",
    previewText: "Hi there, thanks for calling. What can I do for you?",
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  },
  {
    id: "antoni",
    elevenVoiceId: "ErXwobaYiN019PkySvjV",
    label: "Antoni",
    description: "Warm, friendly US male voice.",
    gender: "male",
    accent: "US",
    previewText: "Hey! Thanks for giving us a call — how can I help?",
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  },
  {
    id: "bella",
    elevenVoiceId: "EXAVITQu4vr4xnSDxMaL",
    label: "Bella",
    description: "Soft, approachable US female voice.",
    gender: "female",
    accent: "US",
    previewText: "Hi, thank you for calling! What can I help you with today?",
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  },
  {
    id: "elli",
    elevenVoiceId: "MF3mGyEYCk7xN5WJycdo",
    label: "Elli",
    description: "Young, friendly US female voice.",
    gender: "female",
    accent: "US",
    previewText: "Hi there! Thanks so much for calling — how can I help?",
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  },
  {
    id: "josh",
    elevenVoiceId: "TxGEqnHWrfWFTfGW9XjX",
    label: "Josh",
    description: "Casual, easygoing US male voice.",
    gender: "male",
    accent: "US",
    previewText: "Hey, thanks for calling — what can I do for you today?",
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  },
  {
    id: "charlotte",
    elevenVoiceId: "XB0fDUnXU5powFXDhCwa",
    label: "Charlotte",
    description: "Polished UK female voice.",
    gender: "female",
    accent: "UK",
    previewText: "Thanks for calling — how may I help you today?",
    voiceSettings: { stability: 0.6, similarity_boost: 0.75 },
  },
  {
    id: "charlie",
    elevenVoiceId: "IKne3meq5aSn9XLyUdCD",
    label: "Charlie",
    description: "Relaxed Australian male voice.",
    gender: "male",
    accent: "AU",
    previewText: "G'day, thanks for calling — how can I help you today?",
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  },
];
