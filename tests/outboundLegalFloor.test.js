// tests/outboundLegalFloor.test.js
/**
 * S3-7 (spec S3-D5, P-b): the per-country calling-hours floor.
 * lib/outbound/legalFloor.js's own unit tests (floorFor, isInsideFloor,
 * nextLegalOpening), plus capabilities/callback.js's schedule_callback
 * integration (the S3-3 validity seam). Gate-level integration
 * (lib/outbound/gate.js's new check 7b) is tests/outboundGate.test.js's own
 * "the per-country calling-hours floor (S3-7)" describe block.
 */
import { describe, it, expect, vi } from "vitest";
import { floorFor, isInsideFloor, nextLegalOpening, NON_US_NANP } from "../lib/outbound/legalFloor.js";
import callback, { validateCallbackTime } from "../capabilities/callback.js";

describe("floorFor", () => {
  it("+44 -> GB, 08:00-21:00 every day, zone Europe/London when the contact has no timezone", () => {
    expect(floorFor("+447700900001", null)).toEqual({
      country: "GB",
      zones: ["Europe/London"],
      windows: { mon: "08:00-21:00", tue: "08:00-21:00", wed: "08:00-21:00", thu: "08:00-21:00", fri: "08:00-21:00", sat: "08:00-21:00", sun: "08:00-21:00" },
    });
  });

  it("+44 with a contact timezone on file uses THAT zone, not the Europe/London default", () => {
    expect(floorFor("+447700900001", "Europe/Paris")).toMatchObject({ country: "GB", zones: ["Europe/Paris"] });
  });

  it("+1 with a US-mainland area code, contact timezone known -> US, that one zone", () => {
    expect(floorFor("+12142345678", "America/Chicago")).toEqual({
      country: "US",
      zones: ["America/Chicago"],
      windows: { mon: "08:00-20:00", tue: "08:00-20:00", wed: "08:00-20:00", thu: "08:00-20:00", fri: "08:00-20:00", sat: "08:00-20:00", sun: "12:00-20:00" },
    });
  });

  it("+1 US-mainland, NO contact timezone -> both America/New_York and America/Los_Angeles (Ruling S3-7a)", () => {
    expect(floorFor("+12142345678", null)).toMatchObject({ country: "US", zones: ["America/New_York", "America/Los_Angeles"] });
  });

  it("+1 US-mainland, empty-string timezone is treated the same as null", () => {
    expect(floorFor("+12142345678", "")).toMatchObject({ zones: ["America/New_York", "America/Los_Angeles"] });
    expect(floorFor("+12142345678", "   ")).toMatchObject({ zones: ["America/New_York", "America/Los_Angeles"] });
  });

  // The brief's own pinned test set.
  it.each([
    ["+14162345678", "416 Toronto, Canada"],
    ["+16042345678", "604 Vancouver, Canada"],
    ["+18762345678", "876 Jamaica"],
    ["+17872345678", "787 Puerto Rico"],
    ["+12422345678", "242 The Bahamas"],
  ])("%s (%s) is refused, never falls through to the US floor", (phone) => {
    expect(floorFor(phone, null)).toEqual({ refused: "no_legal_floor" });
    expect(floorFor(phone, "America/New_York")).toEqual({ refused: "no_legal_floor" });
  });

  it.each([
    ["+12142345678", "214 Dallas, TX"],
    ["+14692345678", "469 Dallas, TX"],
    ["+12122345678", "212 New York, NY"],
    ["+14152345678", "415 San Francisco, CA"],
  ])("%s (%s) is a US number", (phone) => {
    expect(floorFor(phone, null)).toMatchObject({ country: "US" });
  });

  it("a non-NANP country code (+33 France) is refused -- no invented EU envelope", () => {
    expect(floorFor("+33612345678", null)).toEqual({ refused: "no_legal_floor" });
    expect(floorFor("+33612345678", "Europe/Paris")).toEqual({ refused: "no_legal_floor" });
  });

  it.each([["+491234567890", "+49 Germany"], ["+61412345678", "+61 Australia"], ["", "empty string"], ["not a phone number", "garbage"]])(
    "%s (%s): refused, never allow on a lookup miss (named risk 1)",
    (phone) => {
      expect(floorFor(phone, null)).toEqual({ refused: "no_legal_floor" });
    }
  );

  it("a malformed +1 number (wrong digit count) is refused, not misread as a valid area code", () => {
    expect(floorFor("+1214234567", null)).toEqual({ refused: "no_legal_floor" }); // one digit short
    expect(floorFor("+121423456789", null)).toEqual({ refused: "no_legal_floor" }); // one digit long
  });

  it("NON_US_NANP is frozen (Object.freeze on a Set does not block .add() -- that is a JS limitation, not a promise this test makes)", () => {
    expect(Object.isFrozen(NON_US_NANP)).toBe(true);
  });
});

describe("isInsideFloor", () => {
  const usFloor = () => floorFor("+12142345678", "America/Chicago");
  const gbFloor = () => floorFor("+447700900001", "Europe/London");

  it("20:00 exactly is OUTSIDE (the end boundary is exclusive, named risk 3)", () => {
    // Tuesday 2026-09-29, 20:00 CDT == 01:00 UTC Wed.
    expect(isInsideFloor(new Date("2026-09-30T01:00:00Z"), usFloor())).toBe(false);
    expect(isInsideFloor(new Date("2026-09-30T00:59:00Z"), usFloor())).toBe(true); // 19:59 CDT
  });

  it("US Sunday opens later (12:00) than the weekday floor (08:00)", () => {
    // Sunday 2026-10-04.
    expect(isInsideFloor(new Date("2026-10-04T16:59:00Z"), usFloor())).toBe(false); // 11:59 CDT
    expect(isInsideFloor(new Date("2026-10-04T17:00:00Z"), usFloor())).toBe(true); // 12:00 CDT
  });

  it("GB Sunday is the SAME as every other day (08:00-21:00), unlike the US floor", () => {
    // Sunday 2026-10-04, 09:00 BST == 08:00 UTC.
    expect(isInsideFloor(new Date("2026-10-04T08:00:00Z"), gbFloor())).toBe(true);
  });

  it("a dual-zone floor (US, no contact timezone) requires BOTH zones inside at once", () => {
    const dual = floorFor("+12142345678", null); // NY + LA
    // 09:00 EDT / 06:00 PDT -- NY alone is inside, LA alone is not.
    expect(isInsideFloor(new Date("2026-09-29T13:00:00Z"), dual)).toBe(false);
    // 11:00 EDT / 08:00 PDT -- both are inside now.
    expect(isInsideFloor(new Date("2026-09-29T15:00:00Z"), dual)).toBe(true);
    // 19:00 EDT / 16:00 PDT -- both still inside.
    expect(isInsideFloor(new Date("2026-09-29T23:00:00Z"), dual)).toBe(true);
    // 20:00 EDT (NY just closed) / 17:00 PDT (LA still open) -- must be false.
    expect(isInsideFloor(new Date("2026-09-30T00:00:00Z"), dual)).toBe(false);
  });
});

describe("nextLegalOpening", () => {
  const wideWindow = { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" };

  it("finds the same-day opening when there is one left", () => {
    const floor = floorFor("+12142345678", "America/Chicago");
    const now = new Date("2026-10-04T16:00:00Z"); // Sunday 11:00 CDT
    const opening = nextLegalOpening(now, floor, wideWindow, "America/Chicago");
    expect(opening.toISOString()).toBe("2026-10-04T17:00:00.000Z"); // Sunday 12:00 CDT
  });

  it("rolls to the next day once today's window has passed", () => {
    const floor = floorFor("+12142345678", "America/Chicago");
    const now = new Date("2026-09-30T01:30:00Z"); // Tuesday 20:30 CDT
    const opening = nextLegalOpening(now, floor, wideWindow, "America/Chicago");
    expect(opening.toISOString()).toBe("2026-09-30T13:00:00.000Z"); // Wednesday 08:00 CDT
  });

  it("a dual-zone (no-timezone US) opening is when the LATER zone opens, not the earlier one", () => {
    const floor = floorFor("+12142345678", null); // NY + LA
    const now = new Date("2026-09-29T13:00:00Z"); // 09:00 EDT / 06:00 PDT
    const opening = nextLegalOpening(now, floor, wideWindow, "America/New_York");
    expect(opening.toISOString()).toBe("2026-09-29T15:00:00.000Z"); // 11:00 EDT == 08:00 PDT
  });

  it("fails closed (returns null) when the floor and the campaign window never overlap within the bound (named risk 1)", () => {
    const floor = floorFor("+12142345678", "America/Chicago"); // closes by 20:00 every day
    const neverOverlaps = { mon_fri: "23:58-23:59", sat: "23:58-23:59", sun: "23:58-23:59" };
    const now = new Date("2026-09-28T13:00:00Z");
    // A small bound keeps this fast; the point is exhaustion, not the exact
    // number of days searched.
    expect(nextLegalOpening(now, floor, neverOverlaps, "America/Chicago", { maxDays: 3 })).toBeNull();
  });

  it("respects the bound: an opening that exists but sits past maxDays is not found", () => {
    // The campaign is only open on a day far enough out that a 2-day bound
    // must miss it, even though the floor would allow it once reached.
    const floor = floorFor("+12142345678", "America/Chicago");
    const farOut = { mon_fri: null, sat: null, sun: "12:00-13:00" }; // only ever open on a Sunday, inside the US Sunday floor (12:00-20:00)
    const now = new Date("2026-09-28T13:00:00Z"); // Monday -- next Sunday is 6 days out
    expect(nextLegalOpening(now, floor, farOut, "America/Chicago", { maxDays: 2 })).toBeNull();
    expect(nextLegalOpening(now, floor, farOut, "America/Chicago", { maxDays: 8 })).not.toBeNull();
  });
});

describe("schedule_callback (capabilities/callback.js): the S3-7 floor on the validity seam", () => {
  function fc(args) {
    return { id: "fc1", name: "schedule_callback", args };
  }
  function makeCtx({
    phone = "+12142345678",
    timezone = "America/Chicago",
    // I2 fix round 1: defaults to the SAME value as `timezone` so every
    // pre-existing test here (which never knew about raw vs resolved) keeps
    // behaving exactly as before -- only the new dual-zone test below passes
    // `null` explicitly, to prove the raw column (not the resolved fallback)
    // is what floorFor actually sees.
    rawTimezone = timezone,
    callingWindow = { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" },
  } = {}) {
    return {
      businessId: "biz-1",
      callId: "call-1",
      callSid: "CAsid1",
      party: { phone, source: "dialed", verified: true },
      outboundCall: {
        config: { capabilities: ["appointments"], calling_window: callingWindow },
        contact: { firstName: "Sam", timezone, rawTimezone, phone },
        campaign: { audience: "business" },
      },
      deps: { setCallOutcomeCode: async () => {}, mergeCallAnswers: async () => {} },
    };
  }

  it("20:30 US: refused, nearest is the next day at 08:00 (the brief's own pinned case)", async () => {
    vi.useFakeTimers();
    // The live call itself is happening at 20:30 CDT Tuesday, past the US
    // floor's 20:00 close -- both `now` (this) and the requested candidate
    // (below) are outside it, so the nearest offered must roll to Wednesday.
    vi.setSystemTime(new Date("2026-09-30T01:30:00Z")); // 20:30 CDT Tuesday
    try {
      const ctx = makeCtx();
      const res = await callback.execute(fc({ when_iso: "2026-09-29T20:30:00" }), ctx); // 20:30 CDT
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.nearest).toBe("2026-09-30T13:00:00.000Z"); // Wed 08:00 CDT
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Toronto contact number is refused outright, with no 'nearest' time offered (no_legal_floor)", async () => {
    const ctx = makeCtx({ phone: "+14162345678", timezone: "America/Toronto" });
    const res = await callback.execute(fc({ when_iso: "2026-09-29T14:00:00" }), ctx);
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.nearest).toBeUndefined();
  });

  it("fails closed when the contact has no phone number on the outbound call context", async () => {
    const ctx = makeCtx();
    delete ctx.outboundCall.contact.phone;
    const res = await callback.execute(fc({ when_iso: "2026-09-29T14:00:00" }), ctx);
    expect(res.functionResponse.response.success).toBe(false);
  });

  it("validateCallbackTime without `phone` skips the floor entirely (back-compat for the pre-S3-7 unit tests)", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const candidate = new Date("2026-09-29T21:00:00Z"); // outside every real floor, inside this wide window
    const v = validateCallbackTime(candidate, { callingWindow: { mon_fri: "00:00-23:59", sat: null, sun: null }, tz: "UTC", now });
    expect(v.ok).toBe(true);
  });

  it("validateCallbackTime with `phone` set to a no-legal-floor number refuses with no nearest", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const candidate = new Date("2026-09-29T14:00:00Z");
    const v = validateCallbackTime(candidate, {
      callingWindow: { mon_fri: "00:00-23:59", sat: null, sun: null },
      tz: "Europe/Paris",
      now,
      phone: "+33612345678",
    });
    expect(v).toEqual({ ok: false, nearest: null, refused: "no_legal_floor" });
  });

  // --- Fix round 1 (review Important #1 and #2) ---------------------------

  it("I1: a nextLegalOpening exhaustion (floor and window never overlap) refuses outright -- no fabricated now+14d 'nearest' (review's own repro)", () => {
    const now = new Date("2026-09-28T13:00:00Z"); // Monday
    const candidate = new Date("2026-09-28T13:58:00Z"); // 08:58 CDT -- irrelevant to the outcome either way
    // The US floor never runs past 20:00 on any day; a campaign window open
    // only 23:58-23:59 every day can never overlap it within the 8-day bound.
    const neverOverlaps = { mon_fri: "23:58-23:59", sat: "23:58-23:59", sun: "23:58-23:59" };
    const v = validateCallbackTime(candidate, {
      callingWindow: neverOverlaps,
      tz: "America/Chicago",
      now,
      phone: "+12142345678",
    });
    expect(v).toEqual({ ok: false, nearest: null, refused: "no_legal_floor" });
  });

  it("I1: the same exhaustion, through execute() -- no fabricated time is ever spoken to the caller", async () => {
    const ctx = makeCtx({
      phone: "+12142345678",
      timezone: "America/Chicago",
      callingWindow: { mon_fri: "23:58-23:59", sat: "23:58-23:59", sun: "23:58-23:59" },
    });
    const res = await callback.execute(fc({ when_iso: "2026-09-29T23:58:00" }), ctx);
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.nearest).toBeUndefined();
    expect(res.functionResponse.response.message).not.toMatch(/nearest available time/);
  });

  it("I2: validateCallbackTime's floor classification uses `rawTimezone`, not `tz`, when both are given", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    // The candidate is 09:00 in the RESOLVED zone (America/New_York) -- legal
    // in NY's own 08:00-20:00 floor -- but rawTimezone null means the true
    // DB column is unset, so BOTH America/New_York and America/Los_Angeles
    // must clear at once. At this instant LA is at 06:00, before its floor
    // opens, so this must be refused despite `tz` alone reading as legal.
    const candidate = new Date("2026-09-29T13:00:00Z"); // 09:00 EDT == 06:00 PDT
    const v = validateCallbackTime(candidate, {
      callingWindow: { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" },
      tz: "America/New_York",
      rawTimezone: null,
      now,
      phone: "+12142345678",
    });
    expect(v.ok).toBe(false);
    expect(v.nearest).toBe("2026-09-29T15:00:00.000Z"); // 11:00 EDT == 08:00 PDT, the dual-zone opening
  });

  it("I2: a US contact with NO raw timezone on file, through execute() -- a time legal only in NY (not LA) is refused, not booked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    try {
      const ctx = makeCtx({ phone: "+12142345678", timezone: "America/New_York", rawTimezone: null });
      const res = await callback.execute(fc({ when_iso: "2026-09-29T09:00:00" }), ctx); // 09:00 in the resolved (NY) clock
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.nearest).toBe("2026-09-29T15:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
