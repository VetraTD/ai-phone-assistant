// tests/outboundPolicy.test.js
/**
 * lib/outbound/policy.js's skipOnOutbound (S3-1, spec §19 S3-D1). The single
 * switchboard three call sites read to decide whether an inbound-only habit
 * (LVX132's ask-before-hangup gate, the spelling nudge, the gather_details/
 * confirm ask-gate fallback) applies on this call.
 */
import { describe, it, expect } from "vitest";
import { skipOnOutbound, INBOUND_ONLY } from "../lib/outbound/policy.js";

const NAMES = ["askBeforeHangup", "spellingNudge", "gatherDetailsFallback"];

describe("skipOnOutbound truth table", () => {
  for (const name of NAMES) {
    it(`${name}: true when isOutbound is true`, () => {
      expect(skipOnOutbound(name, true)).toBe(true);
    });

    it(`${name}: false when isOutbound is false`, () => {
      expect(skipOnOutbound(name, false)).toBe(false);
    });
  }

  it("an unknown name throws rather than silently failing open", () => {
    expect(() => skipOnOutbound("notARealHabit", true)).toThrow();
  });

  it("named risk 1: a truthy non-boolean isOutbound (e.g. {}) is NOT treated as true -- fails closed, not open", () => {
    expect(skipOnOutbound("askBeforeHangup", {})).toBe(false);
  });

  it("named risk 1b: a truthy non-boolean isOutbound stays false for every name", () => {
    for (const name of NAMES) {
      expect(skipOnOutbound(name, "yes")).toBe(false);
      expect(skipOnOutbound(name, 1)).toBe(false);
    }
  });

  it("INBOUND_ONLY is frozen and holds exactly the three names", () => {
    expect(Object.isFrozen(INBOUND_ONLY)).toBe(true);
    expect(Object.keys(INBOUND_ONLY).sort()).toEqual([...NAMES].sort());
  });
});
