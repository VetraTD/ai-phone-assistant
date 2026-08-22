/**
 * Field names that carry PHI, or a personal identifier under GDPR.
 *
 * One list, two consumers, deliberately:
 *   - lib/logger.js redacts these at emit time, so a leak that ships is inert.
 *   - tests/logPhiLint.test.js fails the build when one appears in a logger or
 *     error-tracker call, so a leak does not ship in the first place.
 *
 * The static check is the one that matters. Redaction at runtime is a safety
 * net, and a safety net that people rely on becomes the floor — the point of
 * the lint is that the author finds out, not the log sink.
 *
 * Why a DENYLIST here when lib/sentry.js uses an allowlist. The error tracker
 * takes a handful of correlation tags and an allowlist of seven keys covers it.
 * The logger takes open-ended, event-specific structure — timings, tool names,
 * hold reasons, token counts — and an allowlist would be hundreds of entries
 * long, fought constantly, and eventually widened to `*` by someone in a hurry.
 * Naming the things that are dangerous is the workable shape for this one, and
 * the lint is what stops the list going stale: a new PHI field only escapes if
 * nobody adds it here AND nobody reviews the call.
 *
 * NOT on this list, and each for a reason:
 *   message        every `catch` logs `{ message: err?.message }`, and
 *                  lib/logger.js reads `fields.message` to build its
 *                  human-readable line. Listing it would redact the entire
 *                  error-reporting path.
 *   businessPhone  the tenant's own published line. It identifies the covered
 *                  entity, which is the log's subject, not a patient.
 *   callSid        a Twilio identifier for a call. It resolves to a person only
 *                  through the database, and it is the correlation key the whole
 *                  logging and tracing story is built on.
 */
export const PHI_FIELD_NAMES = Object.freeze([
  // Who called, and how to reach them
  "callerPhone",
  "caller_phone",
  "callerNumber",
  "caller_number",
  "callerName",
  "caller_name",
  "callbackNumber",
  "callback_number",
  "clientName",
  "client_name",
  "clientPhone",
  "client_phone",
  "patientName",
  "patient_name",
  "toNumber",
  "phone",
  "email",
  "address",
  "dob",
  "dateOfBirth",
  "date_of_birth",
  // What they said, or what was said about them
  "notes",
  "transcript",
  "summary",
  "subject",
  "preferredTime",
  "preferred_time",
]);

const SET = new Set(PHI_FIELD_NAMES);

/** @param {string} name @returns {boolean} */
export function isPhiField(name) {
  return SET.has(name);
}

/** What a redacted value is replaced with. Recognisable, and not mistakable for data. */
export const REDACTED = "[redacted:phi]";
