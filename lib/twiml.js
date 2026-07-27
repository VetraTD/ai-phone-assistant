import { expandAbbreviations } from "./voice/speakableText.js";

const DEFAULT_VOICE = "Polly.Joanna";

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
 * Build SSML Say tag content. Escapes text for XML safety, then injects
 * SSML break tags for natural pacing.
 *
 * expandAbbreviations lives in lib/voice/speakableText.js (single source —
 * it's also run as part of toSpeakable() for the ElevenLabs path). Calling
 * it here is safe even when the incoming `text` has already been through
 * toSpeakable() upstream (the main LLM-reply path, via ttsStream's Google
 * fallback): the expansion is idempotent — "Dr. Smith" has no "Dr." left in
 * it to re-match — so this is the correct single expansion point for fixed
 * strings (greeting/nudge/goodbye, which do NOT go through toSpeakable) and
 * a harmless no-op re-application for anything that already did.
 * @param {string} text - Raw text to speak
 * @returns {string} Safe content for inside a <Say> tag
 */
export function buildSayContent(text) {
  const expanded = expandAbbreviations(text);
  // Then escape for XML safety
  const escaped = escapeXml(expanded);
  // Then inject SSML breaks (these use < and > intentionally — they're SSML, not user content)
  return addSsmlBreaks(escaped);
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

// ---------------------------------------------------------------------------
// Degraded mode — voicemail-only fallback
// ---------------------------------------------------------------------------

/**
 * Build TwiML for the degraded-mode voicemail fallback: apologize, record
 * a message, then hang up. Used by /twilio/voice when the real-time voice
 * pipeline's dependencies (STT/TTS) are known to be down (see lib/voice/health.js).
 * @param {string} recordingStatusCallbackUrl - Full URL Twilio POSTs to when the recording finishes
 * @returns {string} TwiML XML string
 */
export function buildDegradedVoicemailTwiml(recordingStatusCallbackUrl) {
  const apology =
    "We're sorry — we're experiencing technical difficulties. " +
    "Please leave your name, number, and a brief message after the tone.";
  return (
    `<Response>` +
    `<Say voice="${DEFAULT_VOICE}">${buildSayContent(apology)}</Say>` +
    `<Record maxLength="120" recordingStatusCallback="${escapeXml(recordingStatusCallbackUrl)}" />` +
    `<Hangup/>` +
    `</Response>`
  );
}
