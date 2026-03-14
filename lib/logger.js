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

// ---------------------------------------------------------------------------
// Turn-latency tracker — rolling window per business, emits p50/p95 every N turns
// ---------------------------------------------------------------------------

const EMIT_EVERY = 20; // emit percentile stats every N recorded turns
const MAX_WINDOW = 200; // keep at most this many samples per business

/** @type {Map<string, number[]>} businessId → array of latency samples (ms) */
const latencyWindows = new Map();
/** @type {Map<string, number>} businessId → count since last emit */
const latencyCounts = new Map();

/**
 * Compute a percentile from a sorted array.
 * @param {number[]} sorted
 * @param {number} p - 0–100
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Record a turn latency sample. Every EMIT_EVERY samples per business,
 * emits a `latency_stats` log line with p50, p95, min, max, and count.
 *
 * @param {string} businessId - Business UUID (use "default" if unknown)
 * @param {number} latencyMs - Turn latency in milliseconds
 */
export function recordTurnLatency(businessId, latencyMs) {
  const key = businessId || "default";

  let window = latencyWindows.get(key);
  if (!window) {
    window = [];
    latencyWindows.set(key, window);
  }
  window.push(latencyMs);

  // Cap the window size
  if (window.length > MAX_WINDOW) {
    window.splice(0, window.length - MAX_WINDOW);
  }

  const count = (latencyCounts.get(key) || 0) + 1;
  latencyCounts.set(key, count);

  if (count >= EMIT_EVERY) {
    latencyCounts.set(key, 0);
    const sorted = [...window].sort((a, b) => a - b);
    log("latency_stats", {
      businessId: key,
      samples: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    });
  }
}
