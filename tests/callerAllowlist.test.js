import { describe, it, expect } from "vitest";
import { callerAllowlist, callerAllowed, buildRefusedTwiml } from "../lib/callerAllowlist.js";

// The compensating control for the 6 -> 4 merge that was written down and never
// built. Staging is about to hold the same Twilio account the production number
// lives on, so a real patient misdialling by a digit could reach a staging
// build — an environment whose residency cannot be enforced and whose database
// is outside the production backup and retention story.

describe("callerAllowlist", () => {
  it("is INACTIVE when unset, and that is the safe direction", () => {
    // Absence must never mean deny-all. Refusing real callers is the failure
    // this whole control exists to avoid causing.
    expect(callerAllowlist({}).active).toBe(false);
    expect(callerAllowlist({ CALLER_ALLOWLIST: "" }).active).toBe(false);
    expect(callerAllowlist({ CALLER_ALLOWLIST: "   " }).active).toBe(false);
  });

  it("parses a comma-separated E.164 list, tolerating whitespace", () => {
    const l = callerAllowlist({ CALLER_ALLOWLIST: " +15125551234 , +447700900123 " });
    expect(l.active).toBe(true);
    expect([...l.numbers].sort()).toEqual(["+15125551234", "+447700900123"]);
    expect(l.malformed).toEqual([]);
  });

  it("reports malformed entries instead of normalising them", () => {
    // Twilio delivers `From` in E.164. An entry in any other format can never
    // match, so silently accepting it produces an allowlist that looks
    // configured and admits nobody — including the tester it was written for.
    const l = callerAllowlist({ CALLER_ALLOWLIST: "+15125551234,5125551234,(512) 555-1234" });
    expect([...l.numbers]).toEqual(["+15125551234"]);
    expect(l.malformed).toEqual(["5125551234", "(512) 555-1234"]);
  });

  it("stays active when EVERY entry is malformed", () => {
    // The dangerous version: a typo'd list parses to zero numbers, reads as
    // "unset", and quietly lets the world through. Active-with-malformed is
    // what lets the boot check refuse instead.
    const l = callerAllowlist({ CALLER_ALLOWLIST: "5125551234" });
    expect(l.active).toBe(true);
    expect(l.numbers.size).toBe(0);
    expect(l.malformed).toHaveLength(1);
  });
});

describe("callerAllowed", () => {
  const list = callerAllowlist({ CALLER_ALLOWLIST: "+15125551234,+447700900123" });

  it("admits a listed caller", () => {
    expect(callerAllowed("+15125551234", list)).toBe(true);
    expect(callerAllowed("+447700900123", list)).toBe(true);
  });

  it("refuses everyone else", () => {
    expect(callerAllowed("+15125559999", list)).toBe(false);
    expect(callerAllowed("+441234567890", list)).toBe(false);
  });

  it("refuses a missing or blank caller when the list is active", () => {
    // Twilio can deliver an empty `From` for a withheld number. On staging that
    // is exactly the caller who should not get through.
    expect(callerAllowed("", list)).toBe(false);
    expect(callerAllowed(undefined, list)).toBe(false);
    expect(callerAllowed(null, list)).toBe(false);
  });

  it("admits everyone when the list is inactive", () => {
    const off = callerAllowlist({});
    expect(callerAllowed("+15125559999", off)).toBe(true);
    expect(callerAllowed("", off)).toBe(true);
  });

  it("does not match on a prefix or a substring", () => {
    // "+1512555123" must not get in on the strength of "+15125551234" existing.
    expect(callerAllowed("+1512555123", list)).toBe(false);
    expect(callerAllowed("+151255512345", list)).toBe(false);
  });
});

describe("buildRefusedTwiml", () => {
  it("hangs up", () => {
    const x = buildRefusedTwiml();
    expect(x).toContain("<Hangup/>");
    expect(x).toContain("<Response>");
  });

  it("does not disclose that an allowlist exists", () => {
    // A stranger who misdialled learns nothing useful from "you are not on the
    // allowlist", and a curious one learns that there is one.
    expect(buildRefusedTwiml().toLowerCase()).not.toMatch(/allowlist|not permitted|staging|test/);
  });
});
