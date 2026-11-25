/**
 * Owner re-test call 1 (2026-11-25): the receptionist saved "When: 3:00 p.m.
 * Sunday" although the business's notes asked for a date. The owner email now
 * adds the date a relative day word means, worked out in code from the call
 * time in the business's time zone, so the dispatcher never has to.
 *
 * Pure and offline. It only ADDS a note after the caller's words; it never
 * changes them. A wrong date is worse than none, so anything it cannot pin to
 * one FUTURE day is left as said:
 *   - "next Sunday" (this one or the one after?), "every Sunday", "Sunday
 *     week", "the Sunday after", "or" (two candidate days), two day words;
 *   - a text that already carries a date, in figures or in words ("the sixth
 *     of December", "2026-12-06", "06.12.2026", any month name);
 *   - a past event ("left it on Saturday", "was rude on Friday", "last Sunday");
 *   - the weekday the call is on (today, or a week away?);
 *   - before 5am, the weekday just gone ("Friday night" said at 01:00 Saturday).
 * "Tomorrow" or "tonight" said before 5am gets its date with a flag, since a
 * caller at 01:00 may mean later today. Callers pick which answers take a note
 * with dayNoteLabel: an address ("12 Friday Street") or a past trip ("Trip
 * date") never does.
 */

import { DEFAULT_TIMEZONE } from "./capabilities/datetime.js";

const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const SHORT_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const DAY_WORD_RE = /\b(today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
const NOT_ONE_DAY_RE =
  /\b(?:next|every|each|weeks?|fortnight|until|till|between|weekdays?|weekends?|after|following|or)\b/i;
const PAST_RE = /\b(?:last|ago|yesterday|was|were|did|had|happened|left|lost|forgot|forgotten|went|came)\b/i;
const ORDINAL_RE = /\b\d{1,2}(?:st|nd|rd|th)\b/i;
const ORDINAL_WORD_RE =
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)\b/i;
const NUMERIC_DATE_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{1,2}\/\d{1,2}\b/;
const MONTH_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const EARLY_HOURS_END = 5;

/** Labels that ask WHEN something will happen. "Trip date" (a past trip) and addresses are not among them. */
const DAY_NOTE_LABEL_RE = /\b(?:when|time|times|flight|departure|arrival|appointment|booking)\b/i;

/** @param {unknown} label @returns {boolean} does an answer under this label take a date note? */
export function dayNoteLabel(label) {
  return typeof label === "string" && DAY_NOTE_LABEL_RE.test(label);
}

function hasDate(text) {
  return ORDINAL_RE.test(text) || ORDINAL_WORD_RE.test(text) || NUMERIC_DATE_RE.test(text) || MONTH_RE.test(text);
}

function formatter(timezone, options) {
  const zone = typeof timezone === "string" && timezone.trim() ? timezone.trim() : DEFAULT_TIMEZONE;
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: DEFAULT_TIMEZONE });
  }
}

/** The call's local calendar day, weekday and time, or null. */
function localParts(when, timezone) {
  const parts = formatter(timezone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(when);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = SHORT_INDEX[get("weekday")];
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  if (weekday === undefined || !year || !month || !day) return null;
  return { year, month, day, weekday, hour: Number(get("hour")), minute: get("minute") };
}

function dayText(year, month, day) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day))
  );
}

/**
 * @param {unknown} text the caller's answer as saved
 * @param {string|Date|null|undefined} createdAt when the message was saved
 * @param {string|null|undefined} timezone the business's IANA time zone
 * @returns {string} "" or a note to append, e.g. " (Sun 29 Nov)"
 */
export function resolvedDayNote(text, createdAt, timezone) {
  if (typeof text !== "string" || !text.trim() || createdAt == null) return "";
  const words = new Set((text.match(DAY_WORD_RE) || []).map((w) => w.toLowerCase()));
  if (words.size !== 1) return "";
  if (NOT_ONE_DAY_RE.test(text) || PAST_RE.test(text) || hasDate(text)) return "";
  const when = new Date(createdAt);
  if (Number.isNaN(when.getTime())) return "";
  const now = localParts(when, timezone);
  if (!now) return "";
  const early = now.hour < EARLY_HOURS_END;
  const [word] = words;
  let offset;
  if (word === "today" || word === "tonight") offset = 0;
  else if (word === "tomorrow") offset = 1;
  else {
    offset = (DAY_INDEX[word] - now.weekday + 7) % 7;
    if (offset === 0) return "";
    if (early && offset === 6) return "";
  }
  const date = dayText(now.year, now.month, now.day + offset);
  if (early && (word === "tomorrow" || word === "tonight")) {
    return ` (${date}? said at ${String(now.hour).padStart(2, "0")}:${now.minute}, check the day)`;
  }
  return ` (${date})`;
}
