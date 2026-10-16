// ---------------------------------------------------------------------------
// Round A1 part 4, F-F. The confirm audit counted read-back TURNS, so call b
// (CAdefce6ab, 2026-10-16) read saves_over_one_readback 0 although the caller
// heard the read-back twice in ONE turn -- the model's own "...booking that
// now" and the handed sentence, glued with no space by Live:
// "...booking that now.Wednesday, October 21 at 10:00 AM...".
//
// Prototyped on call b and on all 434 assistant turns in call-corpus/ first:
// counting every read-back SENTENCE over-counts the common "Friday at 2 PM for
// Jon. Shall I go ahead with that?" (10 turns, each one read-back). Counting
// the read-back sentences that NAME THE SLOT counts call b as 2 and every one
// of those 10 as 1.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  splitSentences,
  slotReadBackCount,
  isSpellAsk,
  readBackBeforeSpellAsk,
  namesPerson,
} from "../lib/voice/readBackCount.js";
import { getStrings } from "../lib/voice/strings.js";

const S = getStrings({ locale: "en-US" });
// Verbatim, call b 00:27:25 (CAdefce6ab). Wednesday 2026-10-21 10:00.
const CALL_B =
  "Wednesday at 10 for Priya Raman, R-A-M-A-N, booking that now.Wednesday, October 21 at 10:00 AM for Priya Raman, booking that now.You already have appointments scheduled for Monday at 11 AM, Tuesday at 2 PM, Thursday at 2 PM, and Friday at 2 PM. Would you like to add this new appointment for Wednesday at 10 AM to those, or reschedule one of the existing ones?";
const CALL_B_SLOT = "2026-10-21T10:00:00";
// Verbatim, call b 00:26:53: the read-back, then the spelling ask after it.
const CALL_B_SPELL =
  "Wednesday at 10 for Priya Raman, booking that now.Before I finalize that, could you please spell Priya's first and last name for me?";

describe("splitSentences", () => {
  it("splits call b's glued turn into its four sentences", () => {
    const parts = splitSentences(CALL_B);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("Wednesday at 10 for Priya Raman, R-A-M-A-N, booking that now.");
    expect(parts[1]).toBe("Wednesday, October 21 at 10:00 AM for Priya Raman, booking that now.");
  });

  it("never splits inside a.m. / p.m., a title, or spelled letters", () => {
    expect(splitSentences("Friday at 10 a.m. for Jon Dodla, booking that now.")).toHaveLength(1);
    expect(splitSentences("Friday at 2 P.M. for Jon Dodla, booking that now.")).toHaveLength(1);
    expect(splitSentences("Booking you with Dr. Patel on Friday at 2 p.m., booking that now.")).toHaveLength(1);
    expect(splitSentences("That's Jon, D. O. D. L. A., booking that now.")).toHaveLength(1);
    expect(splitSentences("That's D.O.D.L.A., booking that now.")).toHaveLength(1);
  });

  it("does split where a sentence really ends, meridiem or letters last", () => {
    expect(splitSentences("I have you at 2 p.m. Is there anything else?")).toHaveLength(2);
    expect(splitSentences("That's D-O-D-L-A. Is that right?")).toHaveLength(2);
    expect(splitSentences("Booked! Anything else?")).toHaveLength(2);
  });
});

describe("slotReadBackCount", () => {
  it("counts call b's turn as TWO read-backs of its slot", () => {
    expect(slotReadBackCount(CALL_B, CALL_B_SLOT, S)).toBe(2);
  });

  it("counts an offer and its trailing question as one", () => {
    expect(
      slotReadBackCount(
        "Just to confirm, I'll book your strategy call for Friday, September 18 at 2:00 PM. Shall I go ahead with that?",
        "2026-09-18T14:00:00",
        S
      )
    ).toBe(1);
  });

  it("does not count a sentence that only names the slot in a question", () => {
    // Call b's fourth sentence names Wednesday at 10 AM but reads nothing back.
    expect(
      slotReadBackCount(
        "Would you like to add this new appointment for Wednesday at 10 AM to those, or reschedule one of the existing ones?",
        CALL_B_SLOT,
        S
      )
    ).toBe(0);
  });

  it("never counts a read-back of another slot", () => {
    expect(slotReadBackCount(CALL_B, "2026-10-21T11:00:00", S)).toBe(0);
  });
});

describe("isSpellAsk (counters only)", () => {
  it("sees 'could you please spell', which the shared spellRequestRe misses", () => {
    expect(S.spellRequestRe.test(CALL_B_SPELL)).toBe(false);
    expect(isSpellAsk(CALL_B_SPELL, S)).toBe(true);
    expect(isSpellAsk("Could you please spell out your full name for me?", S)).toBe(true);
    expect(isSpellAsk("Could you spell your last name for me?", S)).toBe(true);
  });

  it("a spelled read-back is not an ask", () => {
    expect(isSpellAsk("That's Jon, D-O-D-L-A, booking that now.", S)).toBe(false);
    expect(isSpellAsk("Friday at 2 PM for Priya, booking that now. Please hold.", S)).toBe(false);
  });
});

describe("readBackBeforeSpellAsk", () => {
  it("sees call b's spelling ask after its own read-back", () => {
    expect(readBackBeforeSpellAsk(CALL_B_SPELL, S)).toBe(true);
  });

  it("an ask first, or an ask alone, is not after a read-back", () => {
    expect(
      readBackBeforeSpellAsk(
        "Could you spell your last name for me? Then I'll have Friday at 2 PM for you, booking that now.",
        S
      )
    ).toBe(false);
    expect(readBackBeforeSpellAsk("Could you spell your last name for me?", S)).toBe(false);
  });
});

describe("namesPerson", () => {
  it("first name or surname, whole word, any case", () => {
    expect(namesPerson("Wednesday at 10 for Priya, booking that now.", "Priya Raman")).toBe(true);
    expect(namesPerson("Wednesday at 10 under Raman, booking that now.", "Priya Raman")).toBe(true);
    expect(namesPerson("wednesday at 10 for PRIYA, booking that now.", "Priya Raman")).toBe(true);
  });

  it("no name, a longer name, or no name to look for", () => {
    // d1b (CA046f67): the owner heard no name at all.
    expect(namesPerson("Friday at 2 PM, booking that now.", "Nithin Dodla")).toBe(false);
    expect(namesPerson("Friday at 2 PM for Priyanka, booking that now.", "Priya Raman")).toBe(false);
    expect(namesPerson("Friday at 2 PM for Priya, booking that now.", null)).toBe(false);
  });
});
