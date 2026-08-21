import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN || "";

if (dsn) {
  Sentry.init({ dsn });
}

/** Whether Sentry is active (DSN was provided). */
export const enabled = !!dsn;

/**
 * Context keys allowed to leave the process as error-tracker tags.
 *
 * An ALLOWLIST, not a denylist, and that is the whole design. A denylist has to
 * be updated every time somebody invents a field name, and it is wrong in the
 * silent direction: the first time a new PHI-bearing key is passed, it ships.
 * This fails closed instead — a key nobody has thought about is dropped.
 *
 * Every entry here is a correlation handle rather than a fact about a person:
 *   callSid / requestId  identify a call and a webhook invocation
 *   businessId           identifies the TENANT, not a patient
 *   context / table / op  say where in the code the failure happened
 *   kind                 the template name for an SMS ("missed_call"), not its text
 *
 * What this deliberately excludes, because it was actually being sent:
 * `to` and `subject` from the notification senders, and `toNumber` — a
 * recipient address, a subject line reading "New appointment: Tue Mar 4,
 * 3:30 PM — Jane Q Patient", and the caller's phone number.
 */
const ALLOWED_CONTEXT_KEYS = new Set([
  "callSid",
  "requestId",
  "businessId",
  "context",
  "table",
  "op",
  "kind",
]);

/**
 * Sentry tags are indexed, so an unbounded value is both a cost and a way for
 * free text to arrive somewhere nobody expected to find free text.
 */
const MAX_TAG_LENGTH = 256;

/**
 * Report an exception to Sentry (no-op when DSN is not configured).
 *
 * Context entries not on ALLOWED_CONTEXT_KEYS are dropped. Their NAMES are
 * reported under a `dropped_context` tag — a field name is not PHI, and knowing
 * that something was withheld is what stops a thin event being read as a
 * complete one.
 *
 * @param {Error} err - The error to report
 * @param {Record<string, unknown>} [context] - Candidate tags; filtered.
 */
export function captureException(err, context = {}) {
  if (!dsn) return;

  const allowed = [];
  const dropped = [];
  for (const [key, val] of Object.entries(context || {})) {
    if (val === undefined || val === null) continue;
    if (ALLOWED_CONTEXT_KEYS.has(key)) allowed.push([key, String(val).slice(0, MAX_TAG_LENGTH)]);
    else dropped.push(key);
  }

  Sentry.withScope((scope) => {
    for (const [key, val] of allowed) {
      scope.setTag(key, val);
    }
    if (dropped.length) {
      scope.setTag("dropped_context", dropped.join(",").slice(0, MAX_TAG_LENGTH));
    }
    Sentry.captureException(err);
  });
}
