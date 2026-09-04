import { describe, it, expect, afterEach, vi } from "vitest";
import { isBusinessOpen } from "../services/gemini.js";
import { formatWeeklyHours } from "../lib/businessHours.js";

const WEEKLY_MON_FRI = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "17:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};

describe("isBusinessOpen — legacy + weekly business_hours shapes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when businessHours is null (always open)", () => {
    expect(isBusinessOpen({ businessHours: null, timezone: "UTC" })).toBe(true);
  });

  it("legacy shape: open within open_time/close_time window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T15:00:00Z")); // Monday 15:00 UTC
    expect(
      isBusinessOpen({
        businessHours: { open_time: "09:00", close_time: "17:00" },
        timezone: "UTC",
      })
    ).toBe(true);
  });

  it("legacy shape: closed outside open_time/close_time window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T20:00:00Z")); // Monday 20:00 UTC
    expect(
      isBusinessOpen({
        businessHours: { open_time: "09:00", close_time: "17:00" },
        timezone: "UTC",
      })
    ).toBe(false);
  });

  it("legacy shape: missing open_time/close_time treated as always open", () => {
    expect(isBusinessOpen({ businessHours: {}, timezone: "UTC" })).toBe(true);
  });

  it("weekly shape: open on a configured weekday within hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T15:00:00Z")); // Monday 15:00 UTC
    expect(isBusinessOpen({ businessHours: WEEKLY_MON_FRI, timezone: "UTC" })).toBe(true);
  });

  it("weekly shape: closed outside hours on an open day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T20:00:00Z")); // Monday 20:00 UTC
    expect(isBusinessOpen({ businessHours: WEEKLY_MON_FRI, timezone: "UTC" })).toBe(false);
  });

  it("weekly shape: closed on a day flagged closed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T15:00:00Z")); // Saturday 15:00 UTC
    expect(isBusinessOpen({ businessHours: WEEKLY_MON_FRI, timezone: "UTC" })).toBe(false);
  });

  it("weekly shape: a day entry with no open/close but not closed is treated as open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T03:00:00Z")); // Monday 03:00 UTC
    expect(
      isBusinessOpen({
        businessHours: { ...WEEKLY_MON_FRI, mon: { closed: false } },
        timezone: "UTC",
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LVX55. The prompt carried ONE day of hours -- "Business hours today
// (Thursday): 8:00 AM - 5:00 PM. Closed Sunday." -- so on a real call the model
// extrapolated the rest of the week from that single data point and told a
// caller "Monday through Friday, 8 to 5, closed Sundays". Two of those facts
// were wrong for Brightwork: Friday shuts at 4, and SATURDAY IS A TRADING DAY
// that was omitted entirely. The same absent schedule produced call 2's "we're
// actually closed that day" when availability refused a Saturday 15:30.
//
// resolveBusinessHoursForPrompt has the whole week in hand and deliberately
// collapses it to today + the NAMES of fully-closed days. This is the formatter
// that renders the rest, and these are the two facts the caller was told wrong.
// ---------------------------------------------------------------------------

// Brightwork Family Dental, as configured on the local rig: real dental hours,
// chosen so the demo tenant does not offer midnight appointments the way Digile
// Media legitimately does.
const BRIGHTWORK_HOURS = {
  mon: { open: "08:00", close: "17:00", closed: false },
  tue: { open: "08:00", close: "17:00", closed: false },
  wed: { open: "08:00", close: "17:00", closed: false },
  thu: { open: "08:00", close: "17:00", closed: false },
  fri: { open: "08:00", close: "16:00", closed: false },
  sat: { open: "09:00", close: "13:00", closed: false },
  sun: { open: null, close: null, closed: true },
};

describe("formatWeeklyHours — the whole week, not just today", () => {
  it("names Friday's earlier close and Saturday's hours (the two LVX55 got wrong)", () => {
    const text = formatWeeklyHours(BRIGHTWORK_HOURS);
    // The exact defect: told 5 PM on a Friday that shuts at 4.
    expect(text).toContain("Friday: 8:00 AM – 4:00 PM");
    // The worse defect: told the practice is shut on a day it trades.
    expect(text).toContain("Saturday: 9:00 AM – 1:00 PM");
    expect(text).toContain("Sunday: closed");
  });

  it("collapses a run of identical days rather than listing seven lines", () => {
    expect(formatWeeklyHours(BRIGHTWORK_HOURS)).toContain("Monday to Thursday: 8:00 AM – 5:00 PM");
  });

  it("renders the full string for Brightwork", () => {
    expect(formatWeeklyHours(BRIGHTWORK_HOURS)).toBe(
      "Monday to Thursday: 8:00 AM – 5:00 PM. Friday: 8:00 AM – 4:00 PM. " +
        "Saturday: 9:00 AM – 1:00 PM. Sunday: closed."
    );
  });

  it("collapses a weekend of closed days too", () => {
    expect(formatWeeklyHours(WEEKLY_MON_FRI)).toBe(
      "Monday to Friday: 9:00 AM – 5:00 PM. Saturday to Sunday: closed."
    );
  });

  // Digile Media is configured 00:00-23:59 every day and legitimately offers
  // midnight appointments. A tenant with no hours at all must render nothing --
  // an always-open business has no weekly schedule to state.
  it("returns null for a business with no hours configured", () => {
    expect(formatWeeklyHours(null)).toBeNull();
    expect(formatWeeklyHours(undefined)).toBeNull();
  });

  // The legacy {open_time, close_time} shape has no per-day information at all,
  // so there is no week to render -- one line, and no invented weekday split.
  it("renders the legacy single-window shape as one line", () => {
    expect(formatWeeklyHours({ open_time: "09:00", close_time: "17:00" })).toBe(
      "Every day: 9:00 AM – 5:00 PM."
    );
  });

  it("returns null for a legacy shape missing either end of the window", () => {
    expect(formatWeeklyHours({ open_time: "09:00" })).toBeNull();
  });

  // resolveDayHours returns {closed:false, open:null, close:null} for a day
  // entry that is present but carries no window. Rendering "undefined" into
  // prompt text is the failure formatClockTime already exists to prevent.
  it("says open without inventing a window when a day has no times", () => {
    const hours = { ...BRIGHTWORK_HOURS, wed: { closed: false } };
    const text = formatWeeklyHours(hours);
    expect(text).toContain("Wednesday: open");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });
});
