import crypto from "crypto";
import { isPhiField, REDACTED } from "./phiFields.js";

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

  const safe = redactPhi(fields);
  const entry = {
    message: buildMessage(event, safe),
    ts: new Date().toISOString(),
    level,
    event,
    ...safe,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

/**
 * Replace the value of any PHI-typed field with a marker, at any depth.
 *
 * The safety net, not the guard. tests/logPhiLint.test.js fails the build when
 * a PHI-typed name appears in a logger call, and that is the mechanism that
 * matters: it tells the author, at the moment they write it, instead of telling
 * a log sink six months later.
 *
 * This exists for what the lint cannot see — a field name that arrives from a
 * spread (`{ ...toolArgs }`) or a computed key. It is not a licence to log
 * `callerPhone` and rely on redaction. The lint will still fail.
 *
 * Depth-limited, and the limit REPLACES rather than passes through. Returning
 * the original object below the limit would put a live reference back into the
 * copy, so a cycle would survive into JSON.stringify and throw — which is how
 * this behaved before: `log.info("e", cyclicFields)` crashed the caller. The
 * copy is now always a finite tree, so the stringify below cannot fail on
 * structure.
 */
const MAX_DEPTH = 4;
const TRUNCATED = "[truncated:depth]";

function redactPhi(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) return value.map((v) => redactPhi(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isPhiField(key) ? REDACTED : redactPhi(val, depth + 1);
  }
  return out;
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
 * Record a turn latency sample.
 *
 * Two call shapes are supported:
 *  1. `recordTurnLatency(payload)` — the full per-turn metrics payload
 *     produced by `lib/voice/metrics.js` (`createTurnMetrics().finishTurn()`).
 *     Emits one structured `turn_latency` log line with the full payload
 *     (callSid, turnIndex, raw marks, and the stt_tail_ms / llm_ttfb_ms /
 *     tts_ttfb_ms / voice_to_voice_ms deltas).
 *  2. `recordTurnLatency(businessId, latencyMs)` — legacy shape used by the
 *     legacy turn-completion call shape. Keeps
 *     accumulating a rolling per-business window and emits a `latency_stats`
 *     summary (p50/p95/min/max) every EMIT_EVERY samples.
 *
 * @param {string|Record<string, unknown>} businessIdOrPayload
 * @param {number} [latencyMs] - Turn latency in milliseconds (legacy shape only)
 */
export function recordTurnLatency(businessIdOrPayload, latencyMs) {
  if (businessIdOrPayload && typeof businessIdOrPayload === "object") {
    log.info("turn_latency", businessIdOrPayload);
    return;
  }

  const businessId = businessIdOrPayload;
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
