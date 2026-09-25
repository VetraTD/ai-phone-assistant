import { describe, it, expect } from "vitest";
import {
  parseScheduleEntry, computeAttemptAt, parseWindow, isInsideWindow, nextWindowOpening, applyWindow, contactTimezone,
} from "../lib/outbound/schedule.js";

const LDN = "Europe/London";
const WIN = { mon_fri: "09:00-20:00", sat: "10:00-16:00", sun: null, outside_window: "queue" };

describe("parseScheduleEntry", () => {
  it.each([
    ["now", { kind: "now" }],
    ["+10m", { kind: "offset", ms: 600_000 }],
    ["+3h", { kind: "offset", ms: 10_800_000 }],
    ["next_day 10:00", { kind: "next_day", h: 10, m: 0 }],
    ["day_3 17:30", { kind: "day_n", n: 3, h: 17, m: 30 }],
  ])("%s", (s, want) => expect(parseScheduleEntry(s)).toEqual(want));

  it.each(["", "later", "+0m", "+10s", "next_day 24:00", "next_day 9:00", "day_0 10:00", "day_3 10:60"])(
    "refuses %j", (s) => expect(() => parseScheduleEntry(s)).toThrow(/bad schedule entry/));
});

describe("computeAttemptAt", () => {
  const created = new Date("2026-09-28T09:00:00Z"); // Mon 10:00 BST
  it("now is now", () => {
    const now = new Date("2026-09-28T09:05:00Z");
    expect(computeAttemptAt({ entry: "now", now, createdAt: created, timezone: LDN }).toISOString()).toBe(now.toISOString());
  });
  it("+Nm counts from the END of the previous attempt, not from now", () => {
    const r = computeAttemptAt({ entry: "+10m", now: new Date("2026-09-28T09:30:00Z"), lastEndedAt: new Date("2026-09-28T09:01:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-09-28T09:11:00.000Z");
  });
  it("next_day HH:MM is local wall-clock time on the next calendar day", () => {
    const r = computeAttemptAt({ entry: "next_day 10:00", now: new Date("2026-09-28T19:00:00Z"), lastEndedAt: new Date("2026-09-28T19:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-09-29T09:00:00.000Z"); // 10:00 BST
  });
  it("day_N counts from outreach creation, day 1 = creation day", () => {
    const r = computeAttemptAt({ entry: "day_3 17:30", now: new Date("2026-09-29T12:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-09-30T16:30:00.000Z"); // Wed 17:30 BST
  });
  it("next_day across the spring-forward night lands on the right UTC instant", () => {
    const r = computeAttemptAt({ entry: "next_day 10:00", now: new Date("2026-03-28T15:00:00Z"), lastEndedAt: new Date("2026-03-28T15:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-03-29T09:00:00.000Z"); // 10:00 BST on the change day
  });
  it("next_day across the fall-back night lands on the right UTC instant", () => {
    const r = computeAttemptAt({ entry: "next_day 10:00", now: new Date("2026-10-24T14:00:00Z"), lastEndedAt: new Date("2026-10-24T14:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-10-25T10:00:00.000Z"); // 10:00 GMT
  });
});

describe("calling windows", () => {
  it("parseWindow reads HH:MM-HH:MM into minutes and null into null", () => {
    expect(parseWindow("09:00-20:00")).toEqual({ start: 540, end: 1200 });
    expect(parseWindow(null)).toBeNull();
  });
  it("inside on a weekday afternoon, outside before opening, outside on Sunday", () => {
    expect(isInsideWindow(new Date("2026-09-28T13:00:00Z"), WIN, LDN)).toBe(true);   // Mon 14:00
    expect(isInsideWindow(new Date("2026-09-28T07:30:00Z"), WIN, LDN)).toBe(false);  // Mon 08:30
    expect(isInsideWindow(new Date("2026-09-27T13:00:00Z"), WIN, LDN)).toBe(false);  // Sun
  });
  it("the end is exclusive: 20:00 on the dot is outside", () => {
    expect(isInsideWindow(new Date("2026-09-28T19:00:00Z"), WIN, LDN)).toBe(false);  // Mon 20:00 BST
  });
  it("uses the contact's local clock across the DST change", () => {
    expect(isInsideWindow(new Date("2026-03-29T08:30:00Z"), { ...WIN, sun: "09:00-12:00" }, LDN)).toBe(true);  // 09:30 BST
    expect(isInsideWindow(new Date("2026-03-29T07:30:00Z"), { ...WIN, sun: "09:00-12:00" }, LDN)).toBe(false); // 08:30 BST
  });
  it("nextWindowOpening: Friday night rolls to Saturday 10:00, Saturday evening to Monday 09:00", () => {
    expect(nextWindowOpening(new Date("2026-10-02T20:30:00Z"), WIN, LDN).toISOString()).toBe("2026-10-03T09:00:00.000Z");
    expect(nextWindowOpening(new Date("2026-10-03T16:30:00Z"), WIN, LDN).toISOString()).toBe("2026-10-05T08:00:00.000Z");
  });
  it("nextWindowOpening is null for a window with no open day", () => {
    expect(nextWindowOpening(new Date(), { mon_fri: null, sat: null, sun: null }, LDN)).toBeNull();
  });
  it("applyWindow keeps an inside time and moves an outside one to opening + 0..10 min of jitter", () => {
    const inside = new Date("2026-09-28T13:00:00Z");
    expect(applyWindow(inside, WIN, LDN, () => 0.5).toISOString()).toBe(inside.toISOString());
    expect(applyWindow(new Date("2026-09-28T05:00:00Z"), WIN, LDN, () => 0).toISOString()).toBe("2026-09-28T08:00:00.000Z");
    expect(applyWindow(new Date("2026-09-28T05:00:00Z"), WIN, LDN, () => 0.999).getTime())
      .toBeLessThan(new Date("2026-09-28T08:10:00Z").getTime());
  });
});

describe("contactTimezone", () => {
  it("prefers the contact's own zone, then +44 means London, then the business zone", () => {
    expect(contactTimezone({ timezone: "Europe/Dublin", phone_e164: "+447700900001" }, "America/Chicago")).toBe("Europe/Dublin");
    expect(contactTimezone({ phone_e164: "+447700900001" }, "America/Chicago")).toBe("Europe/London");
    expect(contactTimezone({ phone_e164: "+14699338887" }, "America/Chicago")).toBe("America/Chicago");
  });
});
