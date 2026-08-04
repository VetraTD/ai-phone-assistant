import { isValidE164 } from "../validate.js";

// ---------------------------------------------------------------------------
// The gate in front of automated outbound dialling.
//
// scripts/latency-probe.js places real, billable calls in a loop. Each check
// here exists because the failure it prevents is expensive or hard to undo:
// dialling a number that isn't ours, dialling far more times than intended, or
// dialling at all when the operator only wanted to see the plan.
//
// Deliberately a pure function returning a value. Nothing dials until a caller
// acts on the plan, so the decision to place calls is reviewable, testable,
// and printable without side effects.
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on calls per run. Not a preference — a backstop against a loop
 * bug or a fat-fingered --calls turning into a phone bill.
 */
export const MAX_CALLS = 25;

/** Twilio US voice, inbound+outbound are billed separately (2026 list price). */
const PER_MINUTE_USD = 0.0085;

/** Default assumption for the fixed 8-turn script, used for the estimate only. */
const DEFAULT_MINUTES_PER_CALL = 2.5;

/**
 * Validate a probe run and describe exactly what it would do.
 *
 * @param {object} opts
 * @param {string} opts.to - number to dial (must equal assistantNumber)
 * @param {string} opts.from - originating Twilio number
 * @param {string} opts.assistantNumber - the only permitted destination
 * @param {string} opts.baseUrl - https base url of the server under test
 * @param {string} opts.debugToken - shared secret for the probe/stats endpoints
 * @param {number} opts.calls - how many calls to place
 * @param {boolean} opts.confirm - explicit go-ahead; without it this is a dry run
 * @param {number} [opts.minutesPerCall]
 * @returns {{ok: boolean, dryRun: boolean, reason: string|null, calls: number,
 *   to: string, from: string, streamUrl: string, billedMinutes: number,
 *   perMinuteUsd: number, estimatedCostUsd: number, summary: string}}
 */
export function buildDialPlan({
  to = "",
  from = "",
  assistantNumber = "",
  baseUrl = "",
  debugToken = "",
  calls = 0,
  confirm = false,
  minutesPerCall = DEFAULT_MINUTES_PER_CALL,
} = {}) {
  // Both legs of a bridged test call are billed, so the estimate doubles.
  const billedMinutes = Math.max(0, calls) * minutesPerCall * 2;
  const estimatedCostUsd = billedMinutes * PER_MINUTE_USD;

  const wsBase = baseUrl.replace(/^https/, "wss").replace(/\/$/, "");
  const streamUrl = `${wsBase}/twilio/probe-stream?token=${encodeURIComponent(debugToken)}`;

  // Never interpolate the token: this string gets printed and pasted around,
  // and it is a live credential for a publicly reachable endpoint.
  const summary =
    `${calls} call(s) to ${to} from ${from}, ~${minutesPerCall} min each, ` +
    `${billedMinutes} billed minutes (both legs), ~$${estimatedCostUsd.toFixed(2)}.`;

  const base = {
    dryRun: !confirm,
    calls,
    to,
    from,
    streamUrl,
    billedMinutes,
    perMinuteUsd: PER_MINUTE_USD,
    estimatedCostUsd,
    summary,
  };

  const deny = (reason) => ({ ...base, ok: false, reason });

  if (!assistantNumber) return deny("No assistant number configured (ASSISTANT_NUMBER).");
  if (!isValidE164(assistantNumber)) return deny("ASSISTANT_NUMBER is not valid E.164.");
  if (!isValidE164(to)) return deny("Destination number is not valid E.164.");
  if (!isValidE164(from)) return deny("Originating number (PROBE_NUMBER) is not valid E.164.");

  // The allowlist. One comparison, and the reason this script cannot ring a
  // stranger no matter what is in the environment.
  if (to !== assistantNumber) {
    return deny(`Destination ${to} is not on the allowlist (assistant number is ${assistantNumber}).`);
  }
  if (from === to) {
    return deny("Cannot dial from the same number being called — the legs cannot bridge.");
  }

  if (!Number.isInteger(calls) || calls <= 0) return deny("Call count must be a positive integer.");
  if (calls > MAX_CALLS) return deny(`Call count ${calls} exceeds the hard cap of ${MAX_CALLS}.`);

  if (!debugToken) return deny("DEBUG_TOKEN is required — the probe endpoint refuses without it.");
  if (!baseUrl.startsWith("https://")) {
    return deny("BASE_URL must be https:// so the media stream can connect over wss://.");
  }

  // Everything is valid; the only thing left is whether the operator said go.
  if (!confirm) {
    return { ...base, ok: false, reason: "Dry run — pass --confirm to place real calls." };
  }

  return { ...base, ok: true, reason: null };
}
