// Verified against the live ElevenLabs account (GET /v1/voices) on
// 2026-07-20. All 8 entries below exist on the account as of that date.
// Re-check with: node --env-file=.env scripts/verify-voices.js
// (ElevenLabs occasionally retires/renames premade voices, so re-run this
// before relying on the catalog again if it's been a while.)

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
 * @property {"male"|"female"|"neutral"} gender
 * @property {string} accent
 * @property {string} previewText - receptionist-flavored sample line
 * @property {{stability: number, similarity_boost: number}} voiceSettings
 */

// Task 13 prosody pass: a per-turn ElevenLabs socket carries no cross-turn
// prosody state, so lower stability let expression swing audibly between
// utterances; these were damped to a 0.6 floor.
//
// Raised again 0.6 -> 0.72 after a reported symptom the floor did not cover:
// the voice "gets too emotional... the longer the conversation goes, it
// sometimes starts yelling". Two causes, fixed together — unsanitized
// exclamation marks and ALL-CAPS reaching the engine as emphasis (now damped in
// lib/voice/speakableText.js dampEmphasis), and low stability letting any given
// utterance land wild. Higher stability trades expressiveness for consistency,
// which is the right trade for a receptionist.
//
// Do NOT lower any of these below 0.6 without re-running the listening pass
// (scripts/voice-ab.js — note it must be fixed to REPLACE previous_text per
// turn as production does, rather than accumulate, or it is not modelling the
// live path).

/** @type {VoiceCatalogEntry[]} */
export const VOICE_CATALOG = [
  {
    id: "bella",
    elevenVoiceId: "hpp4J3VqNfWAUOO0d1Us",
    label: "Bella",
    description: "Warm and professional. A polished front-desk voice.",
    gender: "female",
    accent: "american",
    previewText: "Thanks so much for calling — how can I help you today?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
  {
    id: "sarah",
    elevenVoiceId: "EXAVITQu4vr4xnSDxMaL",
    label: "Sarah",
    description: "Bright and professional, with a youthful energy — great for busy front desks.",
    gender: "female",
    accent: "american",
    previewText: "Hi there, thanks for calling! What can I help you with?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
  {
    id: "matilda",
    elevenVoiceId: "XrExE9yKIg1WjnnlVkGX",
    label: "Matilda",
    description: "Upbeat and energetic — a friendly voice that puts callers at ease.",
    gender: "female",
    accent: "american",
    previewText: "Hey! Thanks for calling — how can I help you out today?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
  {
    id: "alice",
    elevenVoiceId: "Xb7hH8MSUJpSbSDYk0k2",
    label: "Alice",
    description: "Polished and professional, with a crisp British accent.",
    gender: "female",
    accent: "british",
    previewText: "Good afternoon, thank you for calling — how may I help you?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
  {
    id: "eric",
    elevenVoiceId: "cjVigY5qzO86Huf0OWal",
    label: "Eric",
    description: "Smooth and classy — a confident voice for a professional front desk.",
    gender: "male",
    accent: "american",
    previewText: "Thanks for calling — this is our assistant. How can I help you today?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
  {
    id: "roger",
    elevenVoiceId: "CwhRBWXzGAHq8TQ4Fs17",
    label: "Roger",
    description: "Warm and classy, with an easy confidence that puts callers at ease.",
    gender: "male",
    accent: "american",
    previewText: "Hey there, thanks for giving us a call — what can I do for you?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
  {
    id: "daniel",
    elevenVoiceId: "onwK4e9ZLuTAKqWW03F9",
    label: "Daniel",
    description: "Formal and precise, with a distinguished British accent.",
    gender: "male",
    accent: "british",
    previewText: "Good day, thank you for calling. How may I assist you?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
  {
    id: "river",
    elevenVoiceId: "SAz9YHcvj6GT2YYXdXww",
    label: "River",
    description: "Calm and steady — an easygoing voice that keeps callers relaxed.",
    gender: "neutral",
    accent: "american",
    previewText: "Hi, thanks for calling — how can I help you today?",
    voiceSettings: { stability: 0.72, similarity_boost: 0.75 },
  },
];
