import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecordTurnLatency = vi.fn();

vi.mock("../lib/logger.js", () => ({
  recordTurnLatency: (...args) => mockRecordTurnLatency(...args),
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  createTurnMetrics,
  getLatencyStats,
  clearStats,
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
});
