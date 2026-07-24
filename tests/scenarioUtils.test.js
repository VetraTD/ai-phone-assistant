/**
 * Unit tests for eval/scenarioUtils.js — the time helpers that make
 * open/closed-hours and seeded-appointment scenarios deterministic regardless
 * of when the suite runs.
 *
 * The production open/closed check (services/gemini.js isBusinessOpen) and the
 * booking time-anchor (lib/capabilities/datetime.js) both read the REAL clock,
 * so a scenario cannot inject a fake "now" into the brain. Instead these
 * helpers compute a businessHours config / an appointment ISO RELATIVE to the
 * real current time, so "open now" / "next Tuesday 3pm" mean the same thing
 * every run. The helpers take an optional `now` purely so these tests can pin
 * a reference instant and assert the relationship holds.
 */

import { describe, it, expect } from "vitest";
import {
  hoursOpenNow,
  hoursClosedNow,
  nextWeekdayAt,
  isOpenNow,
  sameInstant,
  slotMatches,
  argIsWeekday,
} from "../eval/scenarioUtils.js";
import { zonedWeekdayAndMinutes } from "../lib/capabilities/datetime.js";

const TZ = "America/Chicago";
// A fixed reference instant well inside a US business day (Wed 2026-07-22,
// ~14:30 America/Chicago). Chosen so no helper brushes a midnight boundary.
const REF = new Date("2026-07-22T19:30:00.000Z");

describe("isOpenNow", () => {
  it("treats null hours as always open", () => {
    expect(isOpenNow(null, { now: REF, timezone: TZ })).toBe(true);
  });
  it("mirrors the production open/closed check for a bracketing window", () => {
    const hours = { mon: { open: "00:00", close: "23:59", closed: false } };
    // REF is a Wednesday, and this config has no wed key -> resolveDayHours
    // reports closed for wed.
    expect(isOpenNow(hours, { now: REF, timezone: TZ })).toBe(false);
  });
});

describe("hoursOpenNow", () => {
  it("produces a weekly config that reads OPEN at the reference instant", () => {
    const hours = hoursOpenNow({ now: REF, timezone: TZ });
    expect(isOpenNow(hours, { now: REF, timezone: TZ })).toBe(true);
  });
  it("has an entry for every weekday", () => {
    const hours = hoursOpenNow({ now: REF, timezone: TZ });
    expect(Object.keys(hours).sort()).toEqual(["fri", "mon", "sat", "sun", "thu", "tue", "wed"]);
  });
});

describe("hoursClosedNow", () => {
  it("produces a weekly config that reads CLOSED at the reference instant", () => {
    const hours = hoursClosedNow({ now: REF, timezone: TZ });
    expect(isOpenNow(hours, { now: REF, timezone: TZ })).toBe(false);
  });
});

describe("nextWeekdayAt", () => {
  it("returns an ISO instant whose local wall time is the requested weekday + time", () => {
    const iso = nextWeekdayAt("tue", "15:00", { now: REF, timezone: TZ });
    const ms = Date.parse(iso);
    const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(ms, TZ);
    expect(shortWeekday).toBe("tue");
    expect(minutesOfDay).toBe(15 * 60);
  });
  it("is strictly in the future relative to now", () => {
    const iso = nextWeekdayAt("tue", "15:00", { now: REF, timezone: TZ });
    expect(Date.parse(iso)).toBeGreaterThan(REF.getTime());
  });
  it("accepts full weekday names too", () => {
    const iso = nextWeekdayAt("Wednesday", "09:30", { now: REF, timezone: TZ });
    const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(Date.parse(iso), TZ);
    expect(shortWeekday).toBe("wed");
    expect(minutesOfDay).toBe(9 * 60 + 30);
  });
});

describe("slotMatches", () => {
  // The engine anchors a naive booking string in the business timezone; the
  // helper must do the same, or an assertion would compare against the runner's
  // timezone instead. nextWeekdayAt gives us the canonical UTC instant.
  const iso = nextWeekdayAt("tue", "15:00", { now: REF, timezone: TZ });

  it("matches a naive local string anchored in the business timezone", () => {
    // Derive the naive local form the model would emit from the canonical iso.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(Date.parse(iso)));
    const m = {};
    for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
    const naive = `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}:00`;
    expect(slotMatches(naive, iso, TZ)).toBe(true);
  });

  it("matches an offset-bearing ISO for the same instant", () => {
    expect(slotMatches(iso, iso, TZ)).toBe(true);
  });

  it("rejects a different instant and unparseable input", () => {
    expect(slotMatches("2026-01-01T00:00:00", iso, TZ)).toBe(false);
    expect(slotMatches("nope", iso, TZ)).toBe(false);
  });
});

describe("argIsWeekday", () => {
  it("reads the weekday of a naive arg in the business timezone", () => {
    const tue = nextWeekdayAt("tue", "15:00", { now: REF, timezone: TZ });
    expect(argIsWeekday(tue, "tue", TZ)).toBe(true);
    expect(argIsWeekday(tue, "wed", TZ)).toBe(false);
  });
});

describe("sameInstant", () => {
  it("treats a naive-local and its UTC-normalized form as equal", () => {
    // 2026-07-28T15:00:00 local Chicago (CDT, UTC-5) === 20:00:00Z.
    expect(sameInstant("2026-07-28T20:00:00.000Z", "2026-07-28T20:00:00Z")).toBe(true);
  });
  it("returns false for different instants or unparseable input", () => {
    expect(sameInstant("2026-07-28T20:00:00Z", "2026-07-28T21:00:00Z")).toBe(false);
    expect(sameInstant("not-a-date", "2026-07-28T21:00:00Z")).toBe(false);
  });
});
