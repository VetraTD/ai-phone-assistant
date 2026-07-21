import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  createTtsHealth,
  QUOTA_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
} from "../lib/voice/ttsHealth.js";

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("ttsHealth.js — ElevenLabs circuit breaker", () => {
  it("starts healthy", () => {
    const h = createTtsHealth({ now: makeClock().now });
    expect(h.isHealthy()).toBe(true);
    expect(h.getState().open).toBe(false);
  });

  it("one transient failure does not open the breaker; two consecutive do", () => {
    const clock = makeClock();
    const h = createTtsHealth({ now: clock.now });

    const err = new Error("ElevenLabs TTS connection timed out");
    err.code = "TTS_CONNECT_TIMEOUT";

    h.recordFailure(err);
    expect(h.isHealthy()).toBe(true);

    h.recordFailure(err);
    expect(h.isHealthy()).toBe(false);
    expect(h.getState().reason).toBe("consecutive_failures");
  });

  it("transient cooldown expires", () => {
    const clock = makeClock();
    const h = createTtsHealth({ now: clock.now });
    const err = new Error("socket error");
    h.recordFailure(err);
    h.recordFailure(err);
    expect(h.isHealthy()).toBe(false);

    clock.advance(TRANSIENT_COOLDOWN_MS + 1);
    expect(h.isHealthy()).toBe(true);
  });

  it("a quota-signature failure (WS close 1008) opens immediately for the long cooldown", () => {
    const clock = makeClock();
    const h = createTtsHealth({ now: clock.now });
    const err = new Error("ElevenLabs TTS connection closed unexpectedly (quota_exceeded)");
    err.code = "TTS_CONNECTION_CLOSED";
    err.closeCode = 1008;

    h.recordFailure(err);
    expect(h.isHealthy()).toBe(false);
    expect(h.getState().reason).toBe("quota_or_auth");

    clock.advance(TRANSIENT_COOLDOWN_MS + 1);
    expect(h.isHealthy()).toBe(false); // still open — quota cooldown is longer

    clock.advance(QUOTA_COOLDOWN_MS);
    expect(h.isHealthy()).toBe(true);
  });

  it("a quota-message failure opens immediately even without a close code", () => {
    const h = createTtsHealth({ now: makeClock().now });
    h.recordFailure(new Error("quota exceeded for this billing period"));
    expect(h.isHealthy()).toBe(false);
    expect(h.getState().reason).toBe("quota_or_auth");
  });

  it("success closes the breaker and resets the failure streak", () => {
    const clock = makeClock();
    const h = createTtsHealth({ now: clock.now });
    const err = new Error("timeout");
    h.recordFailure(err);
    h.recordFailure(err);
    expect(h.isHealthy()).toBe(false);

    h.recordSuccess();
    expect(h.isHealthy()).toBe(true);
    expect(h.getState().consecutiveFailures).toBe(0);

    // Streak restarts — a single new failure must not re-open.
    h.recordFailure(err);
    expect(h.isHealthy()).toBe(true);
  });
});
