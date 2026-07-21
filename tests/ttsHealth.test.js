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

  it("an idle-socket close (1008) is NOT treated as quota — it must never open the breaker", () => {
    const h = createTtsHealth({ now: makeClock().now });
    const idle = new Error(
      "ElevenLabs TTS connection closed unexpectedly (Have not received a new text input within the timeout of 20 seconds. Streaming input terminated.)"
    );
    idle.code = "TTS_CONNECTION_CLOSED";
    idle.closeCode = 1008; // same code the API uses for a real quota rejection

    h.recordFailure(idle);
    h.recordFailure(idle);
    h.recordFailure(idle);

    expect(h.isHealthy()).toBe(true);
    expect(h.getState().consecutiveFailures).toBe(0);
  });

  it("an idle close does not reset a genuine failure streak", () => {
    const h = createTtsHealth({ now: makeClock().now });
    const real = new Error("socket error");
    const idle = Object.assign(new Error("Have not received a new text input"), { closeCode: 1008 });

    h.recordFailure(real);
    h.recordFailure(idle); // benign — ignored entirely
    h.recordFailure(real); // second REAL failure => breaker opens
    expect(h.isHealthy()).toBe(false);
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
