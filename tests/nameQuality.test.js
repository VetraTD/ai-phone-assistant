/**
 * Is this a name we are likely to have written down wrong?
 *
 * From a live call: the caller said "Venkateshwaria Ayalavarapu" and the row
 * in the database reads "Venkateshwaria Ayalla Varpu" — the surname split into
 * two mis-heard words. The assistant never asked for a spelling, and never said
 * the surname back, so nothing in the call could have caught it.
 *
 * WHAT THIS IS NOT. It is not a list of unusual names. That idea was considered
 * and rejected twice: we never see the name, only what the recognizer returned,
 * and the ledger's own case is "Nithin" coming back as "Nathan" — a very common
 * name, which a commonness check waves straight through. It only agrees with us
 * when the transcription was already right.
 *
 * So this keys on TRANSCRIPTION DIFFICULTY instead — length, syllable weight,
 * and how many pieces the name arrived in. Those are properties of the string
 * in front of us, not of where the name comes from, and they catch
 * "Featherstonehaugh" exactly as readily as "Ayalavarapu". The exclusions below
 * are what keep that claim honest.
 */

import { describe, it, expect } from "vitest";
import { looksHardToSpell } from "../lib/nameQuality.js";

describe("looksHardToSpell", () => {
  it("flags the name from the live call", () => {
    expect(looksHardToSpell("Venkateshwaria Ayalavarapu")).toBe(true);
    // ...and the mangled form actually stored, which arrived as three tokens.
    expect(looksHardToSpell("Venkateshwaria Ayalla Varpu")).toBe(true);
  });

  it("flags a long name regardless of where it comes from", () => {
    // The fairness check. A rule that only ever fires on non-Anglo names would
    // be asking some callers to spell and not others based on origin.
    expect(looksHardToSpell("Bartholomew Featherstonehaugh")).toBe(true);
    expect(looksHardToSpell("Konstantinos Papadopoulos")).toBe(true);
  });

  it("does NOT flag ordinary short names", () => {
    for (const name of ["Joe", "Sarah Smith", "Tom Brown", "Ana Diaz", "Li Wei", "Mary Jones"]) {
      expect(looksHardToSpell(name), `should not flag: ${name}`).toBe(false);
    }
  });

  it("does not flag a short non-Anglo name just for being non-Anglo", () => {
    // Directly the thing a name-frequency list would get wrong.
    for (const name of ["Raj Patel", "Ana Ruiz", "Yuki Tanaka", "Omar Khan"]) {
      expect(looksHardToSpell(name), `should not flag: ${name}`).toBe(false);
    }
  });

  it("flags a name that arrived in three or more pieces", () => {
    // The literal "Ayalla Varpu" signature: the recognizer split one surname
    // into two words, which is itself evidence it was unsure.
    expect(looksHardToSpell("Anna Maria Rodriguez Garcia")).toBe(true);
  });

  it("handles junk without throwing", () => {
    for (const junk of [null, undefined, "", "   ", 42, {}]) {
      expect(looksHardToSpell(junk)).toBe(false);
    }
  });

  it("ignores the 'my name is' preamble the caller actually says", () => {
    // Callers do not say bare names. Without stripping, the preamble inflates
    // both the token count and the length and everything looks hard.
    expect(looksHardToSpell("my name is Joe")).toBe(false);
    expect(looksHardToSpell("it's Sarah Smith")).toBe(false);
    expect(looksHardToSpell("my name is Venkateshwaria Ayalavarapu")).toBe(true);
  });
});
