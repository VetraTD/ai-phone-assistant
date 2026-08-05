import { VOICE_CATALOG } from "../../config/voices.js";
import { countryFromE164 } from "../phone.js";
import { PROFILE_IDS, getProfile } from "./localeProfiles.js";

const KNOWN_LOCALES = new Set(PROFILE_IDS);

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
 * Locale for how the business SOUNDS — the persona the operator chose.
 *
 * Drives the Google fallback voice, the transfer ringtone and the TwiML <Say>
 * voice. Voice accent outranks timezone here on purpose: an operator who picked
 * a British voice wants a British-sounding fallback, wherever they are.
 *
 * @param {object} config - normalized business config (services/supabase.js loadConfig)
 * @returns {"en-US"|"en-GB"|"es-US"}
 */
export function resolveVoiceLocale(config) {
  return resolveLocale(config);
}

/**
 * Locale for how the CALLER is heard — what Deepgram is told to recognise.
 *
 * THE BUG THIS FIXES. Speech recognition used to reuse resolveLocale, which
 * checks the operator's chosen voice accent BEFORE the timezone. That is right
 * for text-to-speech and exactly wrong for recognition: a London business whose
 * operator picked an American voice ran en-US recognition on British callers,
 * so the persona was deciding how the caller was heard. Verified live —
 * +44…6055 resolved en-GB, while a US-numbered business in Europe/London with
 * an American voice resolved en-US.
 *
 * The voice persona is deliberately absent from the order below.
 *
 * @param {object} config
 * @param {object} [ctx]
 * @param {string} [ctx.callerNumber] - E.164, from Twilio call metadata
 * @returns {"en-US"|"en-GB"|"es-US"}
 */
export function resolveSpeechLocale(config, { callerNumber } = {}) {
  // 1. The operator said so. Nothing should second-guess an explicit setting —
  //    the heuristics below exist only because there usually is not one.
  const explicit = typeof config?.locale === "string" ? config.locale.trim() : "";
  if (explicit && KNOWN_LOCALES.has(explicit)) return explicit;

  // 2. A non-English business is recognised in its own language regardless of
  //    where the caller is dialling from.
  const primary = Array.isArray(config?.languagesSpoken) ? config.languagesSpoken[0] : null;
  if (primary === "es") return "es-US";

  // 3. The caller's own number — the most direct evidence of their accent
  //    available, and the signal that was missing entirely.
  const callerCountry = countryFromE164(callerNumber);
  if (callerCountry === "GB") return "en-GB";
  if (callerCountry === "US") return "en-US";

  // 4. Then the business's own number, then its timezone.
  const businessCountry = countryFromE164(config?.phoneNumber || config?.mainPhone);
  if (businessCountry === "GB") return "en-GB";
  if (businessCountry === "US") return "en-US";

  if (UK_TIMEZONES.test(config?.timezone || "")) return "en-GB";
  return "en-US";
}

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

/**
 * The locale profile a business SPEAKS with — its persona, not its callers'.
 *
 * Used for everything the business itself utters: date phrasing, currency,
 * phone-digit grouping, the TwiML <Say> voice. Recognition is the one thing
 * that follows the caller instead; see resolveSpeechLocale.
 *
 * @param {object} config
 * @returns {import("./localeProfiles.js").PROFILES["en-US"]}
 */
export function resolveProfile(config) {
  return getProfile(config?.locale && KNOWN_LOCALES.has(config.locale) ? config.locale : resolveVoiceLocale(config));
}

/** Google TTS fallback voice matching the business's locale. */
export function resolveGoogleVoice(config) {
  return GOOGLE_VOICE_BY_LOCALE[resolveLocale(config)] || GOOGLE_VOICE_BY_LOCALE["en-US"];
}

/** Twilio <Dial ringTone> value matching the business's locale. */
export function resolveRingTone(config) {
  return RING_TONE_BY_LOCALE[resolveLocale(config)] || "us";
}
