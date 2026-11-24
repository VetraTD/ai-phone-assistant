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
  saveGuard: true,
});

/**
 * @param {"askBeforeHangup"|"spellingNudge"|"gatherDetailsFallback"|"saveGuard"} name
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

/**
 * S3-3 (spec §12.2): the three PLATFORM capability packs -- `outcome`
 * (set_call_outcome), `callback` (schedule_callback) and `opt_out` (opt_out).
 * "Platform" rather than "tenant": every other pack's tools survive the
 * outbound campaign-capability filter (services/gemini.js
 * filterForOutboundCampaign, services/tools.js's execution-time mirror of it)
 * only when the CAMPAIGN's own `capabilities` list names them. These three
 * are unioned in unconditionally on every outbound call regardless of what a
 * campaign lists -- a call Ava placed always needs a way to close it out,
 * offer a callback, and honour a stop-calling request -- and are excluded
 * from every inbound call, whatever a business's own config says, because
 * neither the tools nor the columns they write (calls.outcome_code,
 * calls.answers, the do-not-call suppression list) have any inbound meaning.
 *
 * A frozen array, not a Set, because both call sites read it as
 * `PLATFORM_PACKS.includes(pack.id)` and an array reads better at the call
 * site than `new Set([...]).has(...)` for three elements.
 */
export const PLATFORM_PACKS = Object.freeze(["outcome", "callback", "opt_out"]);
