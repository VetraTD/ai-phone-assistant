// ---------------------------------------------------------------------------
// Round A1 "say it once" (2026-10-13): the detectors the booking save rule reads.
//
// readBackStatementRe — the owner's read-back shape, "Tuesday at 3 for Jon Doe,
// booking that now". confirmReadBackRe only knows OFFERS ("shall I book
// that?"), so the sentence the owner asked for was not a read-back to the gate
// at all, and every booking said that way would have been refused and read
// back a second time.
//
// Prototyped before it was written on all 416 assistant turns in call-corpus/
// and tests/fixtures/liveCalls/: 8 hits, every one a real read-back of a write
// the model was about to make (seven already matched confirmReadBackRe, the
// eighth is "I'll book that strategy call ... Please confirm these details").
// None of the 8, and none of the owner's forms below, is a completion claim --
// "booking that now" said BEFORE the write lands must never trip the claim
// guard.
//
// spelledLettersRe -- a surname said back one letter at a time (LVX172). Eight
// hits on the same 416 turns, every one a real spelling.
//
// callerObjects -- the other half of "save unless it HEARS a no". Scored on all
// 351 caller turns on disk: against agreesAfterReadBack it changes only turns
// with nothing readable in them (""), which is the point -- a garbled or silent
// answer to a read-back is not a no.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { getStrings } from "../lib/voice/strings.js";
import { callerObjects } from "../lib/transcriptUtils.js";

const EN = getStrings({});
const ES = getStrings("es");

describe("readBackStatementRe — the owner's 'booking that now' read-back", () => {
  it.each([
    "Tuesday at 3 for Jon Doe, booking that now.",
    "Tuesday at 3 PM for Jon, D-O-D-L-A, booking that now.",
    "Okay, Tuesday at 3 for Jon Doe. I'll book that now.",
    "Wednesday the 14th at 11:30 AM for Nithin, D-O-D-L-A, moving it now.",
    "Got it, Jon, D-O-D-L-A, on 469 933 8887, about the website quote, passing that on now.",
    // real, corpus
    "Great. I'll book that strategy call for you on Tuesday, September 22nd at 9:00 AM. Please confirm these details.",
    "Just to confirm, I am booking your free strategy call for Friday, September 25th at 1 PM. Shall I go ahead and finalize that?",
    "Just to confirm, I'll go ahead and reschedule your appointment to Tuesday, September 22nd at 2 30 PM. Shall I proceed?",
  ])("recognises %j", (s) => {
    expect(EN.readBackStatementRe.test(s)).toBe(true);
  });

  it.each([
    "That's booked for Monday, September 21st at 9:00 AM under Joshua Tite.",
    "Your appointment on Wednesday, September 23 at 9 00 AM is now cancelled.",
    "What day and time would you like to book?",
    "Can I get your full name, please?",
    "I can book that for you. What time works best?",
    "Is there anything else I can help you with today?",
    "We're booking up fast on Fridays, so Thursday might be easier.",
  ])("does not read %j as a read-back", (s) => {
    expect(EN.readBackStatementRe.test(s)).toBe(false);
  });

  it.each([
    "Tuesday at 3 for Jon Doe, booking that now.",
    "Tuesday at 3 PM for Jon, D-O-D-L-A, booking that now.",
    "Okay, Tuesday at 3 for Jon Doe. I'll book that now.",
    "Got it, Jon, D-O-D-L-A, on 469 933 8887, about the website quote, passing that on now.",
  ])("is never a completion claim: %j", (s) => {
    expect(EN.completionClaimRe.test(s)).toBe(false);
    expect(EN.completionClaimWideRe.test(s)).toBe(false);
  });

  it("has a Spanish twin", () => {
    expect(ES.readBackStatementRe.test("El martes a las 3 para Juan, lo reservo ahora.")).toBe(true);
    expect(ES.readBackStatementRe.test("¿Qué día le viene bien?")).toBe(false);
  });
});

describe("spelledLettersRe — a name said back letter by letter", () => {
  it.each([
    "Tuesday at 3 PM for Jon, D-O-D-L-A, booking that now.",
    "Got it, Marcus Bell — M A R C U S B E L L.",
    "That is spelled N-I-T-H-I-N, and Dodla D-O-D-L-A. Is that correct?",
    "I have that as D. O. D. L. A.",
  ])("finds the letters in %j", (s) => {
    expect(EN.spelledLettersRe.test(s)).toBe(true);
  });

  it.each([
    "Tuesday at 3 PM for Jon Dodla, booking that now.",
    "I'll book that for 3 PM on Tuesday.",
    "Is that A or B?",
    "Your number is 469 933 8887.",
  ])("finds none in %j", (s) => {
    expect(EN.spelledLettersRe.test(s)).toBe(false);
  });

  it("is the same pattern in Spanish", () => {
    expect(ES.spelledLettersRe.test("Para Juan, D-O-D-L-A, lo reservo ahora.")).toBe(true);
  });
});

describe("callerObjects — the answer to a read-back that stops a booking", () => {
  it.each([
    ["no", "No."],
    ["a withdrawal", "Actually, wait."],
    ["a question", "What time was that?"],
    ["a different time", "Make it four."],
    ["a different day", "Can we do Friday instead"],
    ["a hedge", "Let me think about that."],
    ["a bare hesitation", "Um."],
  ])("objects to %s: %j", (_label, s) => {
    expect(callerObjects(s)).toBe(true);
  });

  it.each([
    ["a yes", "Yes, please."],
    ["a mangled yes", "da, ja, das"],
    ["a loose yes", "I love it."],
    ["silence", ""],
    ["nothing at all", undefined],
    ["noise", "..."],
    ["a failed transcription", "[inaudible]"],
    ["no worries", "Yeah, no worries."],
  ])("does not object to %s: %j", (_label, s) => {
    expect(callerObjects(s)).toBe(false);
  });

  // T5b. The silence ladder's first rung is "Hello? Are you still there?", and
  // the natural answer carries an apology. NEGATION_RE (shared, not widened or
  // narrowed here) lists "sorry", so "Yes, sorry." read as an objection and a
  // caller who answered the ladder was asked to confirm again. "Sorry" is not
  // an objection when everything else in the turn is a yes or "I'm here"; it
  // still is when it marks a correction.
  it.each([
    ["a yes with an apology", "Yes, sorry."],
    ["an apology and presence", "Sorry, yes, I'm still here."],
    ["presence then apology", "I'm here, sorry."],
    ["yeah, sorry", "Yeah sorry"],
  ])("does not object to %s: %j", (_label, s) => {
    expect(callerObjects(s)).toBe(false);
  });

  it.each([
    ["a name correction", "Sorry, it's John with an H."],
    ["a time correction", "Tuesday, sorry, Wednesday."],
    ["a bare apology", "Sorry."],
    ["a pardon", "Sorry?"],
    ["an apology and a no", "Sorry, no."],
  ])("still objects to %s: %j", (_label, s) => {
    expect(callerObjects(s)).toBe(true);
  });

  it("lets a caller restate the slot being written (LVX144)", () => {
    expect(callerObjects("2 p.m. works.")).toBe(true);
    expect(callerObjects("2 p.m. works.", { restatedSlot: true })).toBe(false);
    // ...but a restated slot inside a withdrawal or a question is still one.
    expect(callerObjects("No, 2 p.m. is no good.", { restatedSlot: true })).toBe(true);
    expect(callerObjects("2 p.m.?", { restatedSlot: true })).toBe(true);
  });
});
