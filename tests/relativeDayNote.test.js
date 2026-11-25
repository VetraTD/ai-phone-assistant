// Owner re-test call 1 (2026-11-25): the email said "When: 3:00 p.m. Sunday",
// not a date, although the notes asked for one. The email now adds the date a
// relative day word means, worked out from the call time in the business's
// time zone, and leaves anything it cannot pin to one future day as the caller
// said it. (The LVX61 tests for relativeDayLabel live in relativeDay.test.js.)
import { describe, expect, it } from "vitest";
import { resolvedDayNote, dayNoteLabel } from "../lib/relativeDay.js";

const WED_0104 = "2026-11-25T01:04:00Z"; // Wed 25 Nov 2026, 01:04 in London (GMT)
const TUE_1629 = "2026-11-24T16:29:00Z"; // Tue 24 Nov 2026, 16:29 in London
const SAT_0100 = "2026-11-28T01:00:00Z"; // Sat 28 Nov 2026, 01:00 in London
const LONDON = "Europe/London";

describe("resolvedDayNote", () => {
  it.each([
    ["3:00 p.m. Sunday", WED_0104, " (Sun 29 Nov)"],
    ["BA2490, 5:00 p.m., Sunday", WED_0104, " (Sun 29 Nov)"],
    ["Sunday 3.30pm", WED_0104, " (Sun 29 Nov)"],
    ["this Sunday at 3", WED_0104, " (Sun 29 Nov)"],
    ["SUNDAY", WED_0104, " (Sun 29 Nov)"],
    ["8:00 AM tomorrow", TUE_1629, " (Wed 25 Nov)"],
    ["tomorrow's flight at 9", TUE_1629, " (Wed 25 Nov)"],
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
    "Saturday morning or Sunday",
    "today or tomorrow",
    "Sunday or the one after",
    "this Sunday or the following one",
    "the Sunday after",
    "Mon-Fri",
    "Thu 26 Nov at 3pm",
    "26/11 at 3pm",
    "November 26, 2026 at 07:15",
    "26th at 3pm",
    // Review C1: a date the caller gave in words, ISO or with dots.
    "Sunday the sixth of December",
    "Sunday 2026-12-06 at 15:00",
    "Sunday 06.12.2026",
    "Sunday 6-12-26",
    "Sunday the first",
    "5:00 AM",
    "",
    "Cash",
  ])("leaves %j as said", (text) => {
    expect(resolvedDayNote(text, WED_0104, LONDON)).toBe("");
  });

  // Review I2: a past event must never get a future date.
  it.each([
    "left my wallet in the cab on Saturday night",
    "the driver was rude on Friday",
    "last Sunday",
    "Sunday, three days ago",
    "it happened on Monday",
    "I lost it Saturday",
  ])("leaves the past event %j as said", (text) => {
    expect(resolvedDayNote(text, WED_0104, LONDON)).toBe("");
  });

  it("the weekday the call is on is left as said (today or a week away)", () => {
    expect(resolvedDayNote("Tuesday at 4", TUE_1629, LONDON)).toBe("");
  });

  it("before 5am, the weekday just gone (six days ahead) is left as said (review M6)", () => {
    // "Friday night" said at 01:00 on Saturday most likely means the night just gone.
    expect(resolvedDayNote("Friday night", SAT_0100, LONDON)).toBe("");
    expect(resolvedDayNote("Sunday", SAT_0100, LONDON)).toBe(" (Sun 29 Nov)");
  });

  it("uses the business's time zone, not UTC", () => {
    // 01:04 UTC Wed is 19:04 Tue in Chicago: tomorrow is Wednesday there.
    expect(resolvedDayNote("tomorrow at 8", WED_0104, "America/Chicago")).toBe(" (Wed 25 Nov)");
  });

  it("British Summer Time: London is UTC+1 (review M9)", () => {
    // Sat 27 Jun 23:30 UTC is Sun 28 Jun 00:30 in London.
    expect(resolvedDayNote("tomorrow", "2026-06-27T23:30:00Z", LONDON)).toBe(" (Mon 29 Jun? said at 00:30, check the day)");
    expect(resolvedDayNote("Sunday", "2026-06-27T12:00:00Z", LONDON)).toBe(" (Sun 28 Jun)");
  });

  it("crosses a clock change, a month, a year and a leap day by calendar date", () => {
    expect(resolvedDayNote("Monday", "2026-03-28T12:00:00Z", LONDON)).toBe(" (Mon 30 Mar)");
    expect(resolvedDayNote("tomorrow", "2026-12-31T12:00:00Z", LONDON)).toBe(" (Fri 1 Jan)");
    expect(resolvedDayNote("Sunday", "2026-12-31T12:00:00Z", LONDON)).toBe(" (Sun 3 Jan)");
    expect(resolvedDayNote("tomorrow", "2028-02-28T12:00:00Z", LONDON)).toBe(" (Tue 29 Feb)");
  });

  it("no zone, a padded zone or a bad zone: the same default as the call path (review M8)", () => {
    // America/Chicago: 01:04 UTC Wed is 19:04 Tue, so tomorrow is Wednesday.
    expect(resolvedDayNote("tomorrow", WED_0104, null)).toBe(" (Wed 25 Nov)");
    expect(resolvedDayNote("tomorrow", WED_0104, "Not/AZone")).toBe(" (Wed 25 Nov)");
    expect(resolvedDayNote("tomorrow", WED_0104, " Europe/London ")).toBe(" (Thu 26 Nov? said at 01:04, check the day)");
  });

  it("a bad call time or non-text input: nothing", () => {
    expect(resolvedDayNote("tomorrow", "not a date", LONDON)).toBe("");
    expect(resolvedDayNote("tomorrow", null, LONDON)).toBe("");
    expect(resolvedDayNote(undefined, TUE_1629, LONDON)).toBe("");
    expect(resolvedDayNote(5, TUE_1629, LONDON)).toBe("");
  });
});

// Review I2/I3: only answers whose label asks when something will happen get a
// date; an address ("12 Friday Street") or a past trip ("Trip date") never does.
describe("dayNoteLabel", () => {
  it.each(["When", "when", "Pick-up time", "Time", "Airport flight", "Flight", "Departure", "Arrival", "Appointment", "Booking", "Preferred time"])(
    "%s takes a date",
    (label) => expect(dayNoteLabel(label)).toBe(true)
  );
  it.each(["Pickup", "Destination", "Trip date", "Trip details", "What happened", "Item", "Address", "Change", "Date of birth", "", null])(
    "%s never does",
    (label) => expect(dayNoteLabel(label)).toBe(false)
  );
});
