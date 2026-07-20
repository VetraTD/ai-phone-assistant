import { describe, it, expect, afterEach, vi } from "vitest";
import { isBusinessOpen } from "../services/gemini.js";

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
