// lib/outbound/amd.js
/**
 * The async AMD verdict -> what to do (spec §9.4, Task 13). Pure and
 * synchronous: the route (doorRoutes.js) does all the I/O -- recording the
 * verdict, fetching the voicemail clip, the Twilio REST redirect -- this
 * just maps Twilio's `AnsweredBy` to one of the spec's four outcomes.
 *
 * `voicemailPermitted` is the SAME "which compliance classes may leave a
 * voicemail" rule dispatch.js's line-rendering (§9.3 step 1, O-4) has to ask
 * too, so both places that ask the question read it off one definition
 * rather than risking two copies that drift.
 */

/**
 * Compliance classes a voicemail message may be left under (spec §9.4,
 * §13.1: "solicited and service do"). `marketing_consented` is a value the
 * schema recognises but Part 1 refuses at campaign save
 * (campaignSchema.js's REFUSED_IN_PART1), so it is deliberately absent here
 * too -- an attempt cannot reach dispatch under that class in Part 1, but if
 * one somehow did, this still says no.
 */
const VOICEMAIL_PERMITTED_CLASSES = new Set(["solicited", "service"]);

/** @param {string} complianceClass @returns {boolean} */
export function voicemailPermitted(complianceClass) {
  return VOICEMAIL_PERMITTED_CLASSES.has(complianceClass);
}

/** The three `AnsweredBy` values DetectMessageEnd reports for a machine's greeting ending (spec §9.4) -- as opposed to `machine_start` (mid-greeting) or `fax`. */
export function isMachineEnd(answeredBy) {
  return answeredBy === "machine_end_beep" || answeredBy === "machine_end_silence" || answeredBy === "machine_end_other";
}

/**
 * The seven values `call_attempts.answered_by`'s CHECK constraint allows
 * (database/schema.sql) -- the same set `decideAmd`'s switch below matches.
 */
export const ANSWERED_BY_VALUES = Object.freeze([
  "human",
  "unknown",
  "machine_start",
  "machine_end_beep",
  "machine_end_silence",
  "machine_end_other",
  "fax",
]);

/**
 * Fix round 1 (IMPORTANT 1). Twilio's AnsweredBy is a closed set in
 * practice, but nothing enforces that at the HTTP boundary -- a malformed
 * callback, or some future Twilio value this code doesn't know about yet,
 * would otherwise be written straight into `answered_by`, whose CHECK
 * constraint would refuse it and throw. Writing that value BLIND would turn
 * "an AMD verdict we don't recognise" into a 500 Twilio retries forever
 * (Twilio never stops retrying a non-2xx async AMD callback), with no verdict
 * ever recorded.
 *
 * Ruling: normalise to "unknown" before it is ever written or decided on.
 * "unknown" already has safe, existing handling both here (decideAmd ->
 * `none`, "record the value and change nothing") and at the DB layer (a
 * valid CHECK value) -- reusing it is cheaper and no less honest than
 * inventing an eighth stored value for "we don't know either", which is
 * exactly what Twilio's own "unknown" already means. The caller (doorRoutes.js)
 * logs the RAW value alongside the normalised one, so the information is not
 * lost, only kept out of the column a CHECK constraint governs.
 *
 * @param {unknown} answeredBy
 * @returns {string} one of ANSWERED_BY_VALUES
 */
export function normalizeAnsweredBy(answeredBy) {
  return ANSWERED_BY_VALUES.includes(answeredBy) ? answeredBy : "unknown";
}

/**
 * Decide what an async AMD callback means for this attempt (spec §9.4).
 *
 * @param {{
 *   answeredBy: string|null,
 *   attemptNo: number|undefined,
 *   voicemailOn: number[]|undefined,
 *   complianceClass: string|undefined,
 * }} args
 * @returns {{action: "none"|"voicemail"|"hangup"|"wait", result?: "voicemail_left"|"voicemail_skipped"|"failed"}}
 */
export function decideAmd({ answeredBy, attemptNo, voicemailOn, complianceClass }) {
  switch (answeredBy) {
    case "human":
    case "unknown":
      // "record the value and change nothing" (spec §9.4).
      return { action: "none" };

    case "machine_start":
      // DetectMessageEnd guarantees a machine_end_* follows -- nothing to do
      // yet but wait for it.
      return { action: "wait" };

    case "machine_end_beep":
    case "machine_end_silence":
    case "machine_end_other": {
      const due = Array.isArray(voicemailOn) && voicemailOn.includes(attemptNo);
      if (due && voicemailPermitted(complianceClass)) {
        return { action: "voicemail", result: "voicemail_left" };
      }
      return { action: "hangup", result: "voicemail_skipped" };
    }

    case "fax":
      return { action: "hangup", result: "failed" };

    default:
      // Twilio's AnsweredBy is a closed set -- the seven values named by the
      // CHECK constraint on call_attempts.answered_by. Anything else is a
      // malformed or missing callback: fail toward doing nothing rather than
      // guessing at a hangup or a voicemail redirect for a call this cannot
      // classify.
      return { action: "none" };
  }
}
