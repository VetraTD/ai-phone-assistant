// A mid-call socket drop is silence for the caller, and the fix for it is
// deliberately not built yet. This is the instrument that decides whether it
// needs to be: the RATE, on real calls, rather than an argument.
//
// Both counters exist on purpose. A fault-only counter reads zero for a clean
// call and for a call that never reached the socket at all.
import { describe, it, expect, beforeEach } from "vitest";
import { bumpCounter, getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { classifyClose } from "../lib/voice/live/closeKind.js";

const counters = () => getLatencyStats().turnTaking;

describe("classifyClose — telling a hang-up from a drop", () => {
  beforeEach(() => clearStats());

  it("a normal close is clean", () => {
    expect(classifyClose({ code: 1000, reason: "" })).toBe("clean");
  });

  it("a close with no event at all is clean — the vendor closed without saying why after a finished call", () => {
    expect(classifyClose(undefined)).toBe("clean");
  });

  it("a 1006 abnormal closure is abnormal", () => {
    expect(classifyClose({ code: 1006, reason: "" })).toBe("abnormal");
  });

  it("a 1011 internal error is abnormal", () => {
    expect(classifyClose({ code: 1011, reason: "internal error" })).toBe("abnormal");
  });

  it("a 1008 policy violation is abnormal — this is the vendor concurrency cap", () => {
    expect(classifyClose({ code: 1008, reason: "quota" })).toBe("abnormal");
  });

  it("both counters are registered so a zero can be read", () => {
    bumpCounter("live_close_clean");
    bumpCounter("live_close_abnormal");
    expect(counters().live_close_clean).toBe(1);
    expect(counters().live_close_abnormal).toBe(1);
  });
});
