// lib/outbound/policy.js
/**
 * S3-1 (spec §19, S3-D1): outbound gets its own conversation layer. A handful
 * of INBOUND habits -- the LVX132 ask-before-hangup gate (services/tools.js),
 * the spelling nudge (lib/voice/live/index.js), and the gather_details/
 * confirm ask-gate fallback text (services/gemini.js) -- must never leak onto
 * a call Ava placed: she already knows why she is calling and who she dialled,
 * so "is there anything else I can help with?" and "let me get your number"
 * are backwards on that call, not merely optional.
 *
 * `skipOnOutbound` is the single, frozen switchboard every one of those call
 * sites reads, so the list of what is inbound-only lives in exactly one
 * place rather than being re-derived (and re-typo'd) at each site.
 *
 * FAILS CLOSED ON A TYPO (memory plan-verbatim-code-fails-open). A name that
 * is not in `INBOUND_ONLY` THROWS rather than returning false -- a call site
 * that misspells the name it asks for must not silently keep behaving as
 * though the question were never asked at all, which is what a bare `return
 * false` would do.
 *
 * FAILS CLOSED ON THE ARGUMENT TYPE TOO. `isOutbound` must be the literal
 * boolean `true` to skip anything; a stray truthy non-boolean (an object, a
 * call bag someone forgot to `Boolean(...)` first) is treated as NOT
 * outbound, because the safe direction for every one of these three habits
 * is "keep the inbound guard armed", not "assume outbound and drop it".
 */

/** The three inbound-only habits this task moves behind the switch. */
export const INBOUND_ONLY = Object.freeze({
  askBeforeHangup: true,
  spellingNudge: true,
  gatherDetailsFallback: true,
});

/**
 * @param {"askBeforeHangup"|"spellingNudge"|"gatherDetailsFallback"} name
 * @param {boolean} isOutbound
 * @returns {boolean} true only when `isOutbound === true` AND `name` names a
 *   frozen inbound-only habit. Throws on any other `name`.
 */
export function skipOnOutbound(name, isOutbound) {
  if (!Object.prototype.hasOwnProperty.call(INBOUND_ONLY, name)) {
    throw new Error(`skipOnOutbound: unknown name "${name}" (expected one of ${Object.keys(INBOUND_ONLY).join(", ")})`);
  }
  return isOutbound === true;
}
