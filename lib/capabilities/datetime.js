/**
 * Timezone-anchoring primitives shared by capability packs.
 *
 * Moved verbatim out of services/tools.js during the capability-packs refactor
 * (Step A — pure move, no behavior change). These are general datetime
 * utilities, not appointment logic: any capability that accepts a wall-clock
 * time from the model needs them, because the model emits naive
 * "YYYY-MM-DDTHH:MM" strings with no timezone at all.
 *
 * No timezone database is used — only Intl.DateTimeFormat's own timeZone
 * resolution, the same technique services/gemini.js's isBusinessOpen and
 * resolveBusinessHoursForPrompt rely on.
 */

/** Strict naive datetime: "YYYY-MM-DDTHH:MM[:SS]", no offset, no Z. */
export const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Trailing "Z" or "+HH:MM"/"-HH:MM" — the value is already unambiguous. */
export const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Parse a strict naive "YYYY-MM-DDTHH:MM[:SS]" datetime (no offset/Z) into
 * numeric components, rejecting out-of-range or calendar-impossible dates
 * (month 13, Feb 30, ...).
 * @param {string} str
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}|null}
 */
export function parseNaiveDateTime(str) {
  const m = NAIVE_DATETIME_RE.exec(str);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  // Round-trip through Date.UTC to reject calendar-impossible dates (e.g.
  // Feb 30 rolls over to Mar 2 and would silently mismatch).
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

/**
 * Offset (ms) such that: (wall-clock reading of `date` in `timeZone`) ===
 * date.getTime() + offset. E.g. for America/Chicago in summer (UTC-5), the
 * offset is roughly -5*3600*1000.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number}
 */
export function getTzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/**
 * Convert naive local wall-clock components, interpreted in `timeZone`, into
 * the absolute UTC instant (ms since epoch) they represent. Standard
 * "guess against the offset at the guessed instant, then refine once against
 * the offset actually at the guessed UTC instant" approach so a
 * DST-transition day doesn't throw the result off by an hour.
 * @param {{year:number,month:number,day:number,hour:number,minute:number,second:number}} components
 * @param {string} timeZone
 * @returns {number} ms since epoch
 */
export function zonedComponentsToUtcMs({ year, month, day, hour, minute, second }, timeZone) {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getTzOffsetMs(new Date(guessMs), timeZone);
  let utcMs = guessMs - offset1;
  const offset2 = getTzOffsetMs(new Date(utcMs), timeZone);
  if (offset2 !== offset1) utcMs = guessMs - offset2;
  return utcMs;
}

/** The one place the "no timezone configured" fallback is decided. */
export const DEFAULT_TIMEZONE = "America/Chicago";

/**
 * Format an absolute instant in a business's local time.
 *
 * Lives here rather than in a capability pack because more than one read path
 * needs it and they MUST agree. services/gemini.js's CALLER CONTEXT block used
 * to hand-roll its own toLocaleString with no fallback, so an unset business
 * timezone silently fell back to the Node process zone while the appointment
 * tool path fell back to America/Chicago — the same row read back two different
 * ways depending on which path spoke it.
 *
 * @param {string} iso - an absolute instant (ISO with offset/Z)
 * @param {string|undefined} timezone - IANA zone; defaults to DEFAULT_TIMEZONE
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
export function formatLocalDateTime(iso, timezone, options) {
  const tz = timezone || DEFAULT_TIMEZONE;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  try {
    return new Date(ms).toLocaleString("en-US", { timeZone: tz, ...options });
  } catch {
    // An invalid IANA zone throws rather than falling back. Returning the raw
    // value keeps a bad config from taking down a live call.
    return String(iso);
  }
}

/**
 * A fully spoken local datetime for an instant the model must say aloud —
 * e.g. "Thursday, July 30 at 2:00 PM" in the business timezone.
 * @param {string} iso - an absolute instant
 * @param {string|undefined} timezone
 * @returns {string}
 */
export function speakableDateTime(iso, timezone, profile) {
  if (!Number.isFinite(Date.parse(iso))) return String(iso);
  const time = formatLocalDateTime(iso, timezone, { hour: "numeric", minute: "2-digit" });

  // Built from parts rather than handed to Intl. toLocaleString("en-GB") gives
  // "Thursday 6 August" and "14:00", and neither is what a British
  // receptionist says out loud — they say "Thursday the 6th of August at 2 PM".
  // Twelve-hour with a meridiem for both markets, for the same reason: nobody
  // answering a phone says "fourteen hundred".
  if (profile?.dateStyle === "DMY") {
    const weekday = formatLocalDateTime(iso, timezone, { weekday: "long" });
    const month = formatLocalDateTime(iso, timezone, { month: "long" });
    const day = formatLocalDateTime(iso, timezone, { day: "numeric" });
    return `${weekday} the ${ordinal(day)} of ${month} at ${time}`;
  }

  const date = formatLocalDateTime(iso, timezone, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return `${date} at ${time}`;
}

/** "6" -> "6th". Spoken, so the suffix has to be right for 1st/2nd/3rd/11th. */
function ordinal(day) {
  const n = Number.parseInt(day, 10);
  if (!Number.isFinite(n)) return String(day);
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

/**
 * Render an absolute instant as the naive wall-clock string it corresponds to
 * in `timeZone` — "YYYY-MM-DDTHH:MM:SS", no offset.
 *
 * This is what makes the model's datetime contract single-valued. Tool results
 * used to hand back raw UTC ISO ("machine-readable"), so the model could echo a
 * UTC instant into a booking argument while the tool DECLARATIONS asked for a
 * naive local one. Two spellings of a time, one field, no way for
 * validateBookingTime to tell which it was looking at.
 *
 * Emitting naive local here means every datetime the model ever sees is in the
 * same frame as every datetime it is asked to produce.
 *
 * @param {string|number|Date} instant
 * @param {string|undefined} timeZone
 * @returns {string} naive local datetime, or "" when the input is not a valid instant
 */
export function toLocalNaiveDateTime(instant, timeZone) {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (!Number.isFinite(ms)) return "";
  const tz = timeZone || DEFAULT_TIMEZONE;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = {};
    for (const { type, value } of dtf.formatToParts(new Date(ms))) {
      if (type !== "literal") p[type] = value;
    }
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return "";
  }
}

/**
 * Read an absolute instant's wall-clock weekday and minute-of-day in a given
 * timezone. Used by business-hours checks, which must reason about the
 * caller's local clock rather than UTC.
 * @param {number} utcMs
 * @param {string} timeZone
 * @returns {{shortWeekday: string, minutesOfDay: number}}
 */
export function zonedWeekdayAndMinutes(utcMs, timeZone) {
  const zoned = new Date(utcMs);
  const shortWeekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(zoned)
    .slice(0, 3)
    .toLowerCase();
  const timeParts = zoned.toLocaleTimeString("en-GB", { timeZone, hour12: false }).split(":");
  const minutesOfDay = parseInt(timeParts[0], 10) * 60 + parseInt(timeParts[1], 10);
  return { shortWeekday, minutesOfDay };
}
