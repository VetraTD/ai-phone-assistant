import { describe, it, expect } from "vitest";
import { buildVerdict, buildReport } from "../lib/probe/report.js";

// ---------------------------------------------------------------------------
// The run produces seven latency distributions plus a probe-side ground truth.
// This is the layer that turns them into the one thing the run exists to
// produce: which optimisation is worth doing next, and which are not.
//
// Every branch below corresponds to a pre-committed decision — written down
// BEFORE the numbers existed, so the conclusion can't be fitted to whatever
// came back.
// ---------------------------------------------------------------------------

/** serverStats.byStage shape, with only p50s that matter for the verdict. */
function stats({ trueV2v, sttEndpoint = 0, sttTail = 0, llm = 0, tts = 0, playout = 0 }) {
  const stage = (p50) => ({ p50, p95: p50, max: p50 });
  return {
    count: 40,
    byStage: {
      true_v2v_ms: stage(trueV2v),
      voice_to_voice_ms: stage(trueV2v - sttEndpoint - playout),
      stt_endpoint_ms: stage(sttEndpoint),
      stt_tail_ms: stage(sttTail),
      llm_ttfb_ms: stage(llm),
      tts_ttfb_ms: stage(tts),
      playout_ms: stage(playout),
    },
    holdRules: {},
    cache: { samples: 40, turnsWithHit: 40, hitRatePctP50: 80, cachedTokensP50: 3000 },
  };
}

// ---------------------------------------------------------------------------
// A run whose server restarted midway measured two different builds and is not
// a result. This cost a full 12-call run on 2026-08-04: a docs commit triggered
// a Railway redeploy 52 seconds before the probe dialled, every call died on
// connect, and the report said "no data — check DEBUG_ENDPOINTS and that the
// calls connected". Right to flag it, wrong cause.
// ---------------------------------------------------------------------------
describe("buildReport — server restart during the run", () => {
  it("says the server restarted when the boot id changed", () => {
    const md = buildReport({
      runId: "r1",
      callCount: 12,
      probeTurns: [],
      serverStats: { count: 0, byStage: {}, turnTaking: {}, holdRules: {}, bootId: "boot-B" },
      startBootId: "boot-A",
    });

    expect(md).toMatch(/restarted during this run/i);
    expect(md).toMatch(/boot-A/);
    expect(md).toMatch(/boot-B/);
  });

  it("says nothing when the boot id held steady", () => {
    const md = buildReport({
      runId: "r1",
      callCount: 12,
      probeTurns: [],
      serverStats: { count: 0, byStage: {}, turnTaking: {}, holdRules: {}, bootId: "boot-A" },
      startBootId: "boot-A",
    });

    expect(md).not.toMatch(/restarted during this run/i);
  });

  it("says nothing when boot ids are unavailable (older server)", () => {
    const md = buildReport({
      runId: "r1",
      callCount: 12,
      probeTurns: [],
      serverStats: { count: 0, byStage: {}, turnTaking: {}, holdRules: {} },
    });

    expect(md).not.toMatch(/restarted during this run/i);
  });
});

describe("buildVerdict — which optimisation the numbers justify", () => {
  it("calls the whole exercise off when p50 is already under 800ms", () => {
    const v = buildVerdict({ serverStats: stats({ trueV2v: 700, llm: 400 }), probeP50: 750 });

    expect(v.headline).toMatch(/urgent/i);
    expect(v.dominant).toBeNull();
  });

  it("blames classifyHold when the hold timer dominates", () => {
    const v = buildVerdict({
      serverStats: {
        ...stats({ trueV2v: 1800, sttTail: 1500, llm: 200, tts: 100 }),
        holdRules: {
          no_terminal_punctuation: { count: 30, totalMs: 45000 },
          partial_digits: { count: 2, totalMs: 3000 },
          complete: { count: 5, totalMs: 0 },
        },
      },
      probeP50: 1900,
    });

    expect(v.dominant).toBe("stt_tail_ms");
    expect(v.headline).toMatch(/classifyHold|hold/i);
    // Naming the branch is the difference between "tune turn-taking" and a
    // one-line change to a specific regex.
    expect(v.worstHoldRule).toBe("no_terminal_punctuation");
  });

  it("blames Deepgram endpointing — a config knob, not code — when that dominates", () => {
    const v = buildVerdict({
      serverStats: stats({ trueV2v: 1600, sttEndpoint: 900, llm: 400, tts: 200 }),
      probeP50: 1700,
    });

    expect(v.dominant).toBe("stt_endpoint_ms");
    expect(v.recommendation).toMatch(/STT_ENDPOINTING_MS/);
  });

  it("makes the LLM test conditional on the cache being healthy first", () => {
    const v = buildVerdict({
      serverStats: {
        ...stats({ trueV2v: 1500, llm: 1100, tts: 200 }),
        cache: { samples: 40, turnsWithHit: 0, hitRatePctP50: 0, cachedTokensP50: 0 },
      },
      probeP50: 1600,
    });

    expect(v.dominant).toBe("llm_ttfb_ms");
    // Benchmarking a second LLM vendor while the prompt cache is dead measures
    // the broken prefix on both, and picks a winner for the wrong reason.
    expect(v.recommendation).toMatch(/cache/i);
    expect(v.cacheBroken).toBe(true);
  });

  it("makes TTS time-to-first-byte a money question only when it dominates", () => {
    const v = buildVerdict({
      serverStats: stats({ trueV2v: 1500, tts: 900, llm: 300 }),
      probeP50: 1600,
    });

    expect(v.dominant).toBe("tts_ttfb_ms");
    expect(v.recommendation).toMatch(/Cartesia|TTFA/i);
  });

  it("flags the pacing pump when the newly visible playout gap dominates", () => {
    const v = buildVerdict({
      serverStats: stats({ trueV2v: 1400, playout: 800, llm: 300, tts: 200 }),
      probeP50: 1500,
    });

    expect(v.dominant).toBe("playout_ms");
    expect(v.recommendation).toMatch(/pacing|lookahead/i);
  });

  it("says stop optimising when no single stage dominates", () => {
    const v = buildVerdict({
      serverStats: stats({ trueV2v: 1600, sttEndpoint: 320, sttTail: 380, llm: 380, tts: 300, playout: 220 }),
      probeP50: 1700,
    });

    expect(v.dominant).toBeNull();
    expect(v.headline).toMatch(/spread|evenly/i);
  });

  it("attributes the probe-minus-server remainder to the carrier", () => {
    // Nothing in this codebase can fix transit time; knowing its size is what
    // stops it being optimised at.
    const v = buildVerdict({
      serverStats: stats({ trueV2v: 900, llm: 500, tts: 200 }),
      probeP50: 1700,
    });

    expect(v.networkRemainderMs).toBe(800);
    expect(v.notes.join(" ")).toMatch(/carrier|network|Twilio/i);
  });

  it("does not invent a remainder when the probe produced no measurement", () => {
    const v = buildVerdict({ serverStats: stats({ trueV2v: 1500, llm: 900 }), probeP50: null });
    expect(v.networkRemainderMs).toBeNull();
  });

  it("falls back to voice_to_voice_ms when true_v2v was never populated", () => {
    // A run against a server whose STT gave no word timings still has to
    // produce a verdict rather than dividing by null.
    const s = stats({ trueV2v: 1500, llm: 1000 });
    s.byStage.true_v2v_ms = { p50: null, p95: null, max: null };

    const v = buildVerdict({ serverStats: s, probeP50: null });

    expect(v.dominant).toBe("llm_ttfb_ms");
  });

  it("reports insufficient data rather than guessing from an empty run", () => {
    const v = buildVerdict({
      serverStats: { count: 0, byStage: {}, holdRules: {}, cache: { samples: 0 } },
      probeP50: null,
    });

    expect(v.headline).toMatch(/no data|insufficient/i);
  });
});

describe("buildReport — the written artefact", () => {
  it("renders the stage table, the verdict and the sample count", () => {
    const md = buildReport({
      runId: "run-1",
      callCount: 12,
      probeTurns: [
        { label: "u1", probeV2vMs: 1700, bargeIn: false, timedOut: false },
        { label: "u2", probeV2vMs: 1900, bargeIn: false, timedOut: false },
      ],
      serverStats: stats({ trueV2v: 1500, sttTail: 1200, llm: 200 }),
    });

    expect(md).toMatch(/run-1/);
    expect(md).toMatch(/true_v2v_ms/);
    expect(md).toMatch(/12/);
    expect(md).toMatch(/stt_tail_ms/);
  });

  it("records how many probe turns went unanswered instead of dropping them", () => {
    const md = buildReport({
      runId: "run-2",
      callCount: 2,
      probeTurns: [
        { label: "u1", probeV2vMs: null, bargeIn: false, timedOut: true },
        { label: "u2", probeV2vMs: 1500, bargeIn: false, timedOut: false },
      ],
      serverStats: stats({ trueV2v: 1400, llm: 900 }),
    });

    // A silently dropped timeout would make the p50 look better than the call
    // actually was.
    expect(md).toMatch(/timed out|timeout/i);
    expect(md).toMatch(/1/);
  });

  it("excludes barge-in turns from the clean-turn percentiles", () => {
    const md = buildReport({
      runId: "run-3",
      callCount: 1,
      probeTurns: [
        { label: "u1", probeV2vMs: 1000, bargeIn: false, timedOut: false },
        { label: "u2", probeV2vMs: 50, bargeIn: true, timedOut: false },
      ],
      serverStats: stats({ trueV2v: 1000, llm: 600 }),
    });

    // A barge turn's reply overlaps the interruption, so its "latency" is not
    // comparable — pooling it would drag the p50 down for the wrong reason.
    expect(md).toMatch(/barge/i);
  });
});
