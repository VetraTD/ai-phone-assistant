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

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { looksHardToSpell, shouldConfirmSpelling, callerHasNameOnFile } from "../lib/nameQuality.js";

// ---------------------------------------------------------------------------
// THE CLOCK IS FROZEN. See tests/whichAppointment.test.js for what happens
// otherwise: its fixture held an appointment at 15:00Z on 5 September 2026, and
// at 15:00Z on 5 September 2026 that row stopped being "upcoming". Ten tests
// went red mid-session on a change that touched nothing they import.
//
// Every file carrying a hard-coded date near today has the same shape, so they
// all get the same guard rather than waiting to find out one at a time. Friday
// 4 September 2026 sits before every fixture date in this repository.
// ---------------------------------------------------------------------------
const FROZEN_NOW = new Date("2026-09-04T12:00:00Z");

beforeAll(() => {
  // shouldAdvanceTime, NOT a bare useFakeTimers(). Several of these files settle
  // async work with a real setTimeout, and a frozen timer queue never fires it:
  // the run hangs rather than failing, which is the worst way for a test to be
  // wrong. This pins the DATE while leaving timers working.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});


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

// ---------------------------------------------------------------------------
// Round 3, 2026-08-29. Two complaints that pull in opposite directions:
// names still stored misspelled, AND one call where the assistant asked for the
// name and its spelling two or three separate times.
//
// The owner's rule: ask ONCE, only when the name is not already on file, and
// only when something is about to be written. So the decision needs three
// inputs, not one — which is why looksHardToSpell alone was never enough.
// ---------------------------------------------------------------------------
describe("shouldConfirmSpelling — the whole decision, not just difficulty", () => {
  const ctx = (over = {}) => ({
    name: "Aoife Nic Ghabhann",
    callerContext: null,
    spellingSettled: false,
    policy: "always",
    ...over,
  });

  it("asks once for a name it has never seen", () => {
    expect(shouldConfirmSpelling(ctx())).toBe(true);
  });

  it("asks for an ordinary-looking name too, under the default policy", () => {
    // "Scripps" heard as "Smith" is a confident mis-hearing of a short name —
    // exactly what looksHardToSpell cannot see, and exactly what ends up in
    // the business's records.
    expect(shouldConfirmSpelling(ctx({ name: "John Smith" }))).toBe(true);
  });

  it("never asks twice in one call", () => {
    expect(shouldConfirmSpelling(ctx({ spellingSettled: true }))).toBe(false);
  });

  it("never asks a caller whose name is already on file", () => {
    // The record IS the spelling. Asking a returning caller to spell a name the
    // business already has right is the 2-3 asks complaint in miniature.
    const callerContext = {
      callCount: 3,
      upcomingAppointments: [{ client_name: "Aoife Nic Ghabhann", scheduled_at: "2026-09-01T10:00:00Z" }],
    };
    expect(shouldConfirmSpelling(ctx({ callerContext }))).toBe(false);
  });

  it("matches an on-file name loosely — case, spacing and the caller's preamble", () => {
    const callerContext = {
      callCount: 1,
      upcomingAppointments: [{ client_name: "aoife  nic ghabhann" }],
    };
    expect(shouldConfirmSpelling(ctx({ callerContext, name: "my name is Aoife Nic Ghabhann" }))).toBe(false);
  });

  it("still asks when the name on file is a DIFFERENT person", () => {
    // A shared handset. The record does not vouch for this caller's spelling.
    const callerContext = {
      callCount: 2,
      upcomingAppointments: [{ client_name: "Marcus Webb" }],
    };
    expect(shouldConfirmSpelling(ctx({ callerContext }))).toBe(true);
  });

  it("falls back to the difficulty heuristic under policy 'hard'", () => {
    expect(shouldConfirmSpelling(ctx({ name: "John Smith", policy: "hard" }))).toBe(false);
    expect(shouldConfirmSpelling(ctx({ name: "Venkateshwaria Ayalavarapu", policy: "hard" }))).toBe(true);
  });

  it("never asks under policy 'off'", () => {
    expect(shouldConfirmSpelling(ctx({ policy: "off" }))).toBe(false);
    expect(shouldConfirmSpelling(ctx({ name: "Venkateshwaria Ayalavarapu", policy: "off" }))).toBe(false);
  });

  it("does not ask when there is no name to ask about", () => {
    for (const junk of [null, undefined, "", "   ", 42]) {
      expect(shouldConfirmSpelling(ctx({ name: junk }))).toBe(false);
    }
  });
});

describe("callerHasNameOnFile — suppressing the prompt nudge for a known caller", () => {
  it("is true when the call-start snapshot carries a name", () => {
    expect(
      callerHasNameOnFile({ upcomingAppointments: [{ client_name: "Aoife Nic Ghabhann" }] })
    ).toBe(true);
  });

  it("is false for a caller with no history, or history with no name", () => {
    expect(callerHasNameOnFile(null)).toBe(false);
    expect(callerHasNameOnFile({ upcomingAppointments: [] })).toBe(false);
    expect(callerHasNameOnFile({ upcomingAppointments: [{ scheduled_at: "x" }] })).toBe(false);
    expect(callerHasNameOnFile({ upcomingAppointments: [{ client_name: "   " }] })).toBe(false);
  });
});
