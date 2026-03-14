const DEFAULT_VOICE = "Polly.Joanna";

// ---------------------------------------------------------------------------
// Twilio language codes for STT (speech-to-text) — maps BCP-47 language tags
// to Twilio-supported Gather language values.
// ---------------------------------------------------------------------------

const LANGUAGE_MAP = {
  en: "en-US",
  es: "es-MX",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  ar: "ar-SA",
  hi: "hi-IN",
  ru: "ru-RU",
  vi: "vi-VN",
  tl: "tl-PH",
  pl: "pl-PL",
  nl: "nl-NL",
};

/**
 * Resolve a Twilio Gather language attribute from a BCP-47 code or array.
 * @param {string|string[]} [lang] - e.g. "es", "en-US", or ["en","es"]
 * @returns {string} Twilio language code (default "en-US")
 */
function resolveLanguage(lang) {
  const primary = Array.isArray(lang) ? lang[0] : lang;
  if (!primary || typeof primary !== "string") return "en-US";
  // If it already looks like a full locale (e.g. "es-MX"), use it
  if (primary.includes("-")) return primary;
  return LANGUAGE_MAP[primary.toLowerCase()] || "en-US";
}

// ---------------------------------------------------------------------------
// SSML helpers — inject natural pauses between sentences
// ---------------------------------------------------------------------------

/**
 * Add SSML breaks between sentences so TTS sounds more natural.
 * Converts plain text to SSML by inserting <break> tags at sentence boundaries.
 * Only processes text that doesn't already contain SSML tags.
 * @param {string} text - Plain text from the AI
 * @returns {string} SSML-ready text (still needs to be wrapped in <speak>)
 */
function addSsmlBreaks(text) {
  if (!text || typeof text !== "string") return text || "";
  // Don't process if it already contains SSML tags
  if (/<break|<prosody|<say-as|<speak/i.test(text)) return text;

  // Insert a short pause after sentence-ending punctuation followed by a space
  // This makes the TTS sound more natural — like a real person pausing between thoughts
  return text.replace(/([.!?])\s+/g, "$1<break time=\"300ms\"/> ");
}

/**
 * Expand common abbreviations so TTS reads them naturally.
 * e.g. "Dr. Smith" → "Doctor Smith" (avoids TTS reading "Dr." as "drive")
 * @param {string} text
 * @returns {string}
 */
function expandAbbreviations(text) {
  if (!text || typeof text !== "string") return text || "";
  return text
    .replace(/\bDr\.\s+([A-Z])/g, "Doctor $1")
    .replace(/\bMr\.\s+([A-Z])/g, "Mister $1")
    .replace(/\bMrs\.\s+([A-Z])/g, "Missus $1")
    .replace(/\bMs\.\s+([A-Z])/g, "Ms $1")
    .replace(/\bSt\.\s+([A-Z])/g, "Saint $1");
}

/**
 * Build SSML Say tag content. Escapes text for XML safety, then injects
 * SSML break tags for natural pacing.
 * @param {string} text - Raw text to speak
 * @returns {string} Safe content for inside a <Say> tag
 */
function buildSayContent(text) {
  // Expand abbreviations before XML escaping so TTS reads them naturally
  const expanded = expandAbbreviations(text);
  // Then escape for XML safety
  const escaped = escapeXml(expanded);
  // Then inject SSML breaks (these use < and > intentionally — they're SSML, not user content)
  return addSsmlBreaks(escaped);
}

// ---------------------------------------------------------------------------
// TwiML builders
// ---------------------------------------------------------------------------

/**
 * Build TwiML for Gather (with optional nested Say) + Redirect.
 * Used for greeting or silent re-listen (skip Say when promptText is empty).
 * @param {string} voiceUrl - Full URL for action and redirect
 * @param {string} promptText - Text to speak inside the Gather (empty = silent listen)
 * @param {number} [timeoutSeconds] - Optional seconds to wait for input before re-POST
 * @param {object} [opts] - Optional { voice, language, bargeIn }
 * @returns {string} TwiML XML string
 */
export function buildGatherAndRedirect(voiceUrl, promptText, timeoutSeconds, opts) {
  const voice = opts?.voice || DEFAULT_VOICE;
  const lang = resolveLanguage(opts?.language);
  const sayTag = promptText
    ? `<Say voice="${voice}">${buildSayContent(promptText)}</Say>`
    : "";
  const timeoutAttr = timeoutSeconds != null ? ` timeout="${timeoutSeconds}"` : "";
  return (
    `<Response><Gather input="speech" action="${voiceUrl}" method="POST" language="${lang}" speechTimeout="auto"${timeoutAttr}>` +
    sayTag +
    `</Gather>` +
    `<Redirect method="POST">${voiceUrl}</Redirect></Response>`
  );
}

/**
 * Build TwiML for Say (reply) then Gather + Redirect.
 * By default, Say is OUTSIDE Gather so the AI finishes speaking before listening
 * (no false barge-in cutoffs). When opts.bargeIn is true, Say is INSIDE Gather
 * so the caller can interrupt.
 * Optionally prepend a short Play (e.g. typing sound) before the Say.
 * @param {string} voiceUrl - Full URL for action and redirect
 * @param {string} sayText - The reply text to speak
 * @param {number} [timeoutSeconds] - Optional seconds to wait for input before re-POST
 * @param {string} [typingSoundUrl] - Optional URL of a short (1-2s) audio to play before the reply
 * @param {object} [opts] - Optional { voice, language, bargeIn }
 * @returns {string} TwiML XML string
 */
export function buildSayGatherRedirect(voiceUrl, sayText, timeoutSeconds, typingSoundUrl, opts) {
  const voice = opts?.voice || DEFAULT_VOICE;
  const lang = resolveLanguage(opts?.language);
  const bargeIn = opts?.bargeIn === true;
  const timeoutAttr = timeoutSeconds != null ? ` timeout="${timeoutSeconds}"` : "";
  const playTag =
    typingSoundUrl && typeof typingSoundUrl === "string" && typingSoundUrl.trim()
      ? `<Play>${escapeXml(typingSoundUrl.trim())}</Play>`
      : "";
  const sayContent = buildSayContent(sayText);

  if (bargeIn) {
    // Caller can interrupt: Say is INSIDE Gather
    return (
      `<Response>` +
      playTag +
      `<Gather input="speech" action="${voiceUrl}" method="POST" language="${lang}" speechTimeout="auto"${timeoutAttr}>` +
      `<Say voice="${voice}">${sayContent}</Say>` +
      `</Gather>` +
      `<Redirect method="POST">${voiceUrl}</Redirect></Response>`
    );
  }

  // Default: Say is OUTSIDE Gather (AI finishes before listening)
  return (
    `<Response>` +
    playTag +
    `<Say voice="${voice}">${sayContent}</Say>` +
    `<Gather input="speech" action="${voiceUrl}" method="POST" language="${lang}" speechTimeout="auto"${timeoutAttr}>` +
    `</Gather>` +
    `<Redirect method="POST">${voiceUrl}</Redirect></Response>`
  );
}

/**
 * Build TwiML for a final Say + Hangup. Used for graceful goodbye.
 * @param {string} sayText - Goodbye message
 * @param {object} [opts] - Optional { voice }
 * @returns {string} TwiML XML string
 */
export function buildSayAndHangup(sayText, opts) {
  const voice = opts?.voice || DEFAULT_VOICE;
  return (
    `<Response><Say voice="${voice}">${buildSayContent(sayText)}</Say><Hangup/></Response>`
  );
}

/**
 * Build TwiML to say a message then dial (transfer) to a real phone number.
 * @param {string} sayText - Short message before transfer (e.g. "Transferring you now.")
 * @param {string} phoneNumber - E.164 phone number to dial
 * @param {object} [opts] - Optional { voice }
 * @returns {string} TwiML XML string
 */
export function buildSayAndDial(sayText, phoneNumber, opts) {
  const voice = opts?.voice || DEFAULT_VOICE;
  return (
    `<Response>` +
    `<Say voice="${voice}">${buildSayContent(sayText)}</Say>` +
    `<Dial>${escapeXml(phoneNumber)}</Dial>` +
    `</Response>`
  );
}

/**
 * Build TwiML that plays brief hold audio then redirects back.
 * Used to give the caller immediate audio feedback while the server
 * processes a Gemini request in parallel.
 * @param {string} voiceUrl - URL to redirect to after hold audio
 * @param {string} [typingSoundUrl] - Optional audio file URL; falls back to a short spoken "One moment"
 * @param {object} [opts] - Optional { voice }
 * @returns {string} TwiML XML string
 */
export function buildHoldAndRedirect(voiceUrl, typingSoundUrl, opts) {
  const voice = opts?.voice || DEFAULT_VOICE;
  const audio =
    typingSoundUrl && typeof typingSoundUrl === "string" && typingSoundUrl.trim()
      ? `<Play>${escapeXml(typingSoundUrl.trim())}</Play>`
      : `<Pause length="1"/>`;
  return `<Response>${audio}<Redirect method="POST">${voiceUrl}</Redirect></Response>`;
}

/**
 * Escape text for use inside XML (TwiML) content.
 * @param {string} s - Raw string
 * @returns {string} XML-safe string
 */
export function escapeXml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
