import { describe, it, expect } from "vitest";
import {
  GRID_START_MIN,
  GRID_END_MIN,
  addDays,
  mondayOf,
  weekDays,
  todayIn,
  placeBooking,
  gridSlot,
  isValidDay,
} from "../week.js";

describe("calendar week maths", () => {
  it("runs the grid from 08:00 to 18:00", () => {
    expect(GRID_START_MIN).toBe(480);
    expect(GRID_END_MIN).toBe(1080);
  });

  it("finds the Monday of a week, a Sunday included", () => {
    expect(mondayOf("2026-11-29")).toBe("2026-11-23");
    expect(mondayOf("2026-11-23")).toBe("2026-11-23");
  });

  it("lists Monday to Saturday, or the whole week", () => {
    expect(weekDays("2026-11-23")).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
    ]);
    const seven = weekDays("2026-11-23", 7);
    expect(seven).toHaveLength(7);
    expect(seven[6]).toBe("2026-11-29");
  });

  it("adds days across a year end", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("places a booking on the business's day and clock", () => {
    expect(placeBooking("2026-11-24T15:00:00Z", "America/Chicago")).toEqual({ day: "2026-11-24", minutes: 540 });
  });

  it("keeps 9 am at 9 am across the UK clock change", () => {
    expect(placeBooking("2026-10-23T08:00:00Z", "Europe/London").minutes).toBe(540);
    expect(placeBooking("2026-10-26T09:00:00Z", "Europe/London").minutes).toBe(540);
  });

  it("keeps 9 am at 9 am across the US clock change", () => {
    expect(placeBooking("2026-10-30T14:00:00Z", "America/Chicago").minutes).toBe(540);
    expect(placeBooking("2026-11-02T15:00:00Z", "America/Chicago").minutes).toBe(540);
  });

  it("leaves a booking off the grid before 8 am, from 6 pm, or on a Sunday", () => {
    const days = weekDays("2026-11-23");
    expect(gridSlot({ day: "2026-11-24", minutes: 450 }, days)).toBeNull();
    expect(gridSlot({ day: "2026-11-24", minutes: 1080 }, days)).toBeNull();
    expect(gridSlot({ day: "2026-11-29", minutes: 600 }, days)).toBeNull();
  });

  it("puts 1 pm on Tuesday halfway down the second column", () => {
    expect(gridSlot({ day: "2026-11-24", minutes: 780 }, weekDays("2026-11-23"))).toEqual({ col: 1, top: 0.5 });
  });

  it("knows the business's today, not UTC's", () => {
    expect(todayIn("America/Chicago", new Date("2026-11-24T05:30:00Z"))).toBe("2026-11-23");
  });

  it("accepts only real calendar days", () => {
    expect(isValidDay("2026-02-30")).toBe(false);
    expect(isValidDay("2026-02-28")).toBe(true);
    expect(isValidDay("2026-2-28")).toBe(false);
    expect(isValidDay(undefined)).toBe(false);
  });
});
