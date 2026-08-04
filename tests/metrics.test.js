import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecordTurnLatency = vi.fn();

vi.mock("../lib/logger.js", () => ({
  recordTurnLatency: (...args) => mockRecordTurnLatency(...args),
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  createTurnMetrics,
  getLatencyStats,
  getCallStats,
  clearStats,
  recordHoldRule,
  _ringBuffer,
} from "../lib/voice/metrics.js";

describe("metrics.js — per-turn latency tracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStats();
  });

  describe("mark/finishTurn deltas", () => {
    it("computes correct deltas from injected timestamps", () => {
      const tracker = createTurnMetrics("CA123");
      tracker.mark("speech_end", 1000);
      tracker.mark("stt_final", 1050);
      tracker.mark("llm_request", 1060);
      tracker.mark("llm_first_chunk", 1300);
      tracker.mark("tts_first_byte", 1450);
      tracker.mark("first_audio_sent", 1500);

      const payload = tracker.finishTurn();

      expect(payload).not.toBeNull();
      expect(payload.callSid).toBe("CA123");
      expect(payload.speech_end).toBe(0);
      expect(payload.stt_final).toBe(50);
      expect(payload.llm_request).toBe(60);
      expect(payload.llm_first_chunk).toBe(300);
      expect(payload.tts_first_byte).toBe(450);
      expect(payload.first_audio_sent).toBe(500);

      expect(payload.stt_tail_ms).toBe(50); // stt_final - speech_end
      expect(payload.llm_ttfb_ms).toBe(240); // llm_first_chunk - llm_request
      expect(payload.tts_ttfb_ms).toBe(150); // tts_first_byte - llm_first_chunk
      expect(payload.voice_to_voice_ms).toBe(500); // first_audio_sent - speech_end
    });

    it("marks raw values relative to first mark when speech_end is absent", () => {
      const tracker = createTurnMetrics("CA124");
      tracker.mark("llm_request", 2000);
      tracker.mark("llm_first_chunk", 2200);

      const payload = tracker.finishTurn();

      expect(payload.llm_request).toBe(0);
      expect(payload.llm_first_chunk).toBe(200);
      expect(payload.llm_ttfb_ms).toBe(200);
      // Not present -> null deltas
      expect(payload.stt_tail_ms).toBeNull();
      expect(payload.tts_ttfb_ms).toBeNull();
      expect(payload.voice_to_voice_ms).toBeNull();
    });

    it("merges extra fields into the payload (e.g. barged_in)", () => {
      const tracker = createTurnMetrics("CA125");
      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 400);

      const payload = tracker.finishTurn({ barged_in: true });

      expect(payload.barged_in).toBe(true);
      expect(payload.voice_to_voice_ms).toBe(400);
    });

    it("calls logger.recordTurnLatency with the finished payload", () => {
      const tracker = createTurnMetrics("CA126");
      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 100);
      const payload = tracker.finishTurn();

      expect(mockRecordTurnLatency).toHaveBeenCalledTimes(1);
      expect(mockRecordTurnLatency).toHaveBeenCalledWith(payload);
    });

    it("increments turnIndex per finished turn, starting at 0", () => {
      const tracker = createTurnMetrics("CA127");

      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 100);
      const first = tracker.finishTurn();
      expect(first.turnIndex).toBe(0);

      tracker.mark("speech_end", 200);
      tracker.mark("first_audio_sent", 300);
      const second = tracker.finishTurn();
      expect(second.turnIndex).toBe(1);
    });
  });

  describe("repeat marks and insufficient marks", () => {
    it("ignores repeat marks of the same name within a turn", () => {
      const tracker = createTurnMetrics("CA128");
      tracker.mark("speech_end", 0);
      tracker.mark("speech_end", 999); // should be ignored — first value wins
      tracker.mark("first_audio_sent", 500);

      const payload = tracker.finishTurn();
      expect(payload.speech_end).toBe(0);
      expect(payload.voice_to_voice_ms).toBe(500);
    });

    it("returns null and records nothing when fewer than 2 marks were set", () => {
      const tracker = createTurnMetrics("CA129");
      tracker.mark("speech_end", 0);

      const payload = tracker.finishTurn();
      expect(payload).toBeNull();
      expect(mockRecordTurnLatency).not.toHaveBeenCalled();
      expect(_ringBuffer.length).toBe(0);
    });

    it("returns null with zero marks", () => {
      const tracker = createTurnMetrics("CA130");
      const payload = tracker.finishTurn();
      expect(payload).toBeNull();
    });

    it("starts a new turn implicitly after finishTurn, even a null-returning one", () => {
      const tracker = createTurnMetrics("CA131");
      tracker.mark("speech_end", 0); // only 1 mark -> null turn
      expect(tracker.finishTurn()).toBeNull();

      // New turn begins; previous marks must not leak in.
      tracker.mark("speech_end", 1000);
      tracker.mark("first_audio_sent", 1200);
      const payload = tracker.finishTurn();
      expect(payload.voice_to_voice_ms).toBe(200);
    });

    it("never throws even with odd inputs", () => {
      const tracker = createTurnMetrics("CA132");
      expect(() => tracker.mark(undefined)).not.toThrow();
      expect(() => tracker.mark("speech_end", "not-a-number")).not.toThrow();
      expect(() => tracker.finishTurn()).not.toThrow();
    });
  });

  describe("ring buffer", () => {
    it("evicts the oldest entry once more than 500 turns are recorded", () => {
      for (let i = 0; i < 501; i++) {
        const tracker = createTurnMetrics(`CA-${i}`);
        tracker.mark("speech_end", 0);
        tracker.mark("first_audio_sent", 10);
        tracker.finishTurn();
      }

      expect(_ringBuffer.length).toBe(500);
      // The very first call (CA-0) should have been evicted; the most recent
      // (CA-500) should still be present as the last entry.
      expect(_ringBuffer.some((p) => p.callSid === "CA-0")).toBe(false);
      expect(_ringBuffer[_ringBuffer.length - 1].callSid).toBe("CA-500");
    });

    it("clearStats() empties the ring buffer", () => {
      const tracker = createTurnMetrics("CA200");
      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 10);
      tracker.finishTurn();
      expect(_ringBuffer.length).toBe(1);

      clearStats();
      expect(_ringBuffer.length).toBe(0);
    });
  });

  describe("getLatencyStats()", () => {
    it("computes p50/p95/max on a known distribution", () => {
      // voice_to_voice_ms values: 100, 200, 300, ..., 1000 (10 samples)
      for (let i = 1; i <= 10; i++) {
        const tracker = createTurnMetrics(`CA-dist-${i}`);
        tracker.mark("speech_end", 0);
        tracker.mark("first_audio_sent", i * 100);
        tracker.finishTurn();
      }

      const stats = getLatencyStats();
      expect(stats.count).toBe(10);
      // p50 of [100..1000] step 100, ceil(0.5*10)-1 = idx 4 -> 500
      expect(stats.byStage.voice_to_voice_ms.p50).toBe(500);
      // p95: ceil(0.95*10)-1 = idx 9 -> 1000
      expect(stats.byStage.voice_to_voice_ms.p95).toBe(1000);
      expect(stats.byStage.voice_to_voice_ms.max).toBe(1000);
    });

    it("returns last 20 payloads as recent", () => {
      for (let i = 0; i < 25; i++) {
        const tracker = createTurnMetrics(`CA-recent-${i}`);
        tracker.mark("speech_end", 0);
        tracker.mark("first_audio_sent", 10);
        tracker.finishTurn();
      }
      const stats = getLatencyStats();
      expect(stats.recent.length).toBe(20);
      expect(stats.recent[stats.recent.length - 1].callSid).toBe("CA-recent-24");
    });

    it("returns null p50/p95/max for a stage with no samples", () => {
      const tracker = createTurnMetrics("CA-nostage");
      // Only llm timings, no speech_end/first_audio_sent -> voice_to_voice_ms null
      tracker.mark("llm_request", 0);
      tracker.mark("llm_first_chunk", 50);
      tracker.finishTurn();

      const stats = getLatencyStats();
      expect(stats.byStage.voice_to_voice_ms.p50).toBeNull();
      expect(stats.byStage.llm_ttfb_ms.p50).toBe(50);
    });

    it("returns count 0 and empty recent on a fresh ring buffer", () => {
      const stats = getLatencyStats();
      expect(stats.count).toBe(0);
      expect(stats.recent).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Deltas added so the four original stages stop hiding the two segments the
  // server could not previously see: Deepgram's endpointing/network tail
  // (before speech_end) and the pacing pump's queue-to-wire gap (after
  // first_audio_sent). Without these, "endpointing dominates" and "our own
  // hold logic dominates" are indistinguishable in the numbers.
  // -------------------------------------------------------------------------
  describe("out-of-process deltas (stt_endpoint_ms, playout_ms, true_v2v_ms)", () => {
    it("measures the Deepgram tail as audio_speech_end -> speech_end", () => {
      const tracker = createTurnMetrics("CA-endpoint");
      tracker.mark("audio_speech_end", 1000); // caller actually stopped talking
      tracker.mark("speech_end", 1380); // we heard about it 380ms later
      tracker.mark("first_audio_sent", 1900);

      const payload = tracker.finishTurn();

      expect(payload.stt_endpoint_ms).toBe(380);
    });

    it("measures the pacing pump as first_audio_sent -> first_frame_wire", () => {
      const tracker = createTurnMetrics("CA-playout");
      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 500); // handed to the jitter buffer
      tracker.mark("first_frame_wire", 560); // actually written to Twilio

      const payload = tracker.finishTurn();

      expect(payload.playout_ms).toBe(60);
    });

    it("measures true_v2v_ms end to end, wider than voice_to_voice_ms", () => {
      const tracker = createTurnMetrics("CA-truev2v");
      tracker.mark("audio_speech_end", 0);
      tracker.mark("speech_end", 380);
      tracker.mark("first_audio_sent", 1500);
      tracker.mark("first_frame_wire", 1560);

      const payload = tracker.finishTurn();

      expect(payload.voice_to_voice_ms).toBe(1120); // what we reported before
      expect(payload.true_v2v_ms).toBe(1560); // what the caller actually waits
    });

    it("leaves the new deltas null when the extra marks are absent", () => {
      const tracker = createTurnMetrics("CA-legacy");
      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 400);

      const payload = tracker.finishTurn();

      expect(payload.stt_endpoint_ms).toBeNull();
      expect(payload.playout_ms).toBeNull();
      expect(payload.true_v2v_ms).toBeNull();
      expect(payload.voice_to_voice_ms).toBe(400);
    });

    it("reports the new stages in getLatencyStats().byStage", () => {
      const tracker = createTurnMetrics("CA-stats");
      tracker.mark("audio_speech_end", 0);
      tracker.mark("speech_end", 300);
      tracker.mark("first_audio_sent", 1000);
      tracker.mark("first_frame_wire", 1040);
      tracker.finishTurn();

      const stats = getLatencyStats();
      expect(stats.byStage.stt_endpoint_ms.p50).toBe(300);
      expect(stats.byStage.playout_ms.p50).toBe(40);
      expect(stats.byStage.true_v2v_ms.p50).toBe(1040);
    });
  });

  // -------------------------------------------------------------------------
  // classifyHold charges 1500-2000ms per branch. The rule is logged today but
  // never aggregated, so "the hold is expensive" cannot be narrowed to WHICH
  // branch is expensive and how often it fires.
  // -------------------------------------------------------------------------
  describe("recordHoldRule — per-classifyHold-branch attribution", () => {
    it("accumulates count and total ms per rule", () => {
      recordHoldRule("no_terminal_punctuation", 1500);
      recordHoldRule("no_terminal_punctuation", 1500);
      recordHoldRule("partial_digits", 1500);

      const { holdRules } = getLatencyStats();
      expect(holdRules.no_terminal_punctuation).toEqual({ count: 2, totalMs: 3000 });
      expect(holdRules.partial_digits).toEqual({ count: 1, totalMs: 1500 });
    });

    it("counts zero-cost rules so the no-hold share stays visible", () => {
      recordHoldRule("terminal_punctuation", 0);

      const { holdRules } = getLatencyStats();
      expect(holdRules.terminal_punctuation).toEqual({ count: 1, totalMs: 0 });
    });

    it("ignores unknown rule names rather than inventing metrics", () => {
      recordHoldRule("typo_rule", 1500);
      expect(getLatencyStats().holdRules.typo_rule).toBeUndefined();
    });

    it("never throws on bad input", () => {
      expect(() => recordHoldRule(undefined, undefined)).not.toThrow();
      expect(() => recordHoldRule("partial_digits", "nope")).not.toThrow();
    });

    it("is cleared by clearStats()", () => {
      recordHoldRule("partial_digits", 1500);
      clearStats();
      expect(getLatencyStats().holdRules.partial_digits).toEqual({ count: 0, totalMs: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // cachedContentTokenCount is captured in gemini.js but dropped before it
  // leaves the module, so prompt-cache hit rate has never been observable.
  // -------------------------------------------------------------------------
  describe("getLatencyStats().cache — prompt cache hit rate", () => {
    function turnWithTokens(callSid, cached, prompt) {
      const tracker = createTurnMetrics(callSid);
      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 100);
      tracker.finishTurn({ cached_tokens: cached, prompt_tokens: prompt });
    }

    it("reports the median hit rate across turns that carried token counts", () => {
      turnWithTokens("CA-c1", 800, 1000); // 80%
      turnWithTokens("CA-c2", 900, 1000); // 90%
      turnWithTokens("CA-c3", 1000, 1000); // 100%

      const { cache } = getLatencyStats();
      expect(cache.samples).toBe(3);
      expect(cache.hitRatePctP50).toBe(90);
    });

    it("reports a 0% hit rate distinctly from no data at all", () => {
      turnWithTokens("CA-cold", 0, 1200);

      const { cache } = getLatencyStats();
      expect(cache.samples).toBe(1);
      expect(cache.hitRatePctP50).toBe(0);
      expect(cache.turnsWithHit).toBe(0);
    });

    it("reports null hit rate when no turn carried token counts", () => {
      const tracker = createTurnMetrics("CA-notokens");
      tracker.mark("speech_end", 0);
      tracker.mark("first_audio_sent", 100);
      tracker.finishTurn();

      const { cache } = getLatencyStats();
      expect(cache.samples).toBe(0);
      expect(cache.hitRatePctP50).toBeNull();
    });
  });

  describe("getCallStats — per-call latency rollup", () => {
    it("computes avg/p95 voice_to_voice_ms filtered to a single callSid", () => {
      // 3 turns for CA-target: 100, 200, 300 -> avg 200
      for (const ms of [100, 200, 300]) {
        const tracker = createTurnMetrics("CA-target");
        tracker.mark("speech_end", 0);
        tracker.mark("first_audio_sent", ms);
        tracker.finishTurn();
      }
      // A turn for a different call — must not leak into the stats above.
      const other = createTurnMetrics("CA-other");
      other.mark("speech_end", 0);
      other.mark("first_audio_sent", 9999);
      other.finishTurn();

      const stats = getCallStats("CA-target");
      expect(stats.count).toBe(3);
      expect(stats.avgMs).toBe(200);
      expect(stats.p95Ms).toBe(300);
    });

    it("returns null when no turns were recorded for the callSid", () => {
      expect(getCallStats("CA-never-seen")).toBeNull();
    });
  });
});
