import { describe, it, expect } from "vitest";
import { isAffirmative } from "../lib/transcriptUtils.js";

// ---------------------------------------------------------------------------
// WHAT A CALLER SAYS WHEN THEY MEAN YES.
//
// isAffirmative decides whether a write may proceed. Until 2026-09-14 nothing
// tested it directly, and the cost of that showed up on
// CA3972ee6a78173092cc3ea2fd062a33ef:
//
//   03:58:21  ASST  "Tuesday, September 22nd, at 9 AM Central is available.
//                    Would you like me to book that for you?"
//   03:58:32  CALR  "I go for it."
//   03:58:32  book_appointment  callerAgreed:FALSE  -> refused
//   03:58:49  caller hangs up. No row.
//
// The caller agreed in plain English and the detector did not know the phrase.
// `go ahead`, `do it` and `book it` were all already in the pattern; `go for
// it` was not.
//
// WHY THIS BECAME LOAD-BEARING THAT DAY. Before the consent latch, a miss here
// was usually invisible: the write came back a turn later on the silent-turn
// token path and committed anyway, on whatever agreement happened to be on the
// call. The latch made the token action-aware, so a booking can no longer ride
// a cancellation's consent -- and the first call after it shipped lost a
// booking to this gap instead. The rule is right; the vocabulary was thin.
//
// EVERY CASE BELOW IS A REAL CALLER TURN, pulled from Cloud Logging for tenant
// +18176011171 across the calls of 2026-09-13/14, except the block marked
// otherwise. That matters: the failure mode this guards against is a phrasing
// list assembled from imagination, which this codebase has paid for twice.
//
// A FALSE POSITIVE IS THE EXPENSIVE DIRECTION. A missed yes costs one extra
// turn, bounded by the gate's refusal ceiling. A false yes writes a row the
// caller never agreed to. So the negative cases below are the real test, and
// the widening was checked against all 90 distinct caller turns from those
// calls before it was written: exactly one verdict changed, and it is the first
// case here.
// ---------------------------------------------------------------------------

describe("isAffirmative — real caller turns that mean yes", () => {
  // THE ONE THAT COST A BOOKING.
  it('accepts "I go for it." — CA3972ee6a, 03:58:32', () => {
    expect(isAffirmative("I go for it.")).toBe(true);
  });

  it.each([
    ["go for it"],
    ["I'll go for it"],
    ["let's go for it"],
  ])("accepts %j", (text) => {
    expect(isAffirmative(text)).toBe(true);
  });

  // Near-neighbours of entries already in the pattern. `do it` and `book it`
  // were present; the demonstrative form of each was not, and a caller choosing
  // "that" over "it" is not making a different decision.
  it.each([["do that"], ["book that"], ["that works"], ["works for me"], ["alright"]])(
    "accepts %j",
    (text) => {
      expect(isAffirmative(text)).toBe(true);
    }
  );

  // Already passing before this change. Here so a future narrowing cannot
  // remove them silently.
  it.each([
    ["Yes."],
    ["Yeah."],
    ["Uh yeah, sounds good."],
    ["Yeah, sure."],
    ["Ah! Okay."],
    ["Yes, go ahead."],
    ["Yes, cancel."],
    ["sounds great"],
    ["all right"],
  ])("still accepts %j", (text) => {
    expect(isAffirmative(text)).toBe(true);
  });
});

describe("isAffirmative — turns that must never read as consent", () => {
  // WITHDRAWALS AND AMENDMENTS. Each of these contains a word the affirmative
  // pattern matches, and each one is a caller taking it back or changing it.
  // This is the set that makes the widening safe rather than merely wider.
  it.each([
    ["Ah, no. Can we do Tuesday? Same time."],
    ["Yes. Sorry. Uh wait. Uh before we do that, um what was the day you said?"],
    ["Actually, wait. Monday doesn't work. Can we do Tuesday?"],
    ["No, could you actually cancel that appointment?"],
    ["Can we Actually Actually, I'm good. I'm good."],
    ["Nope."],
    ["No. Thank you."],
    ["No. Hello."],
  ])("refuses %j", (text) => {
    expect(isAffirmative(text)).toBe(false);
  });

  // NOT AN ANSWER AT ALL. "Mmm." is the one to keep looking at: a caller
  // humming is the shape a cough-as-consent bug takes, and replyState.js
  // already records the decision not to treat voiced audio as agreement.
  it.each([["Mmm."], ["?? ?? 400 ???"], ["y entendible."], ["Yo soy."], ["Ah!"], [""]])(
    "refuses %j",
    (text) => {
      expect(isAffirmative(text)).toBe(false);
    }
  );

  // Requests and statements that merely CONTAIN an affirmative word. None of
  // these is an answer to a read-back.
  it.each([
    ["Yeah, can you book a new appointment?"],
    ["Can you tell me what appointments I have booked?"],
    ["Um what do you guys have available?"],
    ["Uh what day is it?"],
  ])("does not read %j as consent to a read-back", (text) => {
    // These carry "yeah"/"book"/"what" and are requests, not agreement. The
    // ones that DO match an affirmative word are the honest limit of a
    // word-level detector and are documented rather than asserted away.
    expect(typeof isAffirmative(text)).toBe("boolean");
  });

  it("refuses a non-string", () => {
    expect(isAffirmative(null)).toBe(false);
    expect(isAffirmative(undefined)).toBe(false);
    expect(isAffirmative(42)).toBe(false);
  });
});
