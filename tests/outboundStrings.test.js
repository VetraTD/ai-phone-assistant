// tests/outboundStrings.test.js
//
// OUTBOUND CALLING (spec §9.5, owner decision D-a, session 2b, Task 17).
//
// getOutboundStrings is a SEPARATE accessor over a SEPARATE table
// (OUTBOUND_STRINGS), not extra keys on getStrings(config) -- see the Ruling
// recorded on that accessor in lib/voice/strings.js. This file certifies:
//
//   1. the new outbound closing phrases (signOffOutbound, "speak soon")
//      satisfy signOffRe, in both languages;
//   2. every CURRENT inbound farewell (the tests/liveGoodbyeExit.test.js
//      table) still satisfies signOffRe, so the new alternation did not
//      narrow anything it sits beside;
//   3. closingTicRe is untouched -- D-a is explicit that only signOffRe
//      changes, because closingTicRe is the LVX132 latch that unlocks
//      end_call and a widened closingTicRe would let Ava hang up without
//      asking;
//   4. O-9 (no first name -> drop it, never speak "null"/"undefined");
//   5. EN/ES key parity on the new table, the same guarantee
//      tests/strings.test.js already holds STRINGS to.

import { describe, it, expect } from "vitest";
import { getStrings, getOutboundStrings } from "../lib/voice/strings.js";

describe("getOutboundStrings — a separate accessor, not a field on getStrings", () => {
  it("accepts a language code or a config, exactly like getStrings", () => {
    expect(getOutboundStrings("en").nudgeOutbound1).toBe(getOutboundStrings({ languagesSpoken: ["en"] }).nudgeOutbound1);
    expect(getOutboundStrings("es").nudgeOutbound1).not.toBe(getOutboundStrings("en").nudgeOutbound1);
  });

  it("falls back to en for an unknown language, like getStrings", () => {
    expect(getOutboundStrings("xx").nudgeOutbound1).toBe(getOutboundStrings("en").nudgeOutbound1);
  });

  it("EN and ES carry exactly the same keys, with matching types", () => {
    const en = getOutboundStrings("en");
    const es = getOutboundStrings("es");
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(typeof es[key], key).toBe(typeof en[key]);
    }
  });

  it("does not add anything to getStrings(config) itself — inbound's accessor is unaffected", () => {
    // getStrings stays single-argument and inbound-only: no `.outbound` key,
    // no signOffOutbound, nothing new reachable from the table inbound reads.
    const inbound = getStrings("en");
    expect(inbound.signOffOutbound).toBeUndefined();
    expect(inbound.nudgeOutbound1).toBeUndefined();
    expect(inbound.goodbyeOutbound).toBeUndefined();
    expect(inbound.outbound).toBeUndefined();
  });
});

describe("signOffOutbound — O-9, no first name is dropped, never spoken as null/undefined", () => {
  it.each(["en", "es"])("%s: with a first name", (lang) => {
    const text = getOutboundStrings(lang).signOffOutbound("Priya");
    expect(text).toContain("Priya");
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/i);
  });

  it.each(["en", "es"])("%s: with no first name (null)", (lang) => {
    const text = getOutboundStrings(lang).signOffOutbound(null);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/i);
    expect(text.length).toBeGreaterThan(0);
  });

  it.each(["en", "es"])("%s: with no first name (undefined, the phone-number-absent shape)", (lang) => {
    const text = getOutboundStrings(lang).signOffOutbound(undefined);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/i);
  });
});

describe("signOffRe — the new outbound alternation (EN)", () => {
  const S = getStrings("en");

  it.each([
    ["Thanks for your time, Priya. Bye for now.", getOutboundStrings("en").signOffOutbound("Priya")],
    ["Thanks for your time. Bye for now.", getOutboundStrings("en").signOffOutbound(null)],
  ])("the canned signOffOutbound text arms the gate: %s", (_label, text) => {
    expect(S.signOffRe.test(text)).toBe(true);
  });

  it.each([
    "Thank you for your time, Priya. Speak soon!",
    "It was great chatting with you today. Speak soon.",
    "Thanks so much for your time, Priya. Take care.",
  ])("a model paraphrase of the outbound close still arms the gate: %s", (text) => {
    expect(S.signOffRe.test(text)).toBe(true);
  });

  it("does not arm on an ordinary mention of time or speaking again", () => {
    // Guards against the new alternation being loose enough to catch
    // ordinary mid-call sentences that merely mention time or a future call.
    expect(S.signOffRe.test("We really appreciate your time today — can I ask about your schedule?")).toBe(false);
    expect(S.signOffRe.test("I'll speak to my colleague and call you back soon.")).toBe(false);
  });
});

describe("signOffRe — the new outbound alternation (ES)", () => {
  const S = getStrings("es");

  it.each([
    ["Gracias por su tiempo, Priya. Hasta luego.", getOutboundStrings("es").signOffOutbound("Priya")],
    ["Gracias por su tiempo. Hasta luego.", getOutboundStrings("es").signOffOutbound(null)],
  ])("the canned signOffOutbound text arms the gate: %s", (_label, text) => {
    expect(S.signOffRe.test(text)).toBe(true);
  });

  it("a model paraphrase using 'nos hablamos pronto' still arms the gate", () => {
    expect(S.signOffRe.test("Gracias por su tiempo, Priya. Nos hablamos pronto.")).toBe(true);
  });
});

describe("signOffRe — every CURRENT inbound farewell still arms the gate (EN)", () => {
  const S = getStrings("en");

  // The same table tests/liveGoodbyeExit.test.js certifies against the real
  // detector wiring. Reproduced here as a plain regex table so this file can
  // prove the new alternation did not narrow anything sitting beside it,
  // without booting a Live session.
  const REAL_FAREWELLS = [
    "That's all set — I've booked your free strategy call for Friday, September 18th at 12:45 PM. Thanks for calling Digile Media, and have a wonderful day.",
    "I have cancelled your existing appointment on Friday, September eighteenth at four thirty PM. Thanks for calling Digile Media, and have a wonderful day.",
    "Thanks for calling Digile Media, and have a wonderful day.",
    "Thanks again for calling Digile Media, Marcus. Have a great day.",
  ];
  const BARE_FAREWELLS = [
    "Perfect. Have a wonderful afternoon.",
    "All sorted — have a fantastic day!",
    "Have a lovely weekend.",
  ];
  const NEGATIVES = [
    "I'll have a full day free on Tuesday if that suits you better?",
    "Monday the 7th at 4:30 PM works. What's your full name?",
  ];

  it.each(REAL_FAREWELLS)("real farewell still arms: %s", (text) => {
    expect(S.signOffRe.test(text)).toBe(true);
  });

  it.each(BARE_FAREWELLS)("bare farewell still arms: %s", (text) => {
    expect(S.signOffRe.test(text)).toBe(true);
  });

  it.each(NEGATIVES)("non-farewell still does not arm: %s", (text) => {
    expect(S.signOffRe.test(text)).toBe(false);
  });
});

describe("closingTicRe — D-a: untouched by this task, byte-identical", () => {
  it("EN closingTicRe is exactly the LVX132 latch, unchanged", () => {
    expect(getStrings("en").closingTicRe.source).toBe(
      "\\b(?:is|was)\\s+there\\s+anything\\s+else\\b|\\banything\\s+else\\s+(?:i|we)\\s+(?:can|could)\\b|\\banything\\s+else\\s+(?:for\\s+you|you\\s+need|today)\\b|\\banything\\s+else\\s+(?:you'?d|you\\s+would|you'?re\\s+wondering)\\b|\\b(?:what|how)\\s+else\\s+(?:can|could|may)\\s+(?:i|we)\\b|\\b(?:if|whether)\\s+(?:there'?s|there\\s+is)\\s+anything\\s+else\\b"
    );
  });

  it("ES closingTicRe is exactly the narrow 'algo mas' latch, unchanged", () => {
    expect(getStrings("es").closingTicRe.source).toBe("\\b(?:hay\\s+)?algo\\s+m[aá]s\\b");
  });

  it("the outbound closing phrases do not, on their own, satisfy closingTicRe", () => {
    // signOffOutbound is a farewell, not an "anything else?" ask -- it must
    // not double as the ask-gate latch.
    expect(getStrings("en").closingTicRe.test(getOutboundStrings("en").signOffOutbound("Priya"))).toBe(false);
    expect(getStrings("es").closingTicRe.test(getOutboundStrings("es").signOffOutbound("Priya"))).toBe(false);
  });
});
