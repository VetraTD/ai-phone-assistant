// Owner re-test call 1 (2026-11-25): the email said "When: 3:00 p.m. Sunday",
// not a date, although the notes asked for one. The email now adds the date a
// relative day word means, worked out from the call time in the business's
// time zone, and leaves anything it cannot pin to one day as the caller said it.
import { describe, expect, it } from "vitest";
import { resolvedDayNote } from "../lib/relativeDay.js";

const WED_0104 = "2026-11-25T01:04:00Z"; // Wed 25 Nov 2026, 01:04 in London (GMT)
const TUE_1629 = "2026-11-24T16:29:00Z"; // Tue 24 Nov 2026, 16:29 in London
const LONDON = "Europe/London";

describe("resolvedDayNote", () => {
  it.each([
    ["3:00 p.m. Sunday", WED_0104, " (Sun 29 Nov)"],
    ["BA2490, 5:00 p.m., Sunday", WED_0104, " (Sun 29 Nov)"],
    ["this Sunday at 3", WED_0104, " (Sun 29 Nov)"],
    ["SUNDAY", WED_0104, " (Sun 29 Nov)"],
    ["8:00 AM tomorrow", TUE_1629, " (Wed 25 Nov)"],
    ["Friday at 3:30 p.m.", TUE_1629, " (Fri 27 Nov)"],
    ["Monday morning", TUE_1629, " (Mon 30 Nov)"],
    ["today", TUE_1629, " (Tue 24 Nov)"],
    ["tonight at 9", TUE_1629, " (Tue 24 Nov)"],
    ["today at 6", WED_0104, " (Wed 25 Nov)"],
  ])("%s, said at %s -> %s", (text, at, note) => {
    expect(resolvedDayNote(text, at, LONDON)).toBe(note);
  });

  it("tomorrow or tonight said between midnight and 5am: the date, flagged to check", () => {
    expect(resolvedDayNote("tomorrow at 6am", WED_0104, LONDON)).toBe(" (Thu 26 Nov? said at 01:04, check the day)");
    expect(resolvedDayNote("tonight", WED_0104, LONDON)).toBe(" (Wed 25 Nov? said at 01:04, check the day)");
  });

  it.each([
    "next Sunday",
    "every Sunday",
    "Sundays",
    "Sunday week",
    "the day after tomorrow",
    "Saturday or Sunday",
    "Thu 26 Nov at 3pm",
    "26/11 at 3pm",
    "November 26, 2026 at 07:15",
    "26th at 3pm",
    "5:00 AM",
    "",
    "Cash",
  ])("leaves %j as said", (text) => {
    expect(resolvedDayNote(text, WED_0104, LONDON)).toBe("");
  });

  it("the weekday the call is on is left as said (today or a week away)", () => {
    expect(resolvedDayNote("Tuesday at 4", TUE_1629, LONDON)).toBe("");
  });

  it("uses the business's time zone, not UTC", () => {
    // 01:04 UTC Wed is 19:04 Tue in Chicago: tomorrow is Wednesday there.
    expect(resolvedDayNote("tomorrow at 8", WED_0104, "America/Chicago")).toBe(" (Wed 25 Nov)");
  });

  it("no time zone: UTC; a bad zone: UTC; a bad call time: nothing", () => {
    expect(resolvedDayNote("tomorrow", TUE_1629, null)).toBe(" (Wed 25 Nov)");
    expect(resolvedDayNote("tomorrow", TUE_1629, "Not/AZone")).toBe(" (Wed 25 Nov)");
    expect(resolvedDayNote("tomorrow", "not a date", LONDON)).toBe("");
    expect(resolvedDayNote("tomorrow", null, LONDON)).toBe("");
  });

  it("non-text input: nothing", () => {
    expect(resolvedDayNote(undefined, TUE_1629, LONDON)).toBe("");
    expect(resolvedDayNote(5, TUE_1629, LONDON)).toBe("");
  });
});
