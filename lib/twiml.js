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
// Shared builders — transfers and taking a message
// ---------------------------------------------------------------------------

/** Lines Twilio itself speaks (outside the AI session). English only for now. */
export const CALL_LINES = Object.freeze({
  noAnswer: "Sorry, nobody could get to the phone. Please leave your name, number and a short message after the tone.",
  cantTransfer: "Sorry, I can't put you through right now. Please leave your name, number and a short message after the tone.",
  technical: "I'm sorry, we're having a technical problem. Please leave your name, number and a short message after the tone, and the team will get back to you.",
  technicalOutbound: "I'm sorry, we're having a technical problem. We'll be in touch. Goodbye.",
  timeUp: "I'm sorry, we've reached the time limit for this call. Thank you for calling. Goodbye.",
});

/** Where Twilio posts a finished recording (files it as a message for the business). */
export function voicemailCallbackUrl(baseUrl, twilioNumber) {
  return `${baseUrl}/twilio/voicemail?to=${encodeURIComponent(twilioNumber || "")}`;
}

/** The Record verb's action: ends the call once the caller has left their message. */
export function messageDoneUrl(baseUrl) {
  return `${baseUrl}/twilio/message-done`;
}

/**
 * Dial a human. callerId is omitted entirely when falsy (never callerId="").
 * @returns {string} TwiML XML string
 */
export function buildTransferTwiml({ number, callerId, ringTone, timeoutSec = 20, actionUrl, timeLimitSec = 3600 }) {
  const callerIdAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : "";
  return (
    `<Response>` +
    `<Dial ringTone="${escapeXml(ringTone)}" timeout="${escapeXml(String(timeoutSec))}" timeLimit="${escapeXml(String(timeLimitSec))}" action="${escapeXml(actionUrl)}" method="POST"${callerIdAttr}>` +
    `${escapeXml(number)}</Dial>` +
    `</Response>`
  );
}

/**
 * LVX174: the line's recorded clip (lib/voice/fixedLines.js) when one is ready,
 * else the line said in Polly exactly as before.
 */
function lineVerb(line, sayVoice, playUrl) {
  if (playUrl) return `<Play>${escapeXml(playUrl)}</Play>`;
  return `<Say voice="${escapeXml(sayVoice || DEFAULT_VOICE)}">${buildSayContent(line)}</Say>`;
}

/**
 * Say a line, take a message, hang up. Both URLs are required: a Record verb
 * with no action makes Twilio re-request the current document when the
 * recording ends, which replays the line and records again in a loop.
 * @returns {string} TwiML XML string
 */
export function buildMessageTwiml({ line, sayVoice, playUrl, callbackUrl, actionUrl, maxLengthSec = 120 }) {
  if (!actionUrl) throw new TypeError("buildMessageTwiml: actionUrl is required");
  if (!callbackUrl) throw new TypeError("buildMessageTwiml: callbackUrl is required");
  return (
    `<Response>` +
    lineVerb(line, sayVoice, playUrl) +
    `<Record maxLength="${escapeXml(String(maxLengthSec))}" playBeep="true" action="${escapeXml(actionUrl)}" recordingStatusCallback="${escapeXml(callbackUrl)}"/>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/** Say a line, then hang up. */
export function buildHangupLineTwiml({ line, sayVoice, playUrl }) {
  return (
    `<Response>` +
    lineVerb(line, sayVoice, playUrl) +
    `<Hangup/>` +
    `</Response>`
  );
}

// ---------------------------------------------------------------------------
// Degraded mode — voicemail-only fallback
// ---------------------------------------------------------------------------

/**
 * Build TwiML for the degraded-mode voicemail fallback: apologize, record
 * a message, then hang up. Used by /twilio/voice when the real-time voice
 * pipeline's dependencies (STT/TTS) are known to be down (see lib/voice/health.js).
 * @param {string} recordingStatusCallbackUrl - Full URL Twilio POSTs to when the recording finishes
 * @param {string} actionUrl - Full URL Twilio requests when the recording ends (see messageDoneUrl)
 * @returns {string} TwiML XML string
 */
export function buildDegradedVoicemailTwiml(recordingStatusCallbackUrl, actionUrl) {
  const apology =
    "We're sorry — we're experiencing technical difficulties. " +
    "Please leave your name, number, and a brief message after the tone.";
  return buildMessageTwiml({
    line: apology,
    sayVoice: DEFAULT_VOICE,
    callbackUrl: recordingStatusCallbackUrl,
    actionUrl,
  });
}

// ---------------------------------------------------------------------------
// Unrouted calls — the dialed number matches no business
// ---------------------------------------------------------------------------
//
// Previously this case connected the media stream anyway and ran the assistant
// on loadConfig(null): it greeted the caller as "our office", described itself
// as a generic virtual receptionist, offered appointment booking that refused
// at execution, and told callers "I'll make sure they get your message" while
// writing nothing to any database and notifying nobody (businessId is null, so
// capabilities/messages.js returns early).
//
// An assistant that cannot identify the business it is answering for should not
// answer for it. Hand the caller to a human, or take a message honestly.

/**
 * Forward an unrouted call to a human.
 *
 * The original caller's number is passed through as callerId so whoever picks
 * up sees who is actually calling, matching redialForTransfer in
 * lib/voice/session.js.
 *
 * @param {string} transferNumber - E.164 number to dial
 * @param {string} [callerNumber] - the caller's own number, for caller ID
 * @param {string} [ringTone="us"] - Twilio ring-tone locale
 * @returns {string} TwiML XML string
 */
export function buildUnroutedTransferTwiml(transferNumber, callerNumber = "", ringTone = "us", sayVoice = DEFAULT_VOICE) {
  const apology = "One moment — I'm connecting you now.";
  const callerIdAttr = callerNumber ? ` callerId="${escapeXml(callerNumber)}"` : "";
  return (
    `<Response>` +
    `<Say voice="${escapeXml(sayVoice)}">${buildSayContent(apology)}</Say>` +
    `<Dial ringTone="${escapeXml(ringTone)}" timeLimit="3600"${callerIdAttr}>${escapeXml(transferNumber)}</Dial>` +
    `</Response>`
  );
}

/**
 * Take a message for an unrouted call, when no human number is configured.
 *
 * The wording deliberately does NOT claim a specific business will call back —
 * we do not know which business this is, and promising a callback we cannot
 * route is the failure mode this whole path exists to remove.
 *
 * @param {string} recordingStatusCallbackUrl - Full URL Twilio POSTs to when the recording finishes
 * @param {string} [sayVoice] - Twilio Say voice
 * @param {string} actionUrl - Full URL Twilio requests when the recording ends (see messageDoneUrl)
 * @returns {string} TwiML XML string
 */
export function buildUnroutedVoicemailTwiml(recordingStatusCallbackUrl, sayVoice = DEFAULT_VOICE, actionUrl) {
  const apology =
    "Sorry — I can't connect you to this office right now. " +
    "Please leave your name, number, and a brief message after the tone, and someone will get back to you.";
  return buildMessageTwiml({
    line: apology,
    sayVoice,
    callbackUrl: recordingStatusCallbackUrl,
    actionUrl,
  });
}
