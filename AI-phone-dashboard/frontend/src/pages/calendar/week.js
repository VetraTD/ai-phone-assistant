// The Calendar's week, on the BUSINESS's calendar. Days are "YYYY-MM-DD"
// strings and the arithmetic runs on UTC dates, so neither the viewer's
// timezone nor a clock change can move a booking to another day or hour.

import { localDay } from "../../calls/format.js";

// The desktop grid: 08:00 to 18:00, in minutes since local midnight.
export const GRID_START_MIN = 480;
export const GRID_END_MIN = 1080;

const DAY_MS = 86400000;

function toUtc(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "2026-12-31" + 1 → "2027-01-01" */
export function addDays(day, n) {
  return fromUtc(toUtc(day) + n * DAY_MS);
}

/** The Monday of the week holding `day`; the week starts on Monday. */
export function mondayOf(day) {
  const weekday = new Date(toUtc(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

/** Monday to Saturday by default; `count = 7` adds Sunday. */
export function weekDays(monday, count = 6) {
  return Array.from({ length: count }, (_, i) => addDays(monday, i));
}

/** Today on the business's calendar. */
export function todayIn(tz, now = new Date()) {
  return localDay(now, tz);
}

/** The business-local day and minutes since local midnight of a booking. */
export function placeBooking(iso, tz) {
  const out = {};
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const p of fmt.formatToParts(new Date(iso))) out[p.type] = p.value;
  return { day: localDay(iso, tz), minutes: Number(out.hour) * 60 + Number(out.minute) };
}

/**
 * Where a booking sits on the grid: `col` indexes `days`, `top` is the
 * fraction of the 08:00–18:00 span. Null when it is outside the grid (another
 * day, before 8 am, or at or after 6 pm) — the page lists those separately.
 */
export function gridSlot({ day, minutes }, days) {
  const col = days.indexOf(day);
  if (col === -1 || minutes < GRID_START_MIN || minutes >= GRID_END_MIN) return null;
  return { col, top: (minutes - GRID_START_MIN) / (GRID_END_MIN - GRID_START_MIN) };
}

/** A real calendar day as "YYYY-MM-DD". */
export function isValidDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromUtc(toUtc(s)) === s;
}
