/**
 * Build TwiML for Gather (with optional nested Say) + Redirect.
 * Used for greeting or silent re-listen (skip Say when promptText is empty).
 * @param {string} voiceUrl - Full URL for action and redirect
 * @param {string} promptText - Text to speak inside the Gather (empty = silent listen)
 * @param {number} [timeoutSeconds] - Optional seconds to wait for input before re-POST (e.g. 10)
 * @returns {string} TwiML XML string
 */
export function buildGatherAndRedirect(voiceUrl, promptText, timeoutSeconds) {
  const sayTag = promptText
    ? `<Say voice="Polly.Joanna">${escapeXml(promptText)}</Say>`
    : "";
  const timeoutAttr = timeoutSeconds != null ? ` timeout="${timeoutSeconds}"` : "";
  return (
    `<Response><Gather input="speech" action="${voiceUrl}" method="POST" language="en-US" speechTimeout="auto"${timeoutAttr}>` +
    sayTag +
    `</Gather>` +
    `<Redirect method="POST">${voiceUrl}</Redirect></Response>`
  );
}

/**
 * Build TwiML for Say (reply) then Gather + Redirect.
 * Say is OUTSIDE Gather so the AI finishes speaking before listening (no false barge-in cutoffs).
 * @param {string} voiceUrl - Full URL for action and redirect
 * @param {string} sayText - The reply text to speak
 * @param {number} [timeoutSeconds] - Optional seconds to wait for input before re-POST (e.g. 10)
 * @returns {string} TwiML XML string
 */
export function buildSayGatherRedirect(voiceUrl, sayText, timeoutSeconds) {
  const timeoutAttr = timeoutSeconds != null ? ` timeout="${timeoutSeconds}"` : "";
  return (
    `<Response>` +
    `<Say voice="Polly.Joanna">${escapeXml(sayText)}</Say>` +
    `<Gather input="speech" action="${voiceUrl}" method="POST" language="en-US" speechTimeout="auto"${timeoutAttr}>` +
    `</Gather>` +
    `<Redirect method="POST">${voiceUrl}</Redirect></Response>`
  );
}

/**
 * Build TwiML for a final Say + Hangup. Used for graceful goodbye.
 * @param {string} sayText - Goodbye message
 * @returns {string} TwiML XML string
 */
export function buildSayAndHangup(sayText) {
  return (
    `<Response><Say voice="Polly.Joanna">${escapeXml(sayText)}</Say><Hangup/></Response>`
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
