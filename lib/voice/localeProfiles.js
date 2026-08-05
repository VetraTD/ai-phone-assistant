/**
 * Locale profiles — everything that differs between the markets we serve, in
 * one table.
 *
 * Before this existed the differences were scattered: a Google voice map here,
 * a ringtone map there, `"en-US"` hardcoded in every date formatter, `$` as the
 * only currency, and phone-digit grouping that assumed a North American number.
 * A business in London got American date phrasing, American currency, and its
 * British landline read out in groups of three.
 *
 * Two locales are NOT the same question, and conflating them was a live bug:
 *
 *   - the VOICE locale is the persona the operator chose. It drives the Google
 *     fallback voice, the transfer ringtone, and the TwiML <Say> voice.
 *   - the SPEECH locale is the accent the CALLER has. It drives Deepgram.
 *
 * A London business whose operator picked an American voice must still run
 * en-GB recognition on its British callers. See voiceLocale.js.
 *
 * Adding a market means adding a row here. Nothing in the pipeline reads a
 * locale id directly — tests/localeProfiles.test.js pins that by building an
 * unregistered en-AU profile and running every formatter over it.
 */

/** @typedef {"MDY"|"DMY"} DateStyle */

export const PROFILES = {
  "en-US": {
    id: "en-US",
    sttLanguage: "en-US",
    intlLocale: "en-US",
    googleVoice: "en-US-Chirp3-HD-Aoede",
    ringTone: "us",
    twimlSayVoice: "Polly.Joanna",
    // "Thursday, August 6th at 2 PM"
    dateStyle: "MDY",
    currency: { code: "USD", symbol: "$", major: "dollars", minor: "cents" },
    phone: { cc: "1", trunk: "", style: "nanp" },
    numberCountry: "US",
    stringsOverlay: null,
  },

  "en-GB": {
    id: "en-GB",
    sttLanguage: "en-GB",
    intlLocale: "en-GB",
    googleVoice: "en-GB-Chirp3-HD-Aoede",
    ringTone: "uk",
    twimlSayVoice: "Polly.Amy",
    // "Thursday the 6th of August at 2 PM"
    dateStyle: "DMY",
    currency: { code: "GBP", symbol: "£", major: "pounds", minor: "pence" },
    phone: { cc: "44", trunk: "0", style: "uk" },
    numberCountry: "GB",
    stringsOverlay: null,
  },

  "es-US": {
    id: "es-US",
    sttLanguage: "es",
    intlLocale: "es-US",
    googleVoice: "es-US-Chirp3-HD-Aoede",
    ringTone: "us",
    twimlSayVoice: "Polly.Lupe",
    dateStyle: "DMY",
    currency: { code: "USD", symbol: "$", major: "dólares", minor: "centavos" },
    phone: { cc: "1", trunk: "", style: "nanp" },
    numberCountry: "US",
    stringsOverlay: null,
  },
};

export const DEFAULT_PROFILE_ID = "en-US";

/**
 * Look up a profile. Never throws and never returns undefined — an unknown id
 * is a configuration mistake, and refusing to speak is a worse answer to it
 * than speaking American.
 *
 * @param {string|null|undefined} id
 * @returns {typeof PROFILES["en-US"]}
 */
export function getProfile(id) {
  return PROFILES[id] || PROFILES[DEFAULT_PROFILE_ID];
}

/** Every id a business may be configured with (used by the schema CHECK). */
export const PROFILE_IDS = Object.keys(PROFILES);
