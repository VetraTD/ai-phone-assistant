// ---------------------------------------------------------------------------
// Turning a measurement run into a decision.
//
// The run produces seven latency distributions plus a probe-side ground truth
// measured past both carrier hops. On their own those are just numbers; the
// value is in which optimisation they justify and, more usefully, which ones
// they rule out.
//
// The mapping below was written before any numbers existed, so the conclusion
// cannot be fitted to whatever came back. Each branch names a specific next
// action, not a direction — "tune turn-taking" is not actionable, "the
// no_terminal_punctuation branch fired 30 times for 45s total" is.
// ---------------------------------------------------------------------------

/** Below this, the reconstruction that motivated the work was simply wrong. */
const ALREADY_FAST_MS = 800;

/** Share of the turn one stage must own before it counts as dominant. */
const DOMINANT_SHARE = 0.4;

/**
 * Cache hit rates at or under this mean nothing is being reused. Expected to be
 * 0 on gemini-3.6-flash: implicit caching does not engage on that model at all
 * (measured 2026-08-04 — three byte-identical 4,186-token requests, from both
 * systemInstruction and contents, reported no cachedContentTokenCount).
 */
const CACHE_DEAD_PCT = 5;

/** Stages ranked as candidates for "where the time goes", best name first. */
const CANDIDATE_STAGES = [
  "stt_endpoint_ms",
  "stt_tail_ms",
  "llm_ttfb_ms",
  "tts_ttfb_ms",
  "playout_ms",
];

const STAGE_GUIDANCE = {
  stt_endpoint_ms: {
    headline: "Deepgram's endpointing window dominates — this is config, not code.",
    recommendation:
      "Lower STT_ENDPOINTING_MS (lib/voice/sttStream.js reads it at connect time, default 300) " +
      "and re-run. No code change required. Turn-taking work and any TTS/LLM vendor swap are " +
      "premature until this is retuned.",
  },
  stt_tail_ms: {
    headline: "Our own hold timer (classifyHold) dominates the turn.",
    recommendation:
      "Fix lib/transcriptUtils.js classifyHold before touching any vendor. This is pure regex " +
      "with no network cost — the latency is entirely self-inflicted. TTS and LLM choice barely " +
      "matter at this ratio, and the Flux endpointing question is worth reopening.",
  },
  llm_ttfb_ms: {
    headline: "LLM time-to-first-token dominates.",
    recommendation:
      "The Groq comparison is worth running. Do NOT block on the prompt cache: measured " +
      "2026-08-04, implicit caching does not engage on gemini-3.6-flash from systemInstruction " +
      "OR from contents, and TTFT is flat in prompt size anyway — the cache is a token-cost " +
      "lever, not a latency one.",
  },
  tts_ttfb_ms: {
    headline: "TTS time-to-first-byte dominates.",
    recommendation:
      "This is the case where Cartesia's 40ms TTFA claim is worth real money. Weight the blind " +
      "A/B toward measured TTFA rather than judging on sound alone.",
  },
  playout_ms: {
    headline: "The pacing pump dominates — the cheapest possible fix, and entirely ours.",
    recommendation:
      "Tune VOICE_LOOKAHEAD_MS (lib/voice/audioOut.js, default 100) and the pump interval. No " +
      "vendor is involved. Note the lookahead exists to make barge-in graceful, so verify " +
      "interruption behaviour after lowering it.",
  },
};

/**
 * Read a stage's p50, treating a missing stage as unmeasured rather than zero.
 * @param {object} byStage
 * @param {string} name
 * @returns {number|null}
 */
function p50(byStage, name) {
  const v = byStage?.[name]?.p50;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Total turn length to measure shares against. Prefers true_v2v_ms (spans the
 * STT tail and the pacing gap); falls back to voice_to_voice_ms when the STT
 * stream produced no word timings, so a partially-instrumented run still
 * yields a verdict instead of dividing by null.
 * @param {object} byStage
 * @returns {number|null}
 */
function turnTotal(byStage) {
  return p50(byStage, "true_v2v_ms") ?? p50(byStage, "voice_to_voice_ms");
}

/**
 * Decide what the run means.
 *
 * @param {object} opts
 * @param {object} opts.serverStats - body of GET /api/debug/latency
 * @param {number|null} opts.probeP50 - p50 of probe-side voice-to-voice, or null
 * @returns {{headline: string, dominant: string|null, recommendation: string,
 *   networkRemainderMs: number|null, cacheBroken: boolean, worstHoldRule: string|null,
 *   notes: string[]}}
 */
export function buildVerdict({ serverStats, probeP50 = null } = {}) {
  const byStage = serverStats?.byStage ?? {};
  const notes = [];

  const total = turnTotal(byStage);
  const serverCount = serverStats?.count ?? 0;

  // Probe-side minus server-side is the part of the wait that happens outside
  // this process: Twilio, the carrier, and playout on the far end. It is not
  // fixable here, and its size is what stops it being optimised at.
  const networkRemainderMs =
    typeof probeP50 === "number" && typeof total === "number"
      ? Math.round(probeP50 - total)
      : null;

  const cache = serverStats?.cache ?? {};
  const cacheBroken =
    typeof cache.hitRatePctP50 === "number" && cache.hitRatePctP50 <= CACHE_DEAD_PCT;
  if (cacheBroken) {
    notes.push(
      `Prompt cache hit rate is ${cache.hitRatePctP50}% across ${cache.samples} turns. This is ` +
        "EXPECTED and is not a prefix-stability bug: implicit caching does not engage on " +
        "gemini-3.6-flash. Explicit caching (ai.caches.create + cachedContent) does work on it " +
        "and cuts input cost ~75-80%; input tokens are ~93% of the Gemini bill. Cost lever only " +
        "— TTFT is flat in prompt size."
    );
  }

  if (networkRemainderMs !== null && networkRemainderMs > 200) {
    notes.push(
      `${networkRemainderMs}ms of the caller's wait happens outside this process (Twilio + ` +
        "carrier transit + far-end playout). No change in this codebase reduces it."
    );
  }

  if (!serverCount || total === null) {
    return {
      headline: "No data — the run produced no complete turns, so there is nothing to conclude.",
      dominant: null,
      recommendation:
        "Check that DEBUG_ENDPOINTS and DEBUG_TOKEN are set on the server under test and that " +
        "the probe calls actually connected.",
      networkRemainderMs,
      cacheBroken,
      worstHoldRule: null,
      notes,
    };
  }

  if (total < ALREADY_FAST_MS) {
    return {
      headline: `p50 is already ${total}ms — the 1,500-1,900ms reconstruction was wrong and none of this is urgent.`,
      dominant: null,
      recommendation:
        "Stop optimising latency. Judge the TTS candidates purely on how they sound and what " +
        "they cost.",
      networkRemainderMs,
      cacheBroken,
      worstHoldRule: null,
      notes,
    };
  }

  // Largest share of the turn wins, provided it clears DOMINANT_SHARE.
  let dominant = null;
  let dominantMs = 0;
  for (const stage of CANDIDATE_STAGES) {
    const ms = p50(byStage, stage);
    if (ms === null) continue;
    if (ms > dominantMs) {
      dominantMs = ms;
      dominant = stage;
    }
  }
  if (dominant === null || dominantMs / total < DOMINANT_SHARE) {
    return {
      headline: `Cost is spread evenly across stages (p50 ${total}ms, largest single stage ${dominantMs}ms).`,
      dominant: null,
      recommendation:
        "No single fix pays for itself. Take the cheap wins in §12 order and stop optimising — " +
        "there is no dominant target to aim at.",
      networkRemainderMs,
      cacheBroken,
      worstHoldRule: null,
      notes,
    };
  }

  // Which classifyHold branch actually spent the time. Ranked by total ms, not
  // by count: a rule that fires often but charges little is not the problem.
  let worstHoldRule = null;
  if (dominant === "stt_tail_ms") {
    let worstMs = 0;
    for (const [rule, agg] of Object.entries(serverStats?.holdRules ?? {})) {
      if ((agg?.totalMs ?? 0) > worstMs) {
        worstMs = agg.totalMs;
        worstHoldRule = rule;
      }
    }
    if (worstHoldRule) {
      const agg = serverStats.holdRules[worstHoldRule];
      notes.push(
        `Worst hold branch: ${worstHoldRule} — ${agg.count} holds, ${agg.totalMs}ms total.`
      );
    }
  }

  const guidance = STAGE_GUIDANCE[dominant];
  const sharePct = Math.round((dominantMs / total) * 100);
  let recommendation = guidance.recommendation;
  if (dominant !== "llm_ttfb_ms" && cacheBroken) {
    recommendation +=
      " Separately: the prompt cache is not hitting, which inflates LLM TTFT on every turn.";
  }

  return {
    headline: `${guidance.headline} (${dominantMs}ms of a ${total}ms turn, ${sharePct}%.)`,
    dominant,
    recommendation,
    networkRemainderMs,
    cacheBroken,
    worstHoldRule,
    notes,
  };
}

/**
 * Percentile of an ascending-sorted array, matching lib/voice/metrics.js.
 * @param {number[]} sorted
 * @param {number} p
 * @returns {number|null}
 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function fmt(v) {
  return v === null || v === undefined ? "—" : String(v);
}

/**
 * Render the run as markdown.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {number} opts.callCount
 * @param {object[]} opts.probeTurns - records from lib/probe/probeRun.js
 * @param {object} opts.serverStats - body of GET /api/debug/latency
 * @returns {string} markdown
 */
export function buildReport({ runId, callCount, probeTurns = [], serverStats = {}, startBootId } = {}) {
  // Barge turns are excluded from the percentiles on purpose: the reply
  // overlaps the interruption, so their "latency" is not the same quantity.
  // They are counted separately rather than dropped silently.
  const clean = probeTurns.filter((t) => !t.bargeIn && !t.timedOut && t.probeV2vMs !== null);
  const bargeCount = probeTurns.filter((t) => t.bargeIn).length;
  const timedOutCount = probeTurns.filter((t) => t.timedOut).length;
  const sorted = clean.map((t) => t.probeV2vMs).sort((a, b) => a - b);
  const probeP50 = percentile(sorted, 50);
  const probeP95 = percentile(sorted, 95);

  const verdict = buildVerdict({ serverStats, probeP50 });
  const byStage = serverStats.byStage ?? {};

  const stageRows = [
    "true_v2v_ms",
    "voice_to_voice_ms",
    "stt_endpoint_ms",
    "stt_tail_ms",
    "llm_ttfb_ms",
    // Breakdown of llm_ttfb_ms on tool-calling turns only. Reported but
    // deliberately NOT added to CANDIDATE_STAGES: they are a subset of
    // llm_ttfb_ms, so letting them compete for "dominant stage" would double
    // count the same milliseconds and corrupt a verdict whose rules were fixed
    // before any numbers existed.
    "llm_tool_ms",
    "llm_reply_after_tool_ms",
    "tts_ttfb_ms",
    "playout_ms",
  ]
    .map((s) => `| ${s} | ${fmt(byStage[s]?.p50)} | ${fmt(byStage[s]?.p95)} | ${fmt(byStage[s]?.max)} |`)
    .join("\n");

  const holdRows = Object.entries(serverStats.holdRules ?? {})
    .filter(([, agg]) => agg?.count)
    .sort((a, b) => (b[1].totalMs ?? 0) - (a[1].totalMs ?? 0))
    .map(([rule, agg]) => `| ${rule} | ${agg.count} | ${agg.totalMs} |`)
    .join("\n");

  const cache = serverStats.cache ?? {};
  const markerLeaks = serverStats.turnTaking?.intent_marker_leaks ?? 0;
  const fallbackTurns = serverStats.turnTaking?.tts_fallback_turns ?? 0;
  // A run measured on the fallback voice is not measuring the product. Say so
  // at the top rather than leaving an 8x tts_ttfb_ms to be misread as a
  // latency regression — which is exactly what happened on 2026-08-04.
  // A run that spanned a restart measured two different builds, and the ring
  // buffer was cleared underneath it. Both boot ids must be present to make the
  // claim — an older server that does not report one is not evidence either way.
  const endBootId = serverStats.bootId;
  const restarted = startBootId && endBootId && startBootId !== endBootId;
  const restartWarning = restarted
    ? `\n> **The server RESTARTED during this run (${startBootId} -> ${endBootId}).**\n` +
      `> A deploy mid-run clears the ring buffer and splits the calls across two\n` +
      `> builds, so nothing below is a result. A push is a deploy is a restart —\n` +
      `> re-run without committing anything while it dials.\n`
    : "";
  const voiceWarning =
    fallbackTurns > 0
      ? `\n> **The intended voice was NOT used on ${fallbackTurns} turn(s).** ElevenLabs failed\n` +
        `> (exhausted credits, an outage, or an open breaker) and the Google fallback spoke\n` +
        `> instead. It synthesizes per sentence in batch, so \`tts_ttfb_ms\` below reflects the\n` +
        `> fallback, not the product. Restore the voice and re-run before trusting these numbers.\n`
      : "";

  return `# Voice latency run ${runId}

**${callCount} calls · ${serverStats.count ?? 0} server-side turns · ${clean.length} clean probe turns**
(${bargeCount} barge-in turns and ${timedOutCount} timed out, both excluded from the percentiles below.)
${restartWarning}${voiceWarning}

## Verdict

${verdict.headline}

**Next:** ${verdict.recommendation}
${verdict.notes.map((n) => `\n- ${n}`).join("")}

## Server-side stages (ms)

| stage | p50 | p95 | max |
|---|---|---|---|
${stageRows}

## Probe-side ground truth (ms)

Measured on the originating leg, past both carrier hops — the wait a caller
actually experiences.

| metric | value |
|---|---|
| probe p50 | ${fmt(probeP50)} |
| probe p95 | ${fmt(probeP95)} |
| probe − server true_v2v | ${fmt(verdict.networkRemainderMs)} |
| turns timed out (no reply) | ${timedOutCount} |

## Intent marker

Only meaningful when VOICE_INTENT_MARKER is on. A leak means the stream-level
strip missed a marker and \`toSpeakable\` repaired it on the way to TTS — the
caller did not hear it, but the primary strip has a hole. Anything other than 0
blocks the flag going live.

| metric | value |
|---|---|
| markers that reached toSpeakable | ${markerLeaks} |

## Voice engine

| metric | value |
|---|---|
| caller turns spoken by the Google fallback | ${fallbackTurns} |

## classifyHold attribution

| rule | holds | total ms |
|---|---|---|
${holdRows || "| (none recorded) | 0 | 0 |"}

## Prompt cache

| metric | value |
|---|---|
| turns with token counts | ${fmt(cache.samples)} |
| turns with a cache hit | ${fmt(cache.turnsWithHit)} |
| hit rate p50 | ${fmt(cache.hitRatePctP50)}% |
| cached tokens p50 | ${fmt(cache.cachedTokensP50)} |
`;
}
