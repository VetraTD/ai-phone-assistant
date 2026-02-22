/**
 * Build TwiML for Gather (with nested Say) + Redirect. Used for greeting or "Go ahead" loop.
 * @param {string} voiceUrl - Full URL for action and redirect (e.g. BASE_URL + '/twilio/voice')
 * @param {string} promptText - Text to speak inside the Gather
 * @returns {string} TwiML XML string
 */
export function buildGatherAndRedirect(voiceUrl, promptText) {
  return (
    `<Response><Gather input="speech" action="${voiceUrl}" method="POST" language="en-US" speechTimeout="auto">` +
    `<Say voice="Polly.Joanna">${escapeXml(promptText)}</Say></Gather>` +
    `<Redirect method="POST">${voiceUrl}</Redirect></Response>`
  );
}

/**
 * Build TwiML for Say (reply) + Gather + Redirect. Used after Gemini responds.
 * @param {string} voiceUrl - Full URL for action and redirect
 * @param {string} sayText - The reply text to speak
 * @returns {string} TwiML XML string
 */
export function buildSayGatherRedirect(voiceUrl, sayText) {
  return (
    `<Response><Say voice="Polly.Joanna">${escapeXml(sayText)}</Say>` +
    `<Gather input="speech" action="${voiceUrl}" method="POST" language="en-US" speechTimeout="auto">` +
    `<Say voice="Polly.Joanna">Go ahead.</Say></Gather>` +
    `<Redirect method="POST">${voiceUrl}</Redirect></Response>`
  );
}


/**
 * Build TwiML for Play (mp3) + Gather + Redirect. Used when ElevenLabs TTS is enabled.
 * @param {string} voiceUrl - Full URL for action and redirect
 * @param {string} audioUrl - Public URL to an MP3 file
 * @returns {string} TwiML XML string
 */
export function buildPlayGatherRedirect(voiceUrl, audioUrl) {
  return (
    `<Response>` +
    `<Play>${escapeXml(audioUrl)}</Play>` +
    `<Gather input="speech" action="${voiceUrl}" method="POST" language="en-US" speechTimeout="auto">` +
    `<Say voice="Polly.Joanna">Go ahead.</Say></Gather>` +
    `<Redirect method="POST">${voiceUrl}</Redirect>` +
    `</Response>`
  );
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
