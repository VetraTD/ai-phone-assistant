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
