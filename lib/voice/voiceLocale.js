import { VOICE_CATALOG } from "../../config/voices.js";

// ---------------------------------------------------------------------------
// voiceLocale.js — resolve a business's locale for voice/telephony purposes.
//
// The locale drives everything that should match the business's "sound":
//   - the Google TTS fallback voice (so an outage never flips a US business
//     into a British voice mid-call — the previous hardcoded fallback was
//     en-GB regardless of the chosen ElevenLabs voice)
//   - the Twilio <Dial ringTone> played to the caller during a transfer
//
// Priority order:
//   1. Primary configured language, when non-English — the fallback voice
//      must be able to SPEAK that language, which trumps accent matching.
//   2. The chosen ElevenLabs voice's accent (config/voices.js catalog).
//   3. Timezone heuristic (the businesses table has no country column).
//   4. en-US default (US-first product).
// ---------------------------------------------------------------------------

// NOTE: Chirp3-HD voice names shared across locales. en-GB-Chirp3-HD-Aoede is
// verified live (it was the previous hardcoded fallback); the en-US/es-US
// siblings follow Google's documented naming. If Google ever retires one,
// synthesizeMulaw errors surface in tts_fallback_error logs.
const GOOGLE_VOICE_BY_LOCALE = {
  "en-US": "en-US-Chirp3-HD-Aoede",
  "en-GB": "en-GB-Chirp3-HD-Aoede",
  "es-US": "es-US-Chirp3-HD-Aoede",
};

// Twilio <Dial ringTone> values (see redialForTransfer).
const RING_TONE_BY_LOCALE = {
  "en-US": "us",
  "en-GB": "uk",
  "es-US": "us",
};

const UK_TIMEZONES = /^Europe\/(London|Belfast|Isle_of_Man|Guernsey|Jersey)$/;

/**
 * @param {object} config - normalized business config (services/supabase.js loadConfig)
 * @returns {"en-US"|"en-GB"|"es-US"}
 */
export function resolveLocale(config) {
  const primary = Array.isArray(config?.languagesSpoken) ? config.languagesSpoken[0] : null;
  if (primary === "es") return "es-US";

  if (config?.voiceProvider !== "google") {
    const voiceId = config?.voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID || "";
    const entry = VOICE_CATALOG.find((v) => v.elevenVoiceId === voiceId);
    if (entry?.accent === "british") return "en-GB";
    if (entry?.accent === "american") return "en-US";
  }

  if (UK_TIMEZONES.test(config?.timezone || "")) return "en-GB";
  return "en-US";
}

/** Google TTS fallback voice matching the business's locale. */
export function resolveGoogleVoice(config) {
  return GOOGLE_VOICE_BY_LOCALE[resolveLocale(config)] || GOOGLE_VOICE_BY_LOCALE["en-US"];
}

/** Twilio <Dial ringTone> value matching the business's locale. */
export function resolveRingTone(config) {
  return RING_TONE_BY_LOCALE[resolveLocale(config)] || "us";
}
