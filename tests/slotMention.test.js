// ---------------------------------------------------------------------------
// The matcher the consent latch is built on, tested against the sentences a
// model actually said on a phone call.
//
// It had no test file at all until 2026-09-17. Its accuracy lived in a comment
// ("11/11"), measured once by hand, and the sentences it was measured against
// were digit-clock sentences from gemini-3.1. When the estate moved to
// gemini-3.8-live the model started speaking the clock in WORDS and this
// function returned false on every read-back it was shown -- which the latch
// reads as "the caller never agreed to this time", which the write-order gate
// turns into a refusal. CA03558d made six booking attempts, wrote zero rows,
// and told the caller the appointment was confirmed.
//
// Every string in the first two blocks below is VERBATIM from
// call-corpus/*.json, with client names pseudonymised per the corpus README.
// Do not tidy them: the whole failure was a test that tidied "at ten o'clock"
// into "at 10 00 AM" and then passed.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readBackMentionsSlot, spokenTimeForms } from "../lib/voice/slotMention.js";

// 2026-09-18 is a Friday. Every corpus call was about that day.
const FRI = (hhmm) => `2026-09-18T${hhmm}`;

describe("readBackMentionsSlot — the word-clock 3.8 speaks", () => {
  // Six of the corpus's ten read-backs name the time in words. Before the word
  // forms landed, ALL SIX returned false.
  const WORD_READ_BACKS = [
    [
      "CA03558d, the read-back the caller agreed to before six refused writes",
      "I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?",
      FRI("15:30"),
    ],
    [
      "CA03558d, the cancellation read-back",
      "I have your appointment for Marcus Bell on Friday, September eighteenth at three o'clock ready to be cancelled. Is that correct?",
      FRI("15:00"),
    ],
    [
      "CA919b69, the first of the re-worded proposals",
      "I can book a thirty-minute strategy call for Marcus Bell on Friday, September eighteenth at three o'clock, if you confirm these details. Shall we go ahead?",
      FRI("15:00"),
    ],
    [
      "CA919b69, the same proposal re-worded a turn later",
      "Thank you, Marcus Bell. I have you booked for a strategy call on Friday, September eighteenth at three o'clock. Shall we confirm that booking?",
      FRI("15:00"),
    ],
    [
      "CA919b69, a hyphenated four-thirty",
      "I have found the appointment for Marcus Bell on Friday, September eighteenth at four-thirty PM. Should I go ahead and cancel this for you?",
      FRI("16:30"),
    ],
    [
      "CA5b982c, an unhyphenated four thirty",
      "Of course. I have an appointment under Elena Farrow on Friday, September eighteenth at four thirty PM. Is that the one you'd like to cancel?",
      FRI("16:30"),
    ],
  ];

  it.each(WORD_READ_BACKS)("matches %s", (_why, text, slot) => {
    expect(readBackMentionsSlot(text, slot)).toBe(true);
  });

  it("reads a menu of three times as naming the one being written", () => {
    // Not a read-back in the gate's sense, but the latch sees whatever text is
    // standing, and this shape occurs on five of the seven calls.
    const text =
      "We have a few openings that afternoon on Friday, September eighteenth, including three o'clock, three thirty, and four o'clock. Which of those times works best for you?";
    expect(readBackMentionsSlot(text, FRI("15:30"))).toBe(true);
    expect(readBackMentionsSlot(text, FRI("16:00"))).toBe(true);
    // ...and not one it never listed.
    expect(readBackMentionsSlot(text, FRI("17:00"))).toBe(false);
  });
});

describe("readBackMentionsSlot — the digit clock 3.1 spoke, which must keep working", () => {
  it("matches a bare PM hour", () => {
    expect(
      readBackMentionsSlot(
        "One second, I have that down for your free strategy call at 1 PM on Friday, September 18th. Shall we book that in for you?",
        FRI("13:00")
      )
    ).toBe(true);
  });

  it("matches a colon time", () => {
    expect(
      readBackMentionsSlot(
        "I have an opening this Friday, September 18 at 4:30 PM, or would you prefer another time?",
        FRI("16:30")
      )
    ).toBe(true);
  });

  it("matches the spaced form a transcript produces", () => {
    // CAf1d6447d34, the call this file was originally measured on.
    expect(
      readBackMentionsSlot(
        "Just to confirm, that is Wednesday, September 16th at 4 30 PM Central time. Shall I book it?",
        "2026-09-16T16:30"
      )
    ).toBe(true);
  });
});

describe("readBackMentionsSlot — what must stay false", () => {
  it("refuses a read-back that names no time at all", () => {
    // THE SPELLING CHECK. This is the sentence that was standing when
    // CA03558d's five refusals fired. It confirms a name, not a time, and it
    // must never be readable as consent to a slot.
    expect(readBackMentionsSlot("M-A-R-C-U-S B-E-L-L. Is that correct?", FRI("15:30"))).toBe(false);
    expect(
      readBackMentionsSlot(
        "Perfect, I have that as M A R C U S, B E L L. And do you want to confirm the best contact number?",
        FRI("15:30")
      )
    ).toBe(false);
  });

  it("refuses a read-back that names a DIFFERENT time", () => {
    // CA8c019c's shape, and the reason the latch needs this function at all:
    // consent given for one appointment must not be spendable on another.
    const threeThirty =
      "I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?";
    expect(readBackMentionsSlot(threeThirty, FRI("16:30"))).toBe(false);
    expect(readBackMentionsSlot(threeThirty, FRI("15:00"))).toBe(false);

    const fourThirty =
      "I have found the appointment for Marcus Bell on Friday, September eighteenth at four-thirty PM. Should I go ahead and cancel this for you?";
    expect(readBackMentionsSlot(fourThirty, FRI("15:30"))).toBe(false);
  });

  it("never matches on a bare hour word", () => {
    // Both verbatim from the corpus. "four" and "one" are ordinary English
    // words and an hour word is only ever emitted paired with a minute, a
    // meridiem or o'clock.
    expect(
      readBackMentionsSlot(
        "Of course, I can help with that. May I have your name and the last four digits of the phone number the appointment is booked under?",
        FRI("16:00")
      )
    ).toBe(false);
    expect(readBackMentionsSlot("One second, let me look that up for you.", FRI("13:00"))).toBe(
      false
    );
    expect(readBackMentionsSlot("We have two openings left that afternoon.", FRI("14:00"))).toBe(
      false
    );
  });

  it("refuses a read-back that names only the wrong weekday", () => {
    // A clock time cannot tell Friday at three from Thursday at three, and the
    // latch this feeds is what authorises the write.
    expect(
      readBackMentionsSlot(
        "I have you down for Thursday, September seventeenth at three thirty PM. Shall we go ahead?",
        FRI("15:30")
      )
    ).toBe(false);
  });

  it("does not require a weekday to be named", () => {
    expect(readBackMentionsSlot("I have you down for three thirty PM. Shall we go ahead?", FRI("15:30"))).toBe(true);
  });

  it("allows a read-back that names the right day beside a wrong one", () => {
    expect(
      readBackMentionsSlot(
        "Rather than Thursday, I have you down for Friday at three thirty PM. Shall we go ahead?",
        FRI("15:30")
      )
    ).toBe(true);
  });

  it("returns false rather than throwing on unusable input", () => {
    expect(readBackMentionsSlot("anything at all", "2026-09-18")).toBe(false);
    expect(readBackMentionsSlot("anything at all", "not a date")).toBe(false);
    expect(readBackMentionsSlot("anything at all", null)).toBe(false);
    expect(readBackMentionsSlot("", FRI("15:30"))).toBe(false);
    expect(readBackMentionsSlot(null, FRI("15:30"))).toBe(false);
    expect(readBackMentionsSlot(undefined, undefined)).toBe(false);
  });
});

describe("spokenTimeForms", () => {
  it("carries both clocks for a half hour", () => {
    const forms = spokenTimeForms(FRI("15:30"));
    expect(forms).toEqual(expect.arrayContaining(["3:30 pm", "3 30 pm", "330pm"]));
    expect(forms).toEqual(expect.arrayContaining(["three thirty", "three thirty pm", "half past three"]));
  });

  it("carries both clocks on the hour", () => {
    const forms = spokenTimeForms(FRI("15:00"));
    expect(forms).toEqual(expect.arrayContaining(["3 pm", "3 o'clock", "3:00 pm"]));
    expect(forms).toEqual(expect.arrayContaining(["three o'clock", "three pm"]));
  });

  it("emits no bare hour word", () => {
    for (const hhmm of ["09:00", "13:00", "15:30", "16:45", "12:00", "00:00"]) {
      for (const form of spokenTimeForms(FRI(hhmm))) {
        expect(form).not.toMatch(
          /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/
        );
      }
    }
  });

  it("covers the phrasings the header used to list as known misses", () => {
    expect(spokenTimeForms("2026-09-18T14:30")).toContain("half past two");
    expect(spokenTimeForms("2026-09-18T09:15")).toContain("quarter past nine");
    expect(spokenTimeForms("2026-09-18T16:45")).toContain("quarter to five");
    expect(spokenTimeForms("2026-09-18T12:00")).toContain("noon");
    expect(spokenTimeForms("2026-09-18T00:00")).toContain("midnight");
  });

  it("wraps midnight and noon onto twelve, not zero", () => {
    expect(spokenTimeForms("2026-09-18T00:30")).toEqual(expect.arrayContaining(["twelve thirty"]));
    expect(spokenTimeForms("2026-09-18T12:30")).toEqual(expect.arrayContaining(["twelve thirty"]));
  });

  it("returns null on anything that is not a naive datetime", () => {
    expect(spokenTimeForms("2026-09-18")).toBe(null);
    expect(spokenTimeForms("2026-09-18 15:30")).toBe(null);
    expect(spokenTimeForms(null)).toBe(null);
  });
});
