/**
 * Deterministic time helpers for scenarios.
 *
 * The brain reads the REAL wall clock: services/gemini.js:527 renders the
 * current date/time into the prompt tail, isBusinessOpen() checks "now" against
 * the configured hours, and lib/capabilities/datetime.js anchors a naive
 * booking string to an absolute instant using the real timezone offset. None of
 * that is injectable. So a scenario that needs "the office is open right now" or
 * "next Tuesday at 3 PM" must express those RELATIVE to the real current time,
 * or it would pass at 2 PM and fail at 2 AM.
 *
 * These helpers build a businessHours config / an appointment ISO from `now`
 * (defaulting to the real clock) so the scenario means the same thing whenever
 * it runs. They take an optional `now` ONLY so the unit tests can pin a
 * reference instant and assert the relationship — production callers omit it.
 *
 * `nextWeekdayAt` deliberately reuses the SAME primitives the booking path uses
 * (zonedComponentsToUtcMs) so a seeded appointment's instant is byte-identical
 * to the one the engine derives when the model books "next Tuesday at 3 PM" —
 * which is what makes a seeded-conflict scenario actually conflict.
 */

import {
  zonedComponentsToUtcMs,
  zonedWeekdayAndMinutes,
  parseNaiveDateTime,
  HAS_OFFSET_RE,
} from "../lib/capabilities/datetime.js";
import { resolveDayHours } from "../lib/businessHours.js";

const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Normalize "Tuesday" / "tue" / "TUE" to the short lower-case key. */
function shortDay(weekday) {
  return String(weekday).slice(0, 3).toLowerCase();
}

/**
 * Injectable twin of services/gemini.js isBusinessOpen — same weekly/legacy/null
 * handling, same `[open, close)` comparison — but reasoning about an explicit
 * `now` so the helpers above can be tested without mocking the clock.
 *
 * @param {object|null} businessHours
 * @param {{ now?: Date, timezone: string }} opts
 * @returns {boolean}
 */
export function isOpenNow(businessHours, { now = new Date(), timezone } = {}) {
  if (!businessHours) return true;
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(now.getTime(), timezone);
  const day = resolveDayHours(businessHours, shortWeekday);
  if (day.closed) return false;
  if (!day.open || !day.close) return true;
  const [openH, openM] = day.open.split(":").map(Number);
  const [closeH, closeM] = day.close.split(":").map(Number);
  return minutesOfDay >= openH * 60 + openM && minutesOfDay < closeH * 60 + closeM;
}

/**
 * A weekly-hours config that reads OPEN at `now` in `timezone`.
 *
 * Every day is open the full day (00:00–23:59). Full-day windows — rather than
 * a tight bracket around the current minute — mean the config stays correct if
 * the conversation drifts across a minute boundary mid-run, and stays open even
 * if it crosses into the next calendar day. The single unrepresentable instant
 * is exactly 23:59 local (the half-open upper bound), a 1-in-1440 risk that
 * only bites a suite started in that minute; documented, not defended against.
 */
export function hoursOpenNow({ now = new Date(), timezone } = {}) {
  void now;
  void timezone;
  const hours = {};
  for (const d of WEEKDAY_ORDER) hours[d] = { open: "00:00", close: "23:59", closed: false };
  return hours;
}

/**
 * A weekly-hours config that reads CLOSED at `now`. Every day is marked closed,
 * so the business is deterministically closed at any instant — robust to
 * minute drift and day-boundary crossings alike.
 */
export function hoursClosedNow({ now = new Date(), timezone } = {}) {
  void now;
  void timezone;
  const hours = {};
  for (const d of WEEKDAY_ORDER) hours[d] = { open: null, close: null, closed: true };
  return hours;
}

/**
 * The next occurrence of `weekday` at wall-clock `hhmm` in `timezone`, as an
 * absolute UTC ISO string — matching exactly what the engine would derive from
 * a naive booking of the same day/time (same zonedComponentsToUtcMs path).
 *
 * @param {string} weekday - "tue" | "Tuesday" | …
 * @param {string} hhmm - "15:00"
 * @param {{ now?: Date, timezone: string, minDaysAhead?: number }} opts
 * @returns {string} ISO 8601 with offset (…Z)
 */
export function nextWeekdayAt(weekday, hhmm, { now = new Date(), timezone, minDaysAhead = 1 } = {}) {
  const target = shortDay(weekday);
  const [hour, minute] = hhmm.split(":").map(Number);
  for (let add = minDaysAhead; add <= minDaysAhead + 13; add++) {
    const cand = new Date(now.getTime() + add * 86_400_000);
    const { shortWeekday } = zonedWeekdayAndMinutes(cand.getTime(), timezone);
    if (shortWeekday !== target) continue;
    const { year, month, day } = tzYearMonthDay(cand, timezone);
    const utcMs = zonedComponentsToUtcMs({ year, month, day, hour, minute, second: 0 }, timezone);
    return new Date(utcMs).toISOString();
  }
  throw new Error(`nextWeekdayAt: no "${weekday}" within two weeks of ${now.toISOString()}`);
}

/** Calendar Y/M/D of `date` as read in `timezone`. */
function tzYearMonthDay(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const { type, value } of parts) if (type !== "literal") map[type] = value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/**
 * Resolve a datetime value the MODEL produced (a naive "YYYY-MM-DDTHH:MM[:SS]"
 * or an offset-bearing ISO) to an absolute instant in ms — exactly as the
 * engine's validateBookingTime would (naive strings are interpreted in the
 * business timezone). Returns NaN if it doesn't parse.
 */
export function toInstantMs(raw, timezone) {
  if (typeof raw !== "string" || !raw.trim()) return NaN;
  const t = raw.trim();
  if (HAS_OFFSET_RE.test(t)) return Date.parse(t);
  const parsed = parseNaiveDateTime(t);
  return parsed ? zonedComponentsToUtcMs(parsed, timezone) : NaN;
}

/**
 * Whether a model-produced datetime arg denotes the same instant as `iso`, with
 * naive strings anchored in `timezone`. This is the tz-correct comparison for
 * assertions on `requested_at` / `scheduled_at` tool args — plain Date.parse on
 * a naive string would (wrongly) use the RUNNER's timezone.
 */
export function slotMatches(raw, iso, timezone) {
  const a = toInstantMs(raw, timezone);
  const b = Date.parse(iso);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/** Whether a model-produced datetime arg falls on `weekday` in `timezone`. */
export function argIsWeekday(raw, weekday, timezone) {
  const ms = toInstantMs(raw, timezone);
  if (!Number.isFinite(ms)) return false;
  const { shortWeekday } = zonedWeekdayAndMinutes(ms, timezone);
  return shortWeekday === shortDay(weekday);
}

/** Two ISO strings denote the same absolute instant (offset-agnostic). */
export function sameInstant(a, b) {
  const am = Date.parse(a);
  const bm = Date.parse(b);
  return Number.isFinite(am) && Number.isFinite(bm) && am === bm;
}

/**
 * Human, speakable rendering of an instant in `timezone`, e.g.
 * "Tuesday, July 28 at 3:00 PM" — for putting the exact seeded slot into a
 * scripted caller's mouth so the model books precisely that instant.
 */
export function spokenSlot(iso, timezone) {
  const d = new Date(Date.parse(iso));
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return `${date} at ${time}`;
}

/** Whether an ISO instant falls on `weekday` (short or long) in `timezone`. */
export function isWeekday(iso, weekday, timezone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  const { shortWeekday } = zonedWeekdayAndMinutes(ms, timezone);
  return shortWeekday === shortDay(weekday);
}
