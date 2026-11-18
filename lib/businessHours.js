// ---------------------------------------------------------------------------
// lib/businessHours.js — shared day/hours resolution for the two supported
// business_hours shapes: the weekly shape from migration 014
// (`{mon:{open,close,closed}, ..., sun:{...}}`) and the legacy single
// `{open_time,close_time}` window applied every day. `null` means no hours
// configured at all (always open).
//
// Extracted so services/gemini.js (isBusinessOpen — "is the business open
// right now") and services/tools.js (book_appointment's time validation —
// "is this arbitrary future moment within the business's hours") reason
// about the shapes identically instead of each re-deriving the branching.
// ---------------------------------------------------------------------------

/**
 * Resolve business hours for one specific weekday, independent of "now".
 * @param {object|null} businessHours - weekly shape, legacy shape, or null
 * @param {string} shortWeekday - "mon".."sun" (only consulted for the weekly shape)
 * @returns {{ closed: boolean, open: string|null, close: string|null }}
 *   closed:true -> the business does not open at all that day.
 *   closed:false with open/close both null -> open all day (no hours configured
 *   for that day/shape, or businessHours itself is null).
 *   closed:false with open/close set -> open within the [open, close) window.
 */
export function resolveDayHours(businessHours, shortWeekday) {
  if (!businessHours) return { closed: false, open: null, close: null };

  // Weekly shape (migration 014-plus) — detected by the presence of a `mon` key.
  if (businessHours.mon !== undefined) {
    const today = businessHours[shortWeekday];
    if (!today || today.closed) return { closed: true, open: null, close: null };
    if (!today.open || !today.close) return { closed: false, open: null, close: null };
    return { closed: false, open: today.open, close: today.close };
  }

  // Legacy shape: single window applied every day.
  const { open_time, close_time } = businessHours;
  if (!open_time || !close_time) return { closed: false, open: null, close: null };
  return { closed: false, open: open_time, close: close_time };
}

/**
 * "09:00" -> "9:00 AM", "17:00" -> "5:00 PM". Returns null for anything that
 * doesn't parse as HH:MM (never renders "undefined" into spoken/prompt text).
 * @param {string|null|undefined} hhmm
 * @returns {string|null}
 */
export function formatClockTime(hhmm) {
  if (typeof hhmm !== "string") return null;
  const parts = hhmm.split(":");
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

const WEEKDAY_LABELS = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * Resolve business_hours (either shape — see isBusinessOpen) into a shape
 * convenient for prompt rendering: today's hours plus which days are fully
 * closed. Shared by buildDynamicTail's DATE/TIME section and the
 * book_appointment step guidance so both stay in sync.
 *
 * Same midnight-spanning limitation as isBusinessOpen (see its docstring) —
 * rangeText is rendered literally even if close < open.
 *
 * @param {object} config - loadConfig() output
 * @param {Date} now
 * @returns {null | { weekly: boolean, todayLabel: string|null, closedToday: boolean, rangeText: string|null, closedDays: string[] }}
 */
export function resolveBusinessHoursForPrompt(config, now) {
  const hours = config.businessHours;
  if (!hours) return null;

  if (hours.mon !== undefined) {
    // Weekly shape (migration 014-plus; also the default for every new
    // business via the businesses.business_hours column default).
    const todayLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      weekday: "long",
    }).format(now);
    const shortWeekday = todayLabel.slice(0, 3).toLowerCase();
    const today = hours[shortWeekday];
    const closedDays = WEEKDAY_ORDER.filter((d) => hours[d]?.closed).map((d) => WEEKDAY_LABELS[d]);

    if (!today || today.closed) {
      return { weekly: true, todayLabel, closedToday: true, rangeText: null, closedDays };
    }
    const openText = formatClockTime(today.open);
    const closeText = formatClockTime(today.close);
    return {
      weekly: true,
      todayLabel,
      closedToday: false,
      rangeText: openText && closeText ? `${openText} – ${closeText}` : null,
      closedDays,
    };
  }

  // Legacy shape: single window applied every day.
  if (hours.open_time && hours.close_time) {
    return { weekly: false, todayLabel: null, closedToday: false, rangeText: `${hours.open_time} – ${hours.close_time}`, closedDays: [] };
  }
  return null;
}

/**
 * The WHOLE week, as one speakable line.
 *
 * resolveBusinessHoursForPrompt above deliberately collapses the week to
 * today's window plus the NAMES of fully-closed days, which is the right shape
 * for "are we open right now". It is the wrong shape for "what are your
 * hours", and on 2026-09-03 that cost two false statements on one call: asked
 * for the hours, the model had exactly one data point — "Business hours today
 * (Thursday): 8:00 AM – 5:00 PM. Closed Sunday." — and extrapolated "Monday
 * through Friday, 8 to 5, closed Sundays". Friday actually shuts at 4, and
 * Saturday is a trading day that went unmentioned, so a caller who wanted a
 * Saturday appointment was told there was no such thing. The same absent
 * schedule made an earlier call narrate a correct availability refusal as
 * "we're actually closed that day". See LVX55.
 *
 * Adjacent days with identical hours collapse into a run, so a normal week is
 * two or three clauses rather than seven. Rendered into the STATIC prefix, not
 * the per-turn tail: the week is business-stable, which keeps it cache-correct
 * and — on the Live front-end, where the prompt is frozen at connect (LVX46) —
 * means it cannot go stale mid-call the way "today" can.
 *
 * @param {object|null|undefined} businessHours - weekly shape, legacy shape, or null
 * @returns {string|null} null when there is no weekly schedule to state at all
 *   (no hours configured — an always-open tenant like Digile Media — or a
 *   legacy window missing an end).
 */
export function formatWeeklyHours(businessHours) {
  if (!businessHours) return null;

  // Legacy shape carries no per-day information, so there is no week to render
  // and none may be invented. formatClockTime rather than the raw "09:00" the
  // resolver emits: this string is read aloud.
  if (businessHours.mon === undefined) {
    const openText = formatClockTime(businessHours.open_time);
    const closeText = formatClockTime(businessHours.close_time);
    if (!openText || !closeText) return null;
    return `Every day: ${openText} – ${closeText}.`;
  }

  // "open" rather than a window when a day is flagged not-closed but carries no
  // times — the same reason formatClockTime returns null instead of rendering
  // "undefined" into text a caller hears.
  const describeDay = (day) => {
    if (day.closed) return "closed";
    const openText = formatClockTime(day.open);
    const closeText = formatClockTime(day.close);
    return openText && closeText ? `${openText} – ${closeText}` : "open";
  };

  const described = WEEKDAY_ORDER.map((d) => describeDay(resolveDayHours(businessHours, d)));

  const parts = [];
  let runStart = 0;
  for (let i = 1; i <= WEEKDAY_ORDER.length; i += 1) {
    // Only ADJACENT days collapse, so a Saturday that happens to match Monday
    // never gets folded into a run that would imply the days between it.
    if (i < WEEKDAY_ORDER.length && described[i] === described[runStart]) continue;
    const from = WEEKDAY_LABELS[WEEKDAY_ORDER[runStart]];
    const to = WEEKDAY_LABELS[WEEKDAY_ORDER[i - 1]];
    parts.push(`${i - 1 === runStart ? from : `${from} to ${to}`}: ${described[runStart]}.`);
    runStart = i;
  }
  return parts.join(" ");
}
