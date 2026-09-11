import { describe, it, expect } from "vitest";

import { matchClaimSlot, slotParts } from "../lib/voice/live/claimSlot.js";

// ---------------------------------------------------------------------------
// LVX114's recovery half. Every positive below is a sentence a real call
// actually produced; the negatives are what stops it booking something nobody
// checked.
//
// This table IS the specification. The matcher was settled against it in a
// throwaway script before any of it reached lib/, and two defects came out of
// running it that reading it had not produced:
//
//   1. "at 1 AM" matched the 1 PM slot -- the bare-hour branch fired without
//      consuming the meridiem that contradicted it.
//   2. the month was not checked at all, so two slots a month apart on the same
//      day number both matched and cancelled each other out as "ambiguous".
//
// Anything not in this table is a guess, which is the standing note on
// completionClaimRe and applies here for the same reason.
// ---------------------------------------------------------------------------

/** The three times a real availability call offered on LVX114. */
const MON14 = ["2026-09-14T09:00", "2026-09-14T13:00", "2026-09-14T16:30"];

describe("slotParts", () => {
  it("reads a naive local key without a timezone anywhere", () => {
    expect(slotParts("2026-09-14T13:00")).toMatchObject({
      year: 2026,
      month: 9,
      day: 14,
      hour24: 13,
      minute: 0,
      weekday: "Monday",
      monthName: "September",
      hour12: 1,
      meridiem: "pm",
    });
  });

  it("rejects anything that is not a slot key", () => {
    for (const bad of ["", null, undefined, "Monday at 1", "2026-09-14", "2026-13-01T10:00"]) {
      expect(slotParts(bad)).toBeNull();
    }
  });

  it("puts midnight and noon on the right side of the meridiem", () => {
    expect(slotParts("2026-09-14T00:00")).toMatchObject({ hour12: 12, meridiem: "am" });
    expect(slotParts("2026-09-14T12:00")).toMatchObject({ hour12: 12, meridiem: "pm" });
  });
});

describe("matchClaimSlot — the sentences real calls produced", () => {
  it("LVX114: the fabricating turn names the slot that was verified", () => {
    expect(
      matchClaimSlot("Thanks, John. So, we're all set for Monday, September 14th, at 1 PM", MON14)
    ).toBe("2026-09-14T13:00");
  });

  it("LVX114: and so does the sentence 90 seconds later", () => {
    expect(
      matchClaimSlot(
        "You still have that strategy call booked for Monday, September 14th, at 1 PM.",
        MON14
      )
    ).toBe("2026-09-14T13:00");
  });

  it("LVX97: a spoken ordinal date and a spoken meridiem, no digits at all", () => {
    expect(
      matchClaimSlot(
        "So, we're all set for your free consultation on Wednesday, September ninth at one in the afternoon.",
        ["2026-09-09T09:00", "2026-09-09T13:00"]
      )
    ).toBe("2026-09-09T13:00");
  });

  it("LVX112: a slot with minutes", () => {
    expect(
      matchClaimSlot(
        "Perfect, thank you. So, that's all set for Monday, September 14th at 4:30 PM.",
        MON14
      )
    ).toBe("2026-09-14T16:30");
  });

  it("LVX113: 'tomorrow' names the day when a relative label is supplied", () => {
    expect(
      matchClaimSlot(
        "Perfect, I have you down for 9 AM tomorrow, for a strategy call.",
        ["2026-09-11T09:00", "2026-09-12T09:00"],
        { relativeLabelFor: (k) => (k.startsWith("2026-09-11") ? "tomorrow" : null) }
      )
    ).toBe("2026-09-11T09:00");
  });

  it("the UK spoken form: 'Monday the 7th of September at 4:30 PM'", () => {
    expect(
      matchClaimSlot(
        "I have you booked for a strategy call with the team on Monday the 7th of September at 4:30 PM UK time.",
        ["2026-09-07T09:00", "2026-09-07T16:30"]
      )
    ).toBe("2026-09-07T16:30");
  });

  it("LVX94: a bare hour with no meridiem, when only one slot could be meant", () => {
    expect(matchClaimSlot("You're all set for Wednesday at one.", ["2026-09-09T13:00"])).toBe(
      "2026-09-09T13:00"
    );
  });

  it("the day number survives a phone number in the same span", () => {
    expect(
      matchClaimSlot(
        "Okay, that's 469-933-8887? And what name should I book that under? " +
          "Thanks, John. So, we're all set for Monday, September 14th, at 1 PM",
        MON14
      )
    ).toBe("2026-09-14T13:00");
  });
});

describe("matchClaimSlot — what it must refuse", () => {
  it("THE SAFETY RULE: a time no availability call returned is unreachable", () => {
    expect(matchClaimSlot("We're all set for Monday, September 14th, at 2 PM.", MON14)).toBeNull();
  });

  it("nothing verified means nothing to complete", () => {
    expect(matchClaimSlot("So, we're all set for Monday, September 14th, at 1 PM", [])).toBeNull();
  });

  it("a claim with no time names no slot", () => {
    expect(matchClaimSlot("Great, we're all set.", MON14)).toBeNull();
  });

  it("a claim with no day names no slot", () => {
    expect(matchClaimSlot("We're all set for 1 PM.", MON14)).toBeNull();
  });

  it("two candidates is a refusal, not a coin toss", () => {
    expect(
      matchClaimSlot("We're all set for Monday at 1 PM.", ["2026-09-14T13:00", "2026-09-21T13:00"])
    ).toBeNull();
  });

  it("a bare hour that could be either of two verified slots matches neither", () => {
    expect(
      matchClaimSlot("You're all set for Wednesday at one.", [
        "2026-09-09T01:00",
        "2026-09-09T13:00",
      ])
    ).toBeNull();
  });

  it("an explicit contradicting meridiem is not a missing one", () => {
    // The defect the fixture run found: "at 1 AM" used to match 13:00.
    expect(
      matchClaimSlot("We're all set for Monday, September 14th, at 1 AM.", ["2026-09-14T13:00"])
    ).toBeNull();
  });

  it("'14th' does not satisfy the 4:30 slot's hour", () => {
    expect(
      matchClaimSlot("We're all set for Monday, September 14th, at 1 PM", ["2026-09-14T16:30"])
    ).toBeNull();
  });

  it("a bare hour must not swallow the minutes after it", () => {
    // FROM THE CALL, 2026-09-11. The transcript renders half past four as
    // "4 30pm" with NO COLON, and the bare-hour branch read that as "at 4":
    // the no-meridiem lookahead only rejected an IMMEDIATELY following
    // meridiem, and " 30pm" is not one. Both 16:00 and 16:30 matched, the
    // sentence was declared ambiguous, and a booking that existed was reported
    // as slot_unverified.
    //
    // Same class as the "at 1 AM" defect above -- a bare hour accepting a
    // token that contradicts it -- and it survived that fix because every
    // fixture in this table used the colon form. The call did not.
    const sentence =
      "We have your strategy call scheduled for Tuesday, September 15th at 4 30pm.";
    expect(matchClaimSlot(sentence, ["2026-09-15T16:00"])).toBeNull();
    expect(matchClaimSlot(sentence, ["2026-09-15T16:30"])).toBe("2026-09-15T16:30");
    expect(matchClaimSlot(sentence, ["2026-09-15T16:00", "2026-09-15T16:30"])).toBe(
      "2026-09-15T16:30"
    );
  });

  it("a whole day of open slots does not make every claim ambiguous", () => {
    // 32 verified slots is what a two-day availability query actually produced.
    const slots = [];
    for (let h = 9; h <= 16; h += 1) {
      for (const day of ["14", "15"]) {
        slots.push(`2026-09-${day}T${String(h).padStart(2, "0")}:00`);
        slots.push(`2026-09-${day}T${String(h).padStart(2, "0")}:30`);
      }
    }
    expect(slots).toHaveLength(32);
    expect(
      matchClaimSlot(
        "We have your strategy call scheduled for Tuesday, September 15th at 4 30pm.",
        slots
      )
    ).toBe("2026-09-15T16:30");
  });

  it("minutes must be spoken — '4 PM' cannot reach 4:30", () => {
    expect(
      matchClaimSlot("We're all set for Monday, September 14th, at 4 PM.", ["2026-09-14T16:30"])
    ).toBeNull();
  });

  it("a cancellation sentence names no booking slot", () => {
    expect(matchClaimSlot("That appointment has been cancelled.", MON14)).toBeNull();
  });

  it("a phone number on its own is not a date and not a time", () => {
    expect(
      matchClaimSlot("Great, so that's all set — I have your number as 469-933-8887.", MON14)
    ).toBeNull();
  });
});

describe("matchClaimSlot — the month is a veto", () => {
  const TWO_MONTHS = ["2026-09-14T13:00", "2026-10-14T13:00"];

  it("the named month decides between two identical day numbers", () => {
    expect(matchClaimSlot("We're all set for October 14th at 1 PM.", TWO_MONTHS)).toBe(
      "2026-10-14T13:00"
    );
    expect(matchClaimSlot("We're all set for September 14th at 1 PM.", TWO_MONTHS)).toBe(
      "2026-09-14T13:00"
    );
  });

  it("a month matching no verified slot matches nothing", () => {
    expect(matchClaimSlot("We're all set for November 14th at 1 PM.", TWO_MONTHS)).toBeNull();
  });

  it("but a claim naming no month at all is still matchable", () => {
    expect(matchClaimSlot("You're all set for Wednesday at one.", ["2026-09-09T13:00"])).toBe(
      "2026-09-09T13:00"
    );
  });
});
