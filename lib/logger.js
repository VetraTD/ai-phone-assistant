import crypto from "crypto";

/**
 * Generate a short random request ID for correlating log lines within a
 * single webhook invocation.
 * @returns {string} 12-character hex string
 */
export function createRequestId() {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Write one structured JSON log line to stdout.
 *
 * Every line includes `ts` (ISO timestamp) and `event` (event name).
 * Pass additional key/value pairs in `fields`.
 *
 * @param {string} event - Event name (e.g. "call_started", "error")
 * @param {Record<string, unknown>} [fields] - Extra structured fields
 */
export function log(event, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
