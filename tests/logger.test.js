import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logger.js — recordTurnLatency dual-shape dispatch", () => {
  let writeSpy;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  function loggedLines() {
    return writeSpy.mock.calls.map((c) => JSON.parse(c[0]));
  }

  it("payload-object shape: recordTurnLatency(payload) emits one turn_latency line with the full payload", async () => {
    const { recordTurnLatency } = await import("../lib/logger.js");
    const payload = { callSid: "CA1", turnIndex: 0, voice_to_voice_ms: 450 };

    recordTurnLatency(payload);

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("turn_latency");
    expect(lines[0].callSid).toBe("CA1");
    expect(lines[0].voice_to_voice_ms).toBe(450);
  });

  it("legacy (businessId, ms) shape: does not emit turn_latency, and emits a latency_stats summary only every EMIT_EVERY (20) samples", async () => {
    const { recordTurnLatency } = await import("../lib/logger.js");

    for (let i = 0; i < 19; i++) {
      recordTurnLatency("biz-legacy-1", 100 + i);
    }
    expect(loggedLines().some((l) => l.event === "turn_latency")).toBe(false);
    expect(loggedLines().some((l) => l.event === "latency_stats")).toBe(false);

    recordTurnLatency("biz-legacy-1", 500); // 20th sample -> summary emitted
    const statsLines = loggedLines().filter((l) => l.event === "latency_stats");
    expect(statsLines).toHaveLength(1);
    expect(statsLines[0].businessId).toBe("biz-legacy-1");
    expect(statsLines[0].samples).toBe(20);
    expect(statsLines[0].max).toBe(500);
  });

  it("legacy shape with no businessId falls back to the 'default' key", async () => {
    const { recordTurnLatency } = await import("../lib/logger.js");

    for (let i = 0; i < 20; i++) {
      recordTurnLatency(undefined, 50);
    }
    const statsLines = loggedLines().filter((l) => l.event === "latency_stats");
    expect(statsLines).toHaveLength(1);
    expect(statsLines[0].businessId).toBe("default");
  });
});
