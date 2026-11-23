// Dates, times and numbers as the dashboard shows them. Every time is shown on
// the BUSINESS's clock (its timezone), never the viewer's: an owner abroad, or
// a browser set to another zone, still sees "9:05 am" for a 9:05 call.

function parts(iso, tz, options) {
  const out = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...options }).formatToParts(new Date(iso))) {
    out[p.type] = p.value;
  }
  return out;
}

/** "9:05 am" */
export function formatTime(iso, tz) {
  const p = parts(iso, tz, { hour: "numeric", minute: "2-digit", hour12: true });
  return `${p.hour}:${p.minute} ${(p.dayPeriod || "").toLowerCase()}`.trim();
}

/** "Tuesday 24 November" */
export function formatDate(iso, tz) {
  const p = parts(iso, tz, { weekday: "long", day: "numeric", month: "long" });
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Tuesday 24 November, 9:00 am" */
export function formatDateTime(iso, tz) {
  return `${formatDate(iso, tz)}, ${formatTime(iso, tz)}`;
}

/** "2026-11-24": the calendar day in the business's timezone. */
export function localDay(iso, tz) {
  const p = parts(iso, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Today" | "Yesterday" | "Friday 20 November" */
export function dayHeading(iso, tz, now = new Date()) {
  const day = localDay(iso, tz);
  const today = localDay(now, tz);
  if (day === today) return "Today";
  // The day before, worked out on the calendar date itself: anchoring on a UTC
  // time instead lands on the wrong day for zones far from UTC (New Zealand).
  const [y, m, d] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  if (day === yesterday) return "Yesterday";
  return formatDate(iso, tz);
}

// What a phone network sends when the caller hid their number: words, or the
// keypad spellings Twilio uses for them (ANONYMOUS, RESTRICTED, BLOCKED,
// UNKNOWN, UNAVAILABLE). None of them can be rung back.
const WITHHELD_WORDS = /^(anonymous|restricted|private|blocked|unknown|unavailable|withheld)$/i;
const WITHHELD_NUMBERS = new Set(["+266696687", "+7378742833", "+2562533", "+8656696", "+86282452253"]);

function isWithheld(number) {
  const v = typeof number === "string" ? number.trim() : "";
  return !v || WITHHELD_WORDS.test(v) || WITHHELD_NUMBERS.has(v);
}

/**
 * A safe `tel:` link, or null. The only way the dashboard builds one: spaces,
 * brackets, dashes and dots are dropped, and what is left must be a phone
 * number (an optional + and 7 to 15 digits). Withheld numbers get no link.
 */
export function telHref(number) {
  if (typeof number !== "string" || isWithheld(number)) return null;
  const cleaned = number.replace(/[\s().-]/g, "");
  return /^\+?\d{7,15}$/.test(cleaned) ? `tel:${cleaned}` : null;
}

/** The name, else the number, else "Withheld number". */
export function callerLabel({ callerName, callerNumber } = {}) {
  if (typeof callerName === "string" && callerName.trim()) return callerName.trim();
  if (!isWithheld(callerNumber)) return formatPhone(callerNumber);
  return "Withheld number";
}

/**
 * A number as people read it: "+44 7700 900123" for a UK number,
 * "+1 (555) 019-9001" for a North American one, else as stored. Display only:
 * a tel: link still comes from telHref, on the number as stored.
 */
export function formatPhone(e164) {
  const v = typeof e164 === "string" ? e164.trim() : "";
  let m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(v);
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
  m = /^\+44(\d{4})(\d{6})$/.exec(v);
  if (m) return `+44 ${m[1]} ${m[2]}`;
  return v;
}

/** "Today" | "Yesterday" | "Fri 20 Nov": short enough to sit on one line beside a time. */
export function shortDay(iso, tz, now = new Date()) {
  const heading = dayHeading(iso, tz, now);
  if (heading === "Today" || heading === "Yesterday") return heading;
  const p = parts(iso, tz, { weekday: "short", day: "numeric", month: "short" });
  return `${p.weekday} ${p.day} ${p.month}`;
}
