/**
 * The staging caller allowlist.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * The 6 -> 4 project merge put US and UK staging in one project, and the
 * compensating-control table for that merge says:
 *
 *   "Merged staging cannot be region-pinned, so 'no real caller data in
 *    staging' is only a rule — Staging never receives production Twilio
 *    credentials, probe/test numbers only, backed by a boot-time refusal for
 *    any caller number outside the test allowlist."
 *
 * That control was written down and never built. Staging is about to be handed
 * the same Twilio account the production number lives on, which means a real
 * patient misdialling by one digit could reach a staging build — and staging is
 * the one environment whose residency cannot be enforced and whose database is
 * not covered by the production backup or retention story.
 *
 * ---------------------------------------------------------------------------
 * The shape of the rule
 * ---------------------------------------------------------------------------
 *
 * `CALLER_ALLOWLIST` unset  -> no restriction. This is production, and refusing
 *                              real callers is the whole failure mode being
 *                              avoided. Absence must never mean "deny all".
 *
 * `CALLER_ALLOWLIST` set    -> only those numbers get a conversation. Everyone
 *                              else is answered politely and hung up on, and
 *                              the refusal is logged loudly.
 *
 * Deliberately NOT keyed off a "staging" flag. There is no reliable
 * environment marker in this codebase — DEPLOYMENT_MODE is about HIPAA, not
 * about staging — and inferring one from a project name or a URL is the kind of
 * guess that fails open. An operator who wants the restriction sets the list.
 *
 * Terraform sets it on staging services and leaves it unset in production, so
 * the two answers come from configuration rather than from detection.
 */

/**
 * Parse the allowlist from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ active: boolean, numbers: Set<string>, malformed: string[] }}
 */
export function callerAllowlist(env = process.env) {
  const raw = (env.CALLER_ALLOWLIST || "").trim();
  if (!raw) return { active: false, numbers: new Set(), malformed: [] };

  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const numbers = new Set();
  const malformed = [];

  for (const e of entries) {
    // E.164. Anything else is reported rather than silently normalised: Twilio
    // delivers `From` in E.164, so an entry in another format would never match
    // and the operator would see an allowlist that looks configured and admits
    // nobody.
    if (/^\+[1-9]\d{1,14}$/.test(e)) numbers.add(e);
    else malformed.push(e);
  }

  return { active: numbers.size > 0 || malformed.length > 0, numbers, malformed };
}

/**
 * Whether a caller may proceed.
 *
 * @param {string} from  Twilio's `From`, E.164.
 * @param {ReturnType<typeof callerAllowlist>} list
 * @returns {boolean}
 */
export function callerAllowed(from, list) {
  if (!list.active) return true;
  return list.numbers.has(String(from || "").trim());
}

/**
 * TwiML for a refused caller.
 *
 * Says something true and hangs up. It does NOT say "you are not on the
 * allowlist" — a stranger who misdialled learns nothing useful from that, and
 * a curious one learns that an allowlist exists.
 *
 * @returns {string}
 */
export function buildRefusedTwiml() {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    "<Say>This number is not in service. Goodbye.</Say>" +
    "<Hangup/>" +
    "</Response>"
  );
}
