/**
 * Shared "decline when disabled" guardrail.
 *
 * A capability that is turned OFF for a business must not just fall silent — the
 * receptionist should decline the request cleanly and offer the always-available
 * fallback (take a message or transfer). Every non-core pack emits this from its
 * prompt() when its capability is disabled, so disabling ANY capability behaves
 * the same way rather than each pack inventing its own (or nothing).
 *
 * Returns a single guardrail bullet terminated with a newline, matching the
 * shape of the other bullets spliced into the GUARDRAILS section.
 *
 * @param {string} label - what the assistant cannot do, phrased as a verb
 *   phrase, e.g. "book, check, cancel, or reschedule appointments".
 * @returns {string}
 */
export function declineGuardrail(label) {
  return (
    `- You cannot ${label} for this business. If a caller asks, briefly say you're ` +
    `not able to do that here and offer to take a message or transfer them instead.\n`
  );
}
