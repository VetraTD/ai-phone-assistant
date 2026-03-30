import crypto from "crypto";

/**
 * Generate a short random request ID for correlating log lines within a
 * single webhook invocation.
 * @returns {string} 12-character hex string
 */
export function createRequestId() {
  return crypto.randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// Leveled logger with per-call debug support
// ---------------------------------------------------------------------------

const LEVELS = { DEBUG: 0, INFO: 1, ERROR: 2 };
const configuredLevel =
  LEVELS[(process.env.LOG_LEVEL || "INFO").toUpperCase()] ?? LEVELS.INFO;
const debugCallIds = new Set(
  (process.env.DEBUG_CALL_IDS || "").split(",").filter(Boolean)
);

/**
 * Determine the effective log level for a given call.
 * If callSid is in DEBUG_CALL_IDS, return DEBUG level.
 * Otherwise return the configured global level.
 *
 * @param {string|undefined} callSid
 * @returns {number} LEVELS value
 */
function getEffectiveLevel(callSid) {
  if (callSid && debugCallIds.has(callSid)) {
    return LEVELS.DEBUG;
  }
  return configuredLevel;
}

/**
 * Build a human-readable message from event name and key fields.
 * Used for Railway's log UI so logs are readable in the message column.
 *
 * @param {string} event - Event name
 * @param {Record<string, unknown>} fields - Additional fields
 * @returns {string} Human-readable message
 */
function buildMessage(event, fields) {
  const callSid = fields.callSid ? ` [${fields.callSid.slice(-8)}]` : "";
  const errorCode = fields.code ? ` (${fields.code})` : "";
  const key = fields.businessName || fields.tool || fields.reason || fields.message || "";
  const keyStr = key ? ` - ${key}` : "";
  return `${event}${callSid}${keyStr}${errorCode}`;
}

/**
 * Emit a structured JSON log line to stdout, filtered by log level.
 *
 * @param {string} level - "DEBUG" | "INFO" | "ERROR"
 * @param {string} event - Event name (e.g. "call_started", "error")
 * @param {Record<string, unknown>} [fields] - Extra structured fields
 */
function emit(level, event, fields = {}) {
  const effectiveLevel = getEffectiveLevel(fields.callSid);
  if (LEVELS[level] < effectiveLevel) {
    return;
  }

  const entry = {
    message: buildMessage(event, fields),
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

/**
 * Structured logger with three levels: debug, info, error.
 * Every line includes `ts` (ISO timestamp), `level`, and `event`.
 * Pass additional key/value pairs in `fields`.
 *
 * Log levels:
 *   - DEBUG: detailed traces (default filtered out in production)
 *   - INFO: normal events (call lifecycle, step transitions, tool calls, silence nudges)
 *   - ERROR: all errors and warnings
 *
 * Control via environment variables:
 *   - LOG_LEVEL: "DEBUG", "INFO", or "ERROR" (default: "INFO")
 *   - DEBUG_CALL_IDS: comma-separated callSids to emit DEBUG for, regardless of LOG_LEVEL
 */
export const log = {
  debug: (event, fields) => emit("DEBUG", event, fields),
  info: (event, fields) => emit("INFO", event, fields),
  error: (event, fields) => emit("ERROR", event, fields),
};

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
    log.info("latency_stats", {
      businessId: key,
      samples: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    });
  }
}
