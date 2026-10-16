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

// ---------------------------------------------------------------------------
// Round A1 part 4, F-C (call CAdefce6ab, 2026-10-16). The model's own
// read-back was "Wednesday at 10 for Priya Raman, R-A-M-A-N, booking that
// now." -- a bare hour, which no form above matches, so the write-order gate
// never saw it (readBackMade false at any timing) and handed sentence S on
// top of it: the caller heard the read-back twice. The flow steps taught that
// very shape ("Tuesday at 3 for Jon Doe").
//
// A bare hour is accepted ONLY anchored to the slot's own weekday ("<weekday>
// [<date>] at <hour>"), only on the hour, only for a daytime slot (07:00 to
// 19:59, where a bare hour has one reading), and only when no minute or
// meridiem follows it -- a following one was already checked above and
// disagreed. Word-bounded, so "at 1" never matches "at 10".
// ---------------------------------------------------------------------------
// 2026-10-21 is a Wednesday.
const WED = (hhmm) => `2026-10-21T${hhmm}`;

describe("readBackMentionsSlot — part 4: the weekday-anchored bare hour", () => {
  it("reads call b's own read-back (verbatim)", () => {
    expect(
      readBackMentionsSlot("Wednesday at 10 for Priya Raman, R-A-M-A-N, booking that now.", WED("10:00"))
    ).toBe(true);
  });

  it("reads the word form and a date between the weekday and the hour", () => {
    expect(readBackMentionsSlot("Wednesday at ten for Priya Raman, booking that now.", WED("10:00"))).toBe(true);
    expect(
      readBackMentionsSlot("Wednesday, October 21 at 10 for Priya Raman, booking that now.", WED("10:00"))
    ).toBe(true);
    expect(readBackMentionsSlot("Wednesday the 21st at 2 for Maya, booking that now.", WED("14:00"))).toBe(true);
  });

  it("never lets 'at 1' match 'at 10' (word-bounded)", () => {
    expect(readBackMentionsSlot("Wednesday at 10 for Priya Raman, booking that now.", WED("13:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at 10 for Priya Raman, booking that now.", WED("01:00"))).toBe(false);
  });

  it("refuses a following minute or a contradicting meridiem", () => {
    expect(readBackMentionsSlot("Wednesday at 10 30 for Priya, booking that now.", WED("10:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at ten thirty for Priya, booking that now.", WED("10:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at 10 p.m. for Priya, booking that now.", WED("10:00"))).toBe(false);
  });

  it("refuses a night slot, where a bare hour has two readings", () => {
    expect(readBackMentionsSlot("Wednesday at 10 for Priya Raman, booking that now.", WED("22:00"))).toBe(false);
  });

  it("refuses the wrong weekday, and a bare hour with no weekday at all", () => {
    expect(readBackMentionsSlot("Thursday at 10 for Priya Raman, booking that now.", WED("10:00"))).toBe(false);
    expect(readBackMentionsSlot("At 10 for Priya Raman, booking that now.", WED("10:00"))).toBe(false);
    expect(readBackMentionsSlot("I can do 10 if that suits.", WED("10:00"))).toBe(false);
  });

  it("still emits no bare hour form from spokenTimeForms", () => {
    for (const form of spokenTimeForms(WED("10:00"))) {
      expect(form).not.toMatch(/^(?:\d{1,2}|ten)$/);
      expect(form).not.toMatch(/ at /);
    }
  });
});

// Round A1 part 4 (M, owner: in part 4). The digit forms were found by
// SUBSTRING, so "1 pm" sat inside "11 pm" and a read-back of 11 p.m. vouched
// for a 1 p.m. write (likewise 12 -> 2, 11:00 -> 1:00, 1130pm -> 130pm). Every
// form is now matched as whole words in the normalized read-back.
// 2026-10-23 is a Friday.
const FRI23 = (hhmm) => `2026-10-23T${hhmm}`;

describe("readBackMentionsSlot — part 4: forms match whole words only", () => {
  it("never lets an 11 or a 12 vouch for a 1 or a 2", () => {
    expect(readBackMentionsSlot("Friday at 11 pm, booking that now.", FRI23("13:00"))).toBe(false);
    expect(readBackMentionsSlot("Friday at 11:00 p.m., booking that now.", FRI23("13:00"))).toBe(false);
    expect(readBackMentionsSlot("Friday at 11 o'clock, booking that now.", FRI23("13:00"))).toBe(false);
    expect(readBackMentionsSlot("Friday at 12 pm, booking that now.", FRI23("14:00"))).toBe(false);
    expect(readBackMentionsSlot("Friday at 12:30 p.m., booking that now.", FRI23("14:30"))).toBe(false);
    expect(readBackMentionsSlot("Friday at 1130pm, booking that now.", FRI23("13:30"))).toBe(false);
  });

  it("still reads each slot's own form, wherever it sits in the sentence", () => {
    expect(readBackMentionsSlot("Friday at 1 pm, booking that now.", FRI23("13:00"))).toBe(true);
    expect(readBackMentionsSlot("Friday at 1:00 p.m., booking that now.", FRI23("13:00"))).toBe(true);
    expect(readBackMentionsSlot("Friday at one p.m., booking that now.", FRI23("13:00"))).toBe(true);
    expect(readBackMentionsSlot("Friday at 11 pm, booking that now.", FRI23("23:00"))).toBe(true);
    expect(readBackMentionsSlot("1:30 pm on Friday, booking that now.", FRI23("13:30"))).toBe(true);
    expect(readBackMentionsSlot("Booking Friday at 2 p.m.", FRI23("14:00"))).toBe(true);
    expect(readBackMentionsSlot("Friday at noon.", FRI23("12:00"))).toBe(true);
  });
});

// Round A1 part 4, opus review I1 (owner 2026-10-16). Hour 7 had two readings
// inside the old 07:00-19:59 window; the window is now 08:00-18:59, where every
// bare hour has one. Only a date may sit between the weekday and the hour, and
// a part of the day after it ("in the evening") is not this slot.
describe("readBackMentionsSlot — part 4 review: one reading only", () => {
  it("never reads a bare 7, morning or evening", () => {
    expect(readBackMentionsSlot("Wednesday at 7 for Priya, booking that now.", WED("07:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at 7 for Priya, booking that now.", WED("19:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at seven for Priya, booking that now.", WED("19:00"))).toBe(false);
    // The meridiem still reads, as before.
    expect(readBackMentionsSlot("Wednesday at 7 p.m. for Priya, booking that now.", WED("19:00"))).toBe(true);
  });

  it("reads the window's edges, 8 a.m. and 6 p.m.", () => {
    expect(readBackMentionsSlot("Wednesday at 8 for Priya, booking that now.", WED("08:00"))).toBe(true);
    expect(readBackMentionsSlot("Wednesday at 6 for Priya, booking that now.", WED("18:00"))).toBe(true);
  });

  it("refuses a part of the day between the weekday and the hour", () => {
    expect(readBackMentionsSlot("Wednesday evening at 10 for Priya, booking that now.", WED("10:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday morning at 3 for Priya, booking that now.", WED("15:00"))).toBe(false);
  });

  it("refuses a part of the day after the hour", () => {
    expect(readBackMentionsSlot("Wednesday at 10 in the evening, booking that now.", WED("10:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at 6 in the morning, booking that now.", WED("18:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at 9 tonight, booking that now.", WED("09:00"))).toBe(false);
    expect(readBackMentionsSlot("Wednesday at 8 at night, booking that now.", WED("08:00"))).toBe(false);
  });

  it("open text: a bare hour that is the last word proves nothing yet", () => {
    const open = { open: true };
    expect(readBackMentionsSlot("I'll book you in for Wednesday at ten", WED("10:00"), open)).toBe(false);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at ten for Priya", WED("10:00"), open)).toBe(true);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at ten.", WED("10:00"), open)).toBe(true);
    // At turn end the text is whole, and the same words read.
    expect(readBackMentionsSlot("I'll book you in for Wednesday at ten", WED("10:00"))).toBe(true);
  });
});

// Opus review M8: whole-word matching dropped a form with a colon or quote at
// its edge.
describe("readBackMentionsSlot — part 4 review: edge punctuation", () => {
  it("reads '3 pm:' and a quoted '3 pm'", () => {
    expect(readBackMentionsSlot("Friday at 3 pm: is that right?", FRI23("15:00"))).toBe(true);
    expect(readBackMentionsSlot("Friday at '3 pm' for Jon.", FRI23("15:00"))).toBe(true);
    expect(readBackMentionsSlot("Friday at 3 o'clock for Jon.", FRI23("15:00"))).toBe(true);
  });
});

// Opus RE-review M2/M4: open text (the read-back wait) needs a whole next word
// that cannot begin a minute, meridiem or part of the day still arriving, and
// a full stop right after a digit does not close it ("at 10." may be "10.30").
describe("readBackMentionsSlot — part 4 re-review: open text", () => {
  const open = { open: true };
  it("waits on a part of the day, a meridiem or a minute that is still arriving", () => {
    expect(readBackMentionsSlot("I'll book you in for Wednesday at 10 in", WED("10:00"), open)).toBe(false);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at 10 in the", WED("10:00"), open)).toBe(false);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at 10 p", WED("10:00"), open)).toBe(false);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at ten thir", WED("10:00"), open)).toBe(false);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at 10 for", WED("10:00"), open)).toBe(false);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at 10 for Priya", WED("10:00"), open)).toBe(true);
  });

  it("a full stop after a digit does not close open text; after a word it does", () => {
    expect(readBackMentionsSlot("I'll book you in for Wednesday at 10.", WED("10:00"), open)).toBe(false);
    expect(readBackMentionsSlot("I'll book you in for Wednesday at ten.", WED("10:00"), open)).toBe(true);
    // Finished text reads as before.
    expect(readBackMentionsSlot("I'll book you in for Wednesday at 10.", WED("10:00"))).toBe(true);
  });
});
