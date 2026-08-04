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
//   audio_speech_end  — the caller ACTUALLY stopped talking, back-computed from
//                       Deepgram's word timings (see sttStream.getLastFinalLagMs).
//                       Everything between here and speech_end is Deepgram's
//                       endpointing window + network + inference — time the
//                       caller is waiting that this process cannot otherwise see.
//   speech_end        — Deepgram final transcript triggers the turn
//   stt_final         — STT finalized (currently same instant as speech_end)
//   llm_request       — about to start the Gemini streaming call
//   llm_first_chunk   — first text delta received from Gemini
//   tts_first_byte    — first sentence's TTS audio finished synthesizing
//   first_audio_sent  — first Twilio media frame of the turn was ENQUEUED
//   first_frame_wire  — that frame was actually written to the Twilio socket.
//                       Non-zero because audioOut paces playout (LOOKAHEAD_MS)
//                       rather than dumping the utterance into Twilio's buffer.
//
// The two outermost marks exist because `voice_to_voice_ms` measures
// speech_end -> first_audio_sent, which is an in-process window: it excludes
// both the STT tail before it and the pacing gap after it. `true_v2v_ms` spans
// audio_speech_end -> first_frame_wire and is the number a caller experiences.
//
// Instrumentation must never break a call: every public function here is
// try/catch-safe and returns a harmless value on any internal failure.
// ---------------------------------------------------------------------------

const RING_BUFFER_MAX = 500;

/** Module-level ring buffer of finished-turn payloads, newest at the end. */
export let _ringBuffer = [];

// ---------------------------------------------------------------------------
// Turn-taking counters.
//
// Separate from the per-turn ring buffer because these events are not
// turn-scoped: a suppressed nudge or an extended hold happens BETWEEN turns,
// and several can occur inside one. They exist so turn-taking behavior is
// countable across a batch of test calls ("did the ladder fire at all, and
// how often did caller speech hold it off?") rather than only greppable.
// ---------------------------------------------------------------------------

const COUNTER_NAMES = [
  "nudges_fired",
  "nudges_suppressed",
  "silence_hangups",
  "holds_started",
  "holds_extended",
  "holds_capped",
  "barge_ins",
  // Replies delayed by the post-barge settle window (session.js
  // POST_BARGE_SETTLE_MS) — the count of interruptions that did NOT turn into
  // a start/stop collision.
  "barge_settles",
  // Transcripts rejected as the AI's own audio bleeding back into the mic
  // (lib/voice/echoGuard.js). Split by source because an interim echo costs a
  // false barge-in while a final echo costs a whole wasted turn — on a
  // speakerphone call both should be non-zero while `barge_ins` stays flat.
  "echo_suppressed_interim",
  "echo_suppressed_final",
  // Times the runaway-barge backstop fired (session.js loop breaker). Should
  // be 0 in normal operation: a non-zero value means the echo guard and the
  // settle window let a start/stop loop through, and is a bug report.
  "loop_breaker_trips",
  // Times the model went quiet mid-turn long enough that a hold line played
  // (lib/voice/llmTurn.js stall watchdog) — usually a slow tool round.
  "llm_stalls",
];

/** @type {Record<string, number>} */
let _counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));

/**
 * Increment a turn-taking counter. Unknown names are ignored rather than
 * silently creating fields, so a typo at a call site can't invent a metric.
 * Never throws — instrumentation must not break a call.
 * @param {string} name - one of COUNTER_NAMES
 */
export function bumpCounter(name) {
  try {
    if (Object.prototype.hasOwnProperty.call(_counters, name)) _counters[name] += 1;
  } catch {
    // Metrics must never break a call.
  }
}

// ---------------------------------------------------------------------------
// classifyHold attribution.
//
// The hold is the single largest piece of latency this codebase controls
// outright: lib/transcriptUtils.js parks a transcript for 1500-2000ms before
// the turn starts, and the branch that fires on any final without terminal
// punctuation charges 1500ms. The rule name is already logged per hold, but a
// log line can't answer "which branch, how often, how many seconds of the
// call". Aggregating count AND total ms per rule does: a rule that fires twice
// for 2000ms each matters less than one firing thirty times for 1500ms.
//
// Zero-cost rules are counted too — terminal_punctuation's share is the
// denominator that says whether the hold is a common tax or an edge case.
// ---------------------------------------------------------------------------

/**
 * Rule names produced by classifyHold (lib/transcriptUtils.js), plus the two
 * decisions session.js makes around it: "complete" (isIncomplete said no, so
 * classifyHold was never consulted — the free case) and "post_barge_settle"
 * (the settle window outbid whatever classifyHold wanted).
 */
const HOLD_RULE_NAMES = [
  "complete",
  "empty",
  "trailing_conjunction",
  "trailing_lead_in",
  "partial_digits",
  "terminal_punctuation",
  "no_terminal_punctuation",
  "post_barge_settle",
];

function freshHoldRules() {
  return Object.fromEntries(HOLD_RULE_NAMES.map((n) => [n, { count: 0, totalMs: 0 }]));
}

/** @type {Record<string, {count: number, totalMs: number}>} */
let _holdRules = freshHoldRules();

/**
 * Record one classifyHold decision. Unknown rule names are ignored rather than
 * silently creating fields, matching bumpCounter. Never throws.
 * @param {string} rule - one of HOLD_RULE_NAMES
 * @param {number} holdMs - ms this decision parked the transcript (0 is meaningful)
 */
export function recordHoldRule(rule, holdMs) {
  try {
    const entry = Object.prototype.hasOwnProperty.call(_holdRules, rule)
      ? _holdRules[rule]
      : null;
    if (!entry) return;
    entry.count += 1;
    if (typeof holdMs === "number" && Number.isFinite(holdMs)) entry.totalMs += holdMs;
  } catch {
    // Metrics must never break a call.
  }
}

/** Stages whose pairwise deltas are reported (and tracked in getLatencyStats). */
const DELTA_SPECS = [
  ["stt_endpoint_ms", "audio_speech_end", "speech_end"],
  ["stt_tail_ms", "speech_end", "stt_final"],
  ["llm_ttfb_ms", "llm_request", "llm_first_chunk"],
  ["tts_ttfb_ms", "llm_first_chunk", "tts_first_byte"],
  ["playout_ms", "first_audio_sent", "first_frame_wire"],
  ["voice_to_voice_ms", "speech_end", "first_audio_sent"],
  ["true_v2v_ms", "audio_speech_end", "first_frame_wire"],
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

const STAT_STAGES = [
  "true_v2v_ms",
  "voice_to_voice_ms",
  "stt_endpoint_ms",
  "stt_tail_ms",
  "llm_ttfb_ms",
  "tts_ttfb_ms",
  "playout_ms",
];

/**
 * Summarize prompt-cache effectiveness over the ring buffer.
 *
 * Gemini's implicit caching only hits on a stable prefix, and the system
 * instruction is deliberately split into a static prefix + dynamic tail
 * (services/gemini.js buildSystemInstruction) to make that possible. Whether
 * it actually works has never been measurable: the token count was logged at
 * DEBUG and then dropped. A hit rate near 0 means the whole prefix is being
 * re-billed and re-processed every turn — worth fixing before any LLM vendor
 * benchmark, because it inflates TTFB on every candidate equally.
 *
 * @param {object[]} buffer
 * @returns {{samples: number, turnsWithHit: number, hitRatePctP50: number|null, cachedTokensP50: number|null}}
 */
function summarizeCache(buffer) {
  const rates = [];
  const cachedCounts = [];
  let turnsWithHit = 0;

  for (const p of buffer) {
    const prompt = p.prompt_tokens;
    const cached = p.cached_tokens;
    if (typeof prompt !== "number" || !Number.isFinite(prompt) || prompt <= 0) continue;
    // A missing cached count alongside a known prompt count is a measured
    // ZERO, not missing data: Gemini omits cachedContentTokenCount entirely
    // when nothing was cached. Skipping those turns reported a completely dead
    // cache as an empty table, which reads as "not instrumented" rather than
    // "the prefix is never being reused".
    const cachedNum = typeof cached === "number" && Number.isFinite(cached) ? cached : 0;
    rates.push((cachedNum / prompt) * 100);
    cachedCounts.push(cachedNum);
    if (cachedNum > 0) turnsWithHit += 1;
  }

  const sortedRates = [...rates].sort((a, b) => a - b);
  const sortedCached = [...cachedCounts].sort((a, b) => a - b);
  const rateP50 = percentile(sortedRates, 50);

  return {
    samples: rates.length,
    turnsWithHit,
    hitRatePctP50: rateP50 === null ? null : Math.round(rateP50),
    cachedTokensP50: percentile(sortedCached, 50),
  };
}

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
    turnTaking: { ..._counters },
    holdRules: structuredClone(_holdRules),
    cache: summarizeCache(_ringBuffer),
    recent: _ringBuffer.slice(-20),
  };
}

/** Reset the ring buffer and counters. For tests. */
export function clearStats() {
  _ringBuffer = [];
  _counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  _holdRules = freshHoldRules();
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
