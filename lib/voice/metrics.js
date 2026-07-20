import { performance } from "node:perf_hooks";
import { recordTurnLatency } from "../logger.js";

// ---------------------------------------------------------------------------
// Per-turn latency tracker for the real-time voice pipeline.
//
// One `createTurnMetrics(callSid)` tracker is created per call and stored on
// the call's state object. Pipeline stages call `mark(name)` as they happen;
// `finishTurn()` computes the deltas for the completed turn, appends the
// result to a module-level ring buffer (for the /api/debug/latency endpoint),
// and forwards the payload to the structured logger.
//
// Stage names (call in this order over the life of one turn):
//   speech_end        — Deepgram final transcript triggers the turn
//   stt_final         — STT finalized (currently same instant as speech_end)
//   llm_request       — about to start the Gemini streaming call
//   llm_first_chunk   — first text delta received from Gemini
//   tts_first_byte    — first sentence's TTS audio finished synthesizing
//   first_audio_sent  — first Twilio media frame of the turn was sent
//
// Instrumentation must never break a call: every public function here is
// try/catch-safe and returns a harmless value on any internal failure.
// ---------------------------------------------------------------------------

const RING_BUFFER_MAX = 500;

/** Module-level ring buffer of finished-turn payloads, newest at the end. */
export let _ringBuffer = [];

/** Stages whose pairwise deltas are reported (and tracked in getLatencyStats). */
const DELTA_SPECS = [
  ["stt_tail_ms", "speech_end", "stt_final"],
  ["llm_ttfb_ms", "llm_request", "llm_first_chunk"],
  ["tts_ttfb_ms", "llm_first_chunk", "tts_first_byte"],
  ["voice_to_voice_ms", "speech_end", "first_audio_sent"],
];

/**
 * Create a per-call turn-metrics tracker.
 * @param {string} callSid
 * @returns {{mark: Function, finishTurn: Function}}
 */
export function createTurnMetrics(callSid) {
  let marks = new Map(); // stage name -> timestamp (ms), insertion-ordered
  let turnIndex = 0;

  /**
   * Record a timestamp for a pipeline stage. Repeat marks of the same name
   * within a turn are ignored (first one wins). Never throws.
   * @param {string} name - one of the stage names described above
   * @param {number} [atMs] - optional explicit timestamp (ms) for tests;
   *   defaults to `performance.now()`.
   */
  function mark(name, atMs) {
    try {
      if (!name || marks.has(name)) return;
      const ts = typeof atMs === "number" && !Number.isNaN(atMs) ? atMs : performance.now();
      marks.set(name, ts);
    } catch {
      // Metrics must never break a call.
    }
  }

  /**
   * Finish the current turn: compute the metrics payload, record it, and
   * start a new (empty) turn implicitly. Never throws.
   * @param {Record<string, unknown>} [extra] - extra fields merged into the payload (e.g. {barged_in: true})
   * @returns {object|null} the payload, or null if fewer than 2 marks were set
   */
  function finishTurn(extra = {}) {
    const currentMarks = marks;
    marks = new Map(); // a new turn implicitly starts now, regardless of outcome below

    try {
      if (currentMarks.size < 2) {
        return null;
      }

      const reference = currentMarks.has("speech_end")
        ? currentMarks.get("speech_end")
        : currentMarks.values().next().value;

      const payload = { callSid, turnIndex };
      for (const [name, ts] of currentMarks) {
        payload[name] = Math.round(ts - reference);
      }

      for (const [deltaName, fromStage, toStage] of DELTA_SPECS) {
        payload[deltaName] =
          currentMarks.has(fromStage) && currentMarks.has(toStage)
            ? Math.round(currentMarks.get(toStage) - currentMarks.get(fromStage))
            : null;
      }

      if (extra && typeof extra === "object") {
        Object.assign(payload, extra);
      }

      _ringBuffer.push(payload);
      if (_ringBuffer.length > RING_BUFFER_MAX) {
        _ringBuffer.shift();
      }

      turnIndex++;

      try {
        recordTurnLatency(payload);
      } catch {
        // A logging failure must never break the call.
      }

      return payload;
    } catch {
      return null;
    }
  }

  return { mark, finishTurn };
}

/**
 * Compute a percentile from a sorted-ascending array of numbers.
 * @param {number[]} sorted
 * @param {number} p - 0-100
 * @returns {number|null}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const STAT_STAGES = ["voice_to_voice_ms", "stt_tail_ms", "llm_ttfb_ms", "tts_ttfb_ms"];

/**
 * Compute latency statistics over the current ring buffer.
 * @returns {{count: number, byStage: Record<string, {p50: number|null, p95: number|null, max: number|null}>, recent: object[]}}
 */
export function getLatencyStats() {
  const byStage = {};
  for (const stage of STAT_STAGES) {
    const values = _ringBuffer
      .map((p) => p[stage])
      .filter((v) => typeof v === "number" && !Number.isNaN(v))
      .sort((a, b) => a - b);
    byStage[stage] = {
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? values[values.length - 1] : null,
    };
  }

  return {
    count: _ringBuffer.length,
    byStage,
    recent: _ringBuffer.slice(-20),
  };
}

/** Reset the ring buffer. For tests. */
export function clearStats() {
  _ringBuffer = [];
}

/**
 * Compute avg/p95 voice-to-voice turn latency for a single call, from
 * whatever turns for that callSid are still in the ring buffer. The ring
 * buffer isn't indexed per-call (it's a flat, cross-call rolling window) —
 * turn payloads carry `callSid`, so this just filters it directly. Cheap
 * enough at RING_BUFFER_MAX (500) to not need a real index.
 * @param {string} callSid
 * @returns {{avgMs: number, p95Ms: number, count: number} | null} null if no
 *   turns were recorded for this call (e.g. degraded-mode voicemail calls
 *   that never went through the real-time pipeline).
 */
export function getCallStats(callSid) {
  const values = _ringBuffer
    .filter((p) => p.callSid === callSid)
    .map((p) => p.voice_to_voice_ms)
    .filter((v) => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const avgMs = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
  const p95Ms = percentile(values, 95);
  return { avgMs, p95Ms, count: values.length };
}
