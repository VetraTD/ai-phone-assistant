// ---------------------------------------------------------------------------
// LVX61. On a real call at 21:37 on Thursday 3 September, with
//
//   Current: Thursday, September 3, 2026, 9:37 PM (America/Chicago).
//   When scheduling, always calculate from this real date.
//
// in its prompt, the assistant said "I see you already have an appointment
// scheduled for today, Friday, September 4th, at 3 pm." It had the date, it had
// an explicit instruction to calculate from it, and it still called tomorrow
// today. Nothing detects that: no tool was involved, the appointment is real,
// and the only wrong word is a relative one.
//
// This is not more prompt text telling it to try harder — the prompt already
// says that and was ignored. It is the server doing the arithmetic once and
// handing over the answer, so there is nothing left for the model to compute.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { relativeDayLabel } from "../lib/capabilities/datetime.js";

const CHICAGO = "America/Chicago";

// The exact instant of the defect: Thursday 2026-09-03 21:37 America/Chicago.
const THU_2137 = Date.parse("2026-09-04T02:37:00Z");

describe("relativeDayLabel — the server computes the relative day, not the model", () => {
  it("calls the NEXT calendar day tomorrow (the LVX61 sentence)", () => {
    // Friday 2026-09-04 15:00 Chicago — what it called "today".
    expect(relativeDayLabel("2026-09-04T20:00:00Z", CHICAGO, THU_2137)).toBe("tomorrow");
  });

  it("calls the same calendar day today", () => {
    // Thursday 2026-09-03 22:30 Chicago, still the same local date as 21:37.
    expect(relativeDayLabel("2026-09-04T03:30:00Z", CHICAGO, THU_2137)).toBe("today");
  });

  it("gives no relative word for anything further out", () => {
    // Saturday. There is no short word for it, so the model gets nothing and
    // the prompt tells it to name the weekday and date instead.
    expect(relativeDayLabel("2026-09-05T20:00:00Z", CHICAGO, THU_2137)).toBeNull();
    expect(relativeDayLabel("2026-09-10T20:00:00Z", CHICAGO, THU_2137)).toBeNull();
  });

  it("is computed in the BUSINESS timezone, not the process timezone", () => {
    // 2026-09-04T02:37Z is already Friday in London and still Thursday in
    // Chicago. An appointment at 2026-09-04T20:00Z is Friday in both, so the
    // same instant pair is "tomorrow" in Chicago and "today" in London.
    expect(relativeDayLabel("2026-09-04T20:00:00Z", CHICAGO, THU_2137)).toBe("tomorrow");
    expect(relativeDayLabel("2026-09-04T20:00:00Z", "Europe/London", THU_2137)).toBe("today");
  });

  it("crosses a month boundary by calendar date, not by adding 24 hours", () => {
    // Monday 2026-08-31 23:00 Chicago -> Tuesday 1 September is "tomorrow".
    const aug31 = Date.parse("2026-09-01T04:00:00Z");
    expect(relativeDayLabel("2026-09-01T18:00:00Z", CHICAGO, aug31)).toBe("tomorrow");
  });

  it("returns null rather than a wrong word for unparseable input", () => {
    expect(relativeDayLabel(null, CHICAGO, THU_2137)).toBeNull();
    expect(relativeDayLabel("not a date", CHICAGO, THU_2137)).toBeNull();
    expect(relativeDayLabel(undefined, CHICAGO, THU_2137)).toBeNull();
  });

  it("falls back to the default timezone rather than the process zone", () => {
    // Same contract as speakableDateTime and toLocalNaiveDateTime: an unset
    // business timezone must not silently mean "whatever zone the server runs
    // in", which is how one row got read back two different ways.
    expect(relativeDayLabel("2026-09-04T20:00:00Z", undefined, THU_2137)).toBe("tomorrow");
  });
});
