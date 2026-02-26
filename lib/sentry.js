import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN || "";

if (dsn) {
  Sentry.init({ dsn });
}

/** Whether Sentry is active (DSN was provided). */
export const enabled = !!dsn;

/**
 * Report an exception to Sentry (no-op when DSN is not configured).
 *
 * @param {Error} err - The error to report
 * @param {Record<string, string>} [context] - Tags attached to the event
 *   (e.g. { callSid, requestId })
 */
export function captureException(err, context = {}) {
  if (!dsn) return;
  Sentry.withScope((scope) => {
    for (const [key, val] of Object.entries(context)) {
      scope.setTag(key, String(val));
    }
    Sentry.captureException(err);
  });
}
