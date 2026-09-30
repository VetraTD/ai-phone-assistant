// tests/outboundEuFloor.test.js
/**
 * S4-5: the EU calling-hours floor. One strict default for all 27 member
 * states: Mon-Fri, 10:00-13:00 and 14:00-20:00 on the contact's local clock,
 * no weekends, no nationwide public holidays. Everything else (Gibraltar,
 * Iceland, Andorra, overseas territories, ...) stays refused.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { floorFor, isInsideFloor, nextLegalOpening } from "../lib/outbound/legalFloor.js";
import { zonedComponentsToUtcMs } from "../lib/capabilities/datetime.js";
import { log } from "../lib/logger.js";
import { validateCallbackTime } from "../capabilities/callback.js";

const HOLIDAYS = JSON.parse(readFileSync(new URL("../lib/outbound/euHolidays.json", import.meta.url), "utf8"));

/** [ISO code, calling code, principal IANA zone] for all 27 member states. */
const EU = [
  ["AT", "43", "Europe/Vienna"], ["BE", "32", "Europe/Brussels"], ["BG", "359", "Europe/Sofia"],
  ["HR", "385", "Europe/Zagreb"], ["CY", "357", "Asia/Nicosia"], ["CZ", "420", "Europe/Prague"],
  ["DK", "45", "Europe/Copenhagen"], ["EE", "372", "Europe/Tallinn"], ["FI", "358", "Europe/Helsinki"],
  ["FR", "33", "Europe/Paris"], ["DE", "49", "Europe/Berlin"], ["GR", "30", "Europe/Athens"],
  ["HU", "36", "Europe/Budapest"], ["IE", "353", "Europe/Dublin"], ["IT", "39", "Europe/Rome"],
  ["LV", "371", "Europe/Riga"], ["LT", "370", "Europe/Vilnius"], ["LU", "352", "Europe/Luxembourg"],
  ["MT", "356", "Europe/Malta"], ["NL", "31", "Europe/Amsterdam"], ["PL", "48", "Europe/Warsaw"],
  ["PT", "351", "Europe/Lisbon"], ["RO", "40", "Europe/Bucharest"], ["SK", "421", "Europe/Bratislava"],
  ["SI", "386", "Europe/Ljubljana"], ["ES", "34", "Europe/Madrid"], ["SE", "46", "Europe/Stockholm"],
];
const phoneFor = (cc) => `+${cc}5551234567`;

/** The instant of a local wall-clock reading (e.g. "2026-10-14", "11:00") in tz. */
function at(ymd, hhmm, tz) {
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  return new Date(zonedComponentsToUtcMs({ year, month, day, hour, minute, second: 0 }, tz));
}
const inside = (phone, ymd, hhmm, tz, rawTz = null) => {
  const floor = floorFor(phone, rawTz);
  if (floor.refused) throw new Error(`refused: ${floor.refused}`);
  return isInsideFloor(at(ymd, hhmm, tz), floor);
};
// Wed 14 Oct 2026, Sat 17, Sun 18: no member state has a national holiday on 14 Oct 2026.
const WED = "2026-10-14", SAT = "2026-10-17", SUN = "2026-10-18";
const WIDE = { mon_fri: "08:00-21:00", sat: "08:00-21:00", sun: "08:00-21:00" };

afterEach(() => vi.restoreAllMocks());

describe("EU floor: every one of the 27 member states", () => {
  it("the fixture covers exactly 27 distinct countries", () => {
    expect(new Set(EU.map((r) => r[0])).size).toBe(27);
    expect(Object.keys(HOLIDAYS.holidays).sort()).toEqual(EU.map((r) => r[0]).sort());
  });

  describe.each(EU)("%s (+%s, %s)", (cc, code, tz) => {
    const phone = phoneFor(code);
    it("floorFor gives the strict Mon-Fri two-range window", () => {
      const f = floorFor(phone, null);
      expect(f.refused).toBeUndefined();
      expect(f.country).toBe(cc);
      expect(f.zones).toContain(tz);
      for (const d of ["mon", "tue", "wed", "thu", "fri"]) expect(f.windows[d]).toEqual(["10:00-13:00", "14:00-20:00"]);
      expect(f.windows.sat ?? null).toBeNull();
      expect(f.windows.sun ?? null).toBeNull();
    });
    it("allowed inside both ranges", () => {
      for (const t of ["10:00", "11:30", "12:59", "14:00", "17:00", "19:59"]) expect(inside(phone, WED, t, tz, tz), t).toBe(true);
    });
    it("refused before 10:00, in the 13:00-14:00 lunch gap, and from 20:00", () => {
      for (const t of ["00:00", "09:59", "13:00", "13:30", "13:59", "20:00", "23:30"]) expect(inside(phone, WED, t, tz, tz), t).toBe(false);
    });
    it("refused on Saturday and Sunday even at 11:00", () => {
      expect(inside(phone, SAT, "11:00", tz, tz)).toBe(false);
      expect(inside(phone, SUN, "15:00", tz, tz)).toBe(false);
    });
    it("refused on every nationwide holiday that falls on a weekday (2026), allowed the day around it if not itself a holiday", () => {
      const days = HOLIDAYS.holidays[cc].filter((d) => d.startsWith("2026"));
      expect(days.length).toBeGreaterThan(5);
      const weekdayHolidays = days.filter((d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; });
      expect(weekdayHolidays.length).toBeGreaterThan(3);
      for (const d of weekdayHolidays) expect(inside(phone, d, "11:00", tz, tz), d).toBe(false);
    });
  });
});

describe("EU floor: pinned national holidays in the big markets", () => {
  it.each([
    ["IE", "St Patrick's Day Tue", "2026-03-17"],
    ["DE", "Unity Day Tue", "2028-10-03"],
    ["FR", "Bastille Day Tue", "2026-07-14"],
    ["ES", "Fiesta Nacional Mon", "2026-10-12"],
    ["IT", "Republic Day Tue", "2026-06-02"],
    ["NL", "King's Day Mon", "2026-04-27"],
    ["BE", "National Day Tue", "2026-07-21"],
    ["PT", "Portugal Day Wed", "2026-06-10"],
  ])("%s %s is refused at 11:00 local", (cc, _n, date) => {
    const [, code, tz] = EU.find((r) => r[0] === cc);
    expect(HOLIDAYS.holidays[cc]).toContain(date);
    expect(inside(phoneFor(code), date, "11:00", tz, tz)).toBe(false);
  });
  it("regional-only days are NOT in the nationwide table (DE Epiphany, All Saints, Corpus Christi; FR Good Friday)", () => {
    expect(HOLIDAYS.holidays.DE).not.toContain("2026-01-06");
    expect(HOLIDAYS.holidays.DE).not.toContain("2026-11-01");
    expect(HOLIDAYS.holidays.DE).not.toContain("2026-06-04");
    expect(HOLIDAYS.holidays.FR).not.toContain("2026-04-03");
  });
  it("carries its provenance", () => {
    expect(HOLIDAYS.source).toMatchObject({ library: "date-holidays", version: "3.37.0", licence: "ISC AND CC-BY-3.0" });
    expect(HOLIDAYS.years).toEqual([2026, 2030]);
  });
});

describe("EU floor: the holiday follows the contact's local date, per zone", () => {
  it("a holiday date is refused in every part of the day (00:30 and 23:30 local)", () => {
    expect(inside(phoneFor("33"), "2026-07-14", "10:30", "Europe/Paris")).toBe(false);
    expect(inside(phoneFor("33"), "2026-07-15", "10:30", "Europe/Paris")).toBe(true);
    expect(inside(phoneFor("33"), "2026-07-13", "19:30", "Europe/Paris")).toBe(true);
  });
});

describe("EU floor: multi-zone countries", () => {
  it("ES with no contact timezone requires BOTH Europe/Madrid and Atlantic/Canary", () => {
    const f = floorFor("+34655512345", null);
    expect(f.zones).toEqual(["Europe/Madrid", "Atlantic/Canary"]);
    // Madrid 10:30 = Canary 09:30 -> refused; Madrid 11:30 = Canary 10:30 -> allowed.
    expect(isInsideFloor(at(WED, "10:30", "Europe/Madrid"), f)).toBe(false);
    expect(isInsideFloor(at(WED, "11:30", "Europe/Madrid"), f)).toBe(true);
    // Madrid 14:30 = Canary 13:30 (lunch gap there) -> refused; Madrid 15:00 = Canary 14:00 -> allowed.
    expect(isInsideFloor(at(WED, "14:30", "Europe/Madrid"), f)).toBe(false);
    expect(isInsideFloor(at(WED, "15:00", "Europe/Madrid"), f)).toBe(true);
    // Madrid 20:00 -> refused in Madrid; Madrid 19:00 = Canary 18:00 -> allowed.
    expect(isInsideFloor(at(WED, "19:00", "Europe/Madrid"), f)).toBe(true);
    expect(isInsideFloor(at(WED, "20:00", "Europe/Madrid"), f)).toBe(false);
  });
  it("ES with a contact timezone INSIDE Spain honours that one zone", () => {
    expect(floorFor("+34655512345", "Atlantic/Canary").zones).toEqual(["Atlantic/Canary"]);
    expect(floorFor("+34655512345", "Europe/Madrid").zones).toEqual(["Europe/Madrid"]);
    expect(floorFor("+34655512345", "Africa/Ceuta").zones).toEqual(["Africa/Ceuta"]);
    const canary = floorFor("+34655512345", "Atlantic/Canary");
    expect(isInsideFloor(at(WED, "10:30", "Atlantic/Canary"), canary)).toBe(true);
  });
  it("ES with a contact timezone OUTSIDE Spain (America/New_York) ignores it and uses both default zones", () => {
    expect(floorFor("+34655512345", "America/New_York").zones).toEqual(["Europe/Madrid", "Atlantic/Canary"]);
  });
  it("PT with no contact timezone requires Lisbon, Madeira and the Azores", () => {
    const f = floorFor("+351912345678", null);
    expect(f.zones).toEqual(["Europe/Lisbon", "Atlantic/Madeira", "Atlantic/Azores"]);
    // Lisbon 10:30 = Azores 09:30 -> refused; Lisbon 11:30 = Azores 10:30 -> allowed.
    expect(isInsideFloor(at(WED, "10:30", "Europe/Lisbon"), f)).toBe(false);
    expect(isInsideFloor(at(WED, "11:30", "Europe/Lisbon"), f)).toBe(true);
    expect(isInsideFloor(at(WED, "20:00", "Europe/Lisbon"), f)).toBe(false);
    expect(floorFor("+351912345678", "Atlantic/Azores").zones).toEqual(["Atlantic/Azores"]);
  });
  it("FI covers Helsinki and Mariehamn (Aland)", () => {
    expect(floorFor("+358401234567", null).zones).toEqual(["Europe/Helsinki", "Europe/Mariehamn"]);
  });
  it("a single-zone country ignores a foreign contact timezone (DE with Asia/Tokyo)", () => {
    expect(floorFor("+4915112345678", "Asia/Tokyo").zones).toEqual(["Europe/Berlin"]);
  });
  it("nextLegalOpening for ES/no tz opens when the LATER zone opens (Madrid 11:00 = Canary 10:00)", () => {
    const f = floorFor("+34655512345", null);
    const o = nextLegalOpening(at(WED, "08:00", "Europe/Madrid"), f, WIDE, "Europe/Madrid");
    expect(o.toISOString()).toBe(at(WED, "11:00", "Europe/Madrid").toISOString());
  });
});

describe("EU floor: refused numbers (prefix collisions, non-EU, overseas, malformed)", () => {
  it.each([
    ["+35012345678", "Gibraltar 350"], ["+3546112345", "Iceland 354"], ["+35512345678", "Albania 355"],
    ["+37312345678", "Moldova 373"], ["+37412345678", "Armenia 374"], ["+375291234567", "Belarus 375"],
    ["+37612345678", "Andorra 376"], ["+37712345678", "Monaco 377"], ["+37812345678", "San Marino 378"],
    ["+37912345678", "Vatican 379"], ["+380501234567", "Ukraine 380"], ["+381601234567", "Serbia 381"],
    ["+38267123456", "Montenegro 382"], ["+38344123456", "Kosovo 383"], ["+38761123456", "Bosnia 387"],
    ["+38970123456", "North Macedonia 389"], ["+42312345678", "Liechtenstein 423"],
    ["+29812345678", "Faroe 298"], ["+29912345678", "Greenland 299"],
    ["+262692123456", "Reunion 262"], ["+590690123456", "Guadeloupe 590"], ["+594694123456", "French Guiana 594"],
    ["+596696123456", "Martinique 596"], ["+50841123456", "St Pierre 508"], ["+59971234567", "Curacao 599"],
    ["+29761234567", "Aruba 297"], ["+68987123456", "French Polynesia 689"], ["+68777123456", "New Caledonia 687"],
    ["+41791234567", "Switzerland"], ["+4791234567", "Norway"], ["+81312345678", "Japan"], ["+911234567890", "India"],
    ["+7123456789", "Russia"], ["+3906698123456", "Vatican on an Italian number (+39 06 698)"],
    ["+390549123456", "San Marino on an Italian number (+39 0549)"],
    ["+3", "malformed: bare 3"], ["+33", "malformed: no national number"], ["+3312", "malformed: too short"],
    ["+33612345678901234", "malformed: too long"], ["+33 6 12 34 56 78", "malformed: spaces"],
    ["0033612345678", "malformed: no plus"], ["+33abc123456", "malformed: letters"], ["", "empty"],
  ])("%s (%s) is refused no_legal_floor", (phone) => {
    expect(floorFor(phone, null)).toEqual({ refused: "no_legal_floor" });
    expect(floorFor(phone, "Europe/Paris")).toEqual({ refused: "no_legal_floor" });
  });
  it("the neighbours that must NOT be refused: Rome +39 06 1234567, Milan, Lisbon vs +350", () => {
    expect(floorFor("+39061234567", null).country).toBe("IT");
    expect(floorFor("+390212345678", null).country).toBe("IT");
    expect(floorFor("+351212345678", null).country).toBe("PT");
    expect(floorFor("+358401234567", null).country).toBe("FI");
    expect(floorFor("+359881234567", null).country).toBe("BG");
    expect(floorFor("+357991234567", null).country).toBe("CY");
  });
  it("non-string input is refused", () => {
    expect(floorFor(undefined, null)).toEqual({ refused: "no_legal_floor" });
  });
  it("GB and US are unchanged (spot-check: GB Saturday 09:00 allowed, US Sunday 11:59 refused)", () => {
    const gb = floorFor("+447700900001", null);
    expect(isInsideFloor(at(SAT, "09:00", "Europe/London"), gb)).toBe(true);
    const us = floorFor("+12142345678", "America/Chicago");
    expect(isInsideFloor(at(SUN, "11:59", "America/Chicago"), us)).toBe(false);
    expect(isInsideFloor(at(SUN, "12:00", "America/Chicago"), us)).toBe(true);
  });
});

describe("EU floor: stale holiday table (year not covered) fails closed", () => {
  it("2031 and 2025 dates are refused and log outbound_holiday_table_stale", () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    const f = floorFor(phoneFor("49"), null);
    expect(isInsideFloor(at("2031-03-12", "11:00", "Europe/Berlin"), f)).toBe(false); // Wed
    expect(spy).toHaveBeenCalledWith("outbound_holiday_table_stale", expect.objectContaining({ country: "DE", year: 2031 }));
    spy.mockClear();
    expect(isInsideFloor(at("2025-12-17", "11:00", "Europe/Berlin"), f)).toBe(false); // Wed
    expect(spy).toHaveBeenCalledWith("outbound_holiday_table_stale", expect.objectContaining({ country: "DE", year: 2025 }));
  });
  it("nextLegalOpening from the last covered evening returns null (never an uncovered year)", () => {
    vi.spyOn(log, "error").mockImplementation(() => {});
    const f = floorFor(phoneFor("49"), null);
    expect(nextLegalOpening(at("2030-12-31", "21:00", "Europe/Berlin"), f, WIDE, "Europe/Berlin")).toBeNull();
    // ...while a search that stays in 2030 still finds its opening.
    const o = nextLegalOpening(at("2030-12-30", "21:00", "Europe/Berlin"), f, WIDE, "Europe/Berlin");
    expect(o.toISOString()).toBe(at("2030-12-31", "10:00", "Europe/Berlin").toISOString());
  });
  it("GB and US never consult the holiday table (a 2040 GB Saturday is fine)", () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    expect(isInsideFloor(at("2040-03-10", "09:00", "Europe/London"), floorFor("+447700900001", null))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("EU floor: nextLegalOpening", () => {
  const de = () => floorFor("+4915112345678", null);
  it("lunch gap: 13:00 -> 14:00 the same day", () => {
    const o = nextLegalOpening(at(WED, "13:00", "Europe/Berlin"), de(), WIDE, "Europe/Berlin");
    expect(o.toISOString()).toBe(at(WED, "14:00", "Europe/Berlin").toISOString());
  });
  it("after 20:00 rolls to 10:00 next morning", () => {
    const o = nextLegalOpening(at(WED, "20:30", "Europe/Berlin"), de(), WIDE, "Europe/Berlin");
    expect(o.toISOString()).toBe(at("2026-10-15", "10:00", "Europe/Berlin").toISOString());
  });
  it("Thu 24 Dec 2026 evening in DE -> Fri 25 (holiday), Sat, Sun skipped -> Mon 28 Dec 10:00", () => {
    const o = nextLegalOpening(at("2026-12-24", "20:30", "Europe/Berlin"), de(), WIDE, "Europe/Berlin");
    expect(o.toISOString()).toBe(at("2026-12-28", "10:00", "Europe/Berlin").toISOString());
  });
  it("Easter 2026 in FR: Fri 3 Apr 21:00 -> Easter Monday 6 Apr skipped -> Tue 7 Apr 10:00", () => {
    const o = nextLegalOpening(at("2026-04-03", "21:00", "Europe/Paris"), floorFor("+33612345678", null), WIDE, "Europe/Paris");
    expect(o.toISOString()).toBe(at("2026-04-07", "10:00", "Europe/Paris").toISOString());
  });
  it("a Mon-Fri-only campaign window + Christmas 2026 still finds 28 Dec within the default bound", () => {
    const monFri = { mon_fri: "08:00-21:00", sat: null, sun: null };
    const o = nextLegalOpening(at("2026-12-24", "20:30", "Europe/Berlin"), de(), monFri, "Europe/Berlin");
    expect(o.toISOString()).toBe(at("2026-12-28", "10:00", "Europe/Berlin").toISOString());
  });
  it("every country, every day of 2026-2029 21:00 local: an opening exists inside the default 8-day bound (Easter/Christmas/New Year runs)", () => {
    for (const [cc, code, tz] of EU) {
      const f = floorFor(phoneFor(code), null);
      const days = HOLIDAYS.holidays[cc].filter((d) => d >= "2026-01-01" && d < "2030-01-01");
      // The day before every holiday is where the longest runs start.
      for (const d of days) {
        const prev = new Date(new Date(`${d}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
        const o = nextLegalOpening(at(prev, "20:30", tz), f, { mon_fri: "08:00-21:00", sat: null, sun: null }, tz);
        expect(o, `${cc} ${prev}`).not.toBeNull();
      }
    }
  });
  it("perf: a 14-day worst-case search with holiday lookups stays under 20 ms (warm)", () => {
    const f = floorFor("+34655512345", null); // two zones
    const never = { mon_fri: null, sat: null, sun: null };
    nextLegalOpening(at(WED, "08:00", "Europe/Madrid"), f, never, "Europe/Madrid", { maxDays: 14 });
    const t0 = performance.now();
    const o = nextLegalOpening(at(WED, "08:00", "Europe/Madrid"), f, never, "Europe/Madrid", { maxDays: 14 });
    const ms = performance.now() - t0;
    expect(o).toBeNull();
    expect(ms).toBeLessThan(20);
  });
});

describe("EU floor: schedule_callback (validateCallbackTime) inherits it", () => {
  const now = new Date("2026-10-12T08:00:00Z");
  const v = (candidate, phone = "+33612345678", tz = "Europe/Paris") =>
    validateCallbackTime(candidate, { callingWindow: WIDE, tz, now, phone, rawTimezone: tz });
  it("a time inside the lunch gap is refused outside_floor and the nearest is 14:00", () => {
    const r = v(at("2026-10-14", "13:30", "Europe/Paris"));
    expect(r).toMatchObject({ ok: false, reason: "outside_floor" });
    expect(r.nearest).toBe(at("2026-10-14", "14:00", "Europe/Paris").toISOString());
  });
  it("a Saturday is refused and the nearest is Monday 10:00", () => {
    const sat = v(at("2026-10-17", "11:00", "Europe/Paris"));
    expect(sat).toMatchObject({ ok: false, reason: "outside_floor" });
    expect(sat.nearest).toBe(at("2026-10-19", "10:00", "Europe/Paris").toISOString());
  });
  it("Armistice Day (Wed 11 Nov 2026) is refused; the nearest is Thu 12 Nov 10:00", () => {
    const r = v(at("2026-11-11", "11:00", "Europe/Paris"), "+33612345678", "Europe/Paris");
    // 30 days out: beyond the 14-day cap, so use a nearer clock.
    const near = validateCallbackTime(at("2026-11-11", "11:00", "Europe/Paris"), {
      callingWindow: WIDE, tz: "Europe/Paris", now: new Date("2026-11-05T08:00:00Z"), phone: "+33612345678", rawTimezone: "Europe/Paris",
    });
    expect(r.ok).toBe(false);
    expect(near).toMatchObject({ ok: false, reason: "outside_floor" });
    expect(near.nearest).toBe(at("2026-11-12", "10:00", "Europe/Paris").toISOString());
  });
  it("a time inside the floor is accepted", () => {
    expect(v(at("2026-10-14", "15:00", "Europe/Paris"))).toEqual({ ok: true });
  });
});
