/**
 * Retry-schedule grammar and calling-window arithmetic (spec §8), always on
 * the CONTACT's wall clock. Pure: no I/O, no Date.now() -- `now` and `rand`
 * are arguments, so every test is exact.
 *
 * Reuses lib/capabilities/datetime.js for zone conversion, which already
 * handles the DST-transition day by refining the offset once.
 */
import { zonedComponentsToUtcMs, zonedWeekdayAndMinutes } from "../capabilities/datetime.js";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseScheduleEntry(s) {
  const bad = () => new Error(`bad schedule entry: ${JSON.stringify(s)}`);
  if (typeof s !== "string") throw bad();
  if (s === "now") return { kind: "now" };
  let m = s.match(/^\+([1-9]\d{0,3})([mh])$/);
  if (m) return { kind: "offset", ms: Number(m[1]) * (m[2] === "m" ? 60_000 : 3_600_000) };
  m = s.match(/^next_day (\d\d:\d\d)$/);
  if (m) { const t = m[1].match(HHMM); if (!t) throw bad(); return { kind: "next_day", h: +t[1], m: +t[2] }; }
  m = s.match(/^day_([1-9]\d?) (\d\d:\d\d)$/);
  if (m) { const t = m[2].match(HHMM); if (!t) throw bad(); return { kind: "day_n", n: +m[1], h: +t[1], m: +t[2] }; }
  throw bad();
}

/** Local calendar date (y, m, d) of an instant in a zone. */
function localDate(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)])
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** The same local date moved by `days` calendar days (DST-safe: calendar arithmetic, not ms). */
function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function atLocal(ymd, h, m, tz) {
  return new Date(zonedComponentsToUtcMs({ ...ymd, hour: h, minute: m, second: 0 }, tz));
}

export function computeAttemptAt({ entry, now, lastEndedAt = null, createdAt, timezone }) {
  const e = typeof entry === "string" ? parseScheduleEntry(entry) : entry;
  switch (e.kind) {
    case "now": return new Date(now.getTime());
    case "offset": return new Date((lastEndedAt ?? now).getTime() + e.ms);
    case "next_day": return atLocal(addDays(localDate(lastEndedAt ?? now, timezone), 1), e.h, e.m, timezone);
    case "day_n": return atLocal(addDays(localDate(createdAt, timezone), e.n - 1), e.h, e.m, timezone);
    default: throw new Error(`bad schedule entry kind: ${e.kind}`);
  }
}

export function parseWindow(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).match(/^(\d\d:\d\d)-(\d\d:\d\d)$/);
  if (!m) throw new Error(`bad window: ${JSON.stringify(s)}`);
  const a = m[1].match(HHMM), b = m[2].match(HHMM);
  if (!a || !b) throw new Error(`bad window: ${JSON.stringify(s)}`);
  const start = +a[1] * 60 + +a[2], end = +b[1] * 60 + +b[2];
  if (end <= start) throw new Error(`bad window: ${JSON.stringify(s)}`);
  return { start, end };
}

const WEEKDAY_KEY = { mon: "mon_fri", tue: "mon_fri", wed: "mon_fri", thu: "mon_fri", fri: "mon_fri", sat: "sat", sun: "sun" };

export function dayWindow(callingWindow, shortWeekday) {
  return parseWindow(callingWindow?.[WEEKDAY_KEY[shortWeekday]] ?? null);
}

export function isInsideWindow(date, callingWindow, tz) {
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(date.getTime(), tz);
  const w = dayWindow(callingWindow, shortWeekday);
  return !!w && minutesOfDay >= w.start && minutesOfDay < w.end;
}

export function nextWindowOpening(date, callingWindow, tz) {
  const today = localDate(date, tz);
  for (let k = 0; k <= 7; k++) {
    const ymd = addDays(today, k);
    const noon = atLocal(ymd, 12, 0, tz);
    const { shortWeekday } = zonedWeekdayAndMinutes(noon.getTime(), tz);
    const w = dayWindow(callingWindow, shortWeekday);
    if (!w) continue;
    const opening = atLocal(ymd, Math.floor(w.start / 60), w.start % 60, tz);
    if (opening.getTime() > date.getTime()) return opening;
    // Today, already open, not yet closed: "now" is inside, so the opening that matters is the next one.
  }
  return null;
}

export function applyWindow(date, callingWindow, tz, rand = Math.random) {
  if (isInsideWindow(date, callingWindow, tz)) return date;
  const opening = nextWindowOpening(date, callingWindow, tz);
  if (!opening) return date; // no open day at all: the gate refuses such a campaign at save
  return new Date(opening.getTime() + Math.floor(rand() * 10 * 60_000));
}

export function contactTimezone(contact, businessTz) {
  if (contact?.timezone) return contact.timezone;
  if (String(contact?.phone_e164 || "").startsWith("+44")) return "Europe/London";
  return businessTz || "Europe/London";
}
