/**
 * Per-country calling-hours floor (S3-7, spec S3-D5, owner ruling P-b).
 *
 * This is a SEPARATE, statutory floor BELOW the campaign's own configured
 * window: campaignSchema.js already caps a saved window to 08:00-21:00 local
 * (EARLIEST_MIN/LATEST_MIN, unchanged by this file), but a campaign whose
 * saved window is legal for the UK can still be illegal to dial in a US
 * state at the same clock reading, and a contact whose area code sits
 * outside the continental United States (Canada, the Caribbean, a US
 * territory) has NO owner-approved floor at all -- P-b approved only a
 * US-mainland envelope and a UK envelope. `floorFor` refuses everything else
 * rather than dial it under an envelope the owner never approved for that
 * jurisdiction (a NANPA-listed non-US area code must never fall through to
 * the US floor by omission -- see NON_US_NANP's own header).
 *
 * Pure: no I/O, no Date.now(). `floorFor` takes no clock at all; the window
 * functions below take an injected `now`.
 */
import { zonedWeekdayAndMinutes } from "../capabilities/datetime.js";
import { parseWindow, isInsideWindow as isInsideCallingWindow } from "./schedule.js";

const DAY_MS = 86_400_000;

/**
 * NANP area codes that are NOT in the continental United States: Canada, the
 * Caribbean/Atlantic NANP member countries, and the US territories. A +1
 * number whose area code is in this set gets NO floor (`{refused:
 * "no_legal_floor"}`) -- it must NEVER silently inherit the US-mainland
 * envelope just because it dials as "+1".
 *
 * SOURCE (Ruling S3-7a): nationalnanpa.com's published area-code assignments
 * is the canonical source, but it was UNREACHABLE from this environment when
 * this file was written (2026-09-28, WebFetch of https://nationalnanpa.com/,
 * https://nationalnanpa.com/area_codes/index.html and
 * https://nationalnanpa.com/enas/geoAreaCodeNumberReport.do all failed DNS
 * resolution: "getaddrinfo EAI_AGAIN nationalnanpa.com"). Per Ruling S3-7a
 * this list is built from the implementer's own knowledge instead:
 *   - The Caribbean/Atlantic and US-territory rows are cross-checked against
 *     two independent WebFetch summaries of
 *     https://en.wikipedia.org/wiki/North_American_Numbering_Plan and
 *     https://en.wikipedia.org/wiki/List_of_North_American_Numbering_Plan_area_codes
 *     (fetched 2026-09-28), which agreed with each other and with the
 *     implementer's own knowledge.
 *   - The Canada rows are from the implementer's own knowledge ONLY: the
 *     same Wikipedia fetch, when asked to summarise Canada's full table,
 *     returned several area codes that are actually US-mainland codes (e.g.
 *     206 Seattle, 417 Missouri, 608 Wisconsin) mixed in with real Canadian
 *     ones -- a small-model summarisation error over a wide HTML table --
 *     so that result was DISCARDED rather than trusted, and the Canada list
 *     below is not independently corroborated.
 * FLAG (report: Parked): verify this full list directly against NANPA
 * before a live campaign could reach a Canadian, Caribbean, or US-territory
 * number -- nationalnanpa.com was not reachable from this environment at
 * all during this task, not just briefly unavailable.
 */
export const NON_US_NANP = Object.freeze(
  new Set([
    // Canada -- every province/territory (own knowledge only; see FLAG above).
    "204", "226", "236", "249", "250", "263", "289", "306", "343", "354", "365",
    "367", "368", "403", "416", "418", "431", "437", "438", "450", "468", "506",
    "514", "519", "548", "579", "581", "584", "587", "604", "613", "639", "647",
    "672", "683", "705", "709", "742", "753", "778", "780", "782", "807", "819",
    "825", "867", "873", "902", "905",
    // Caribbean / Atlantic NANP member countries.
    "242", // Bahamas
    "246", // Barbados
    "264", // Anguilla
    "268", // Antigua and Barbuda
    "284", // British Virgin Islands
    "345", // Cayman Islands
    "441", // Bermuda
    "473", // Grenada
    "649", // Turks and Caicos Islands
    "658", "876", // Jamaica
    "664", // Montserrat
    "721", // Sint Maarten
    "758", // Saint Lucia
    "767", // Dominica
    "784", // Saint Vincent and the Grenadines
    "809", "829", "849", // Dominican Republic
    "868", // Trinidad and Tobago
    "869", // Saint Kitts and Nevis
    // US territories (brief P-b, verbatim).
    "787", "939", // Puerto Rico
    "340", // US Virgin Islands
    "671", // Guam
    "670", // Northern Mariana Islands
    "684", // American Samoa
  ])
);

/** GB envelope (P-b): 08:00-21:00, every day, no exceptions. */
const GB_WINDOWS = Object.freeze({
  mon: "08:00-21:00", tue: "08:00-21:00", wed: "08:00-21:00", thu: "08:00-21:00",
  fri: "08:00-21:00", sat: "08:00-21:00", sun: "08:00-21:00",
});

/** US-mainland envelope (P-b): Mon-Sat 08:00-20:00, Sun 12:00-20:00. */
const US_WINDOWS = Object.freeze({
  mon: "08:00-20:00", tue: "08:00-20:00", wed: "08:00-20:00", thu: "08:00-20:00",
  fri: "08:00-20:00", sat: "08:00-20:00", sun: "12:00-20:00",
});

/**
 * The owner-approved per-country calling-hours floor for a contact (P-b).
 *
 * @param {string} phoneE164 - the contact's dialled number, E.164
 * @param {string|null} [rawTimezone] - the RAW `contacts.timezone` value
 *   (null/empty when unset on the row) -- NOT schedule.js's
 *   `contactTimezone()` fallback. Ruling S3-7a: a US contact with no
 *   timezone on file must clear the floor in BOTH America/New_York and
 *   America/Los_Angeles at once, and that rule can only fire when this
 *   function sees the true absence rather than a business-timezone guess a
 *   caller already substituted in.
 * @returns {{country: "US"|"GB", zones: string[], windows: Record<string,string>}
 *   | {refused: "no_legal_floor"}}
 */
export function floorFor(phoneE164, rawTimezone) {
  const phone = typeof phoneE164 === "string" ? phoneE164 : "";
  const tz = typeof rawTimezone === "string" && rawTimezone.trim() ? rawTimezone.trim() : null;

  if (phone.startsWith("+44")) {
    return { country: "GB", zones: [tz ?? "Europe/London"], windows: GB_WINDOWS };
  }

  const nanp = /^\+1(\d{3})\d{7}$/.exec(phone);
  if (nanp) {
    const areaCode = nanp[1];
    if (NON_US_NANP.has(areaCode)) return { refused: "no_legal_floor" };
    // No owner-approved timezone on file: BOTH US coasts must clear the
    // floor at once (Ruling S3-7a) -- isInsideFloor (below) requires every
    // listed zone to pass, so listing both here is what enforces "both".
    return { country: "US", zones: tz ? [tz] : ["America/New_York", "America/Los_Angeles"], windows: US_WINDOWS };
  }

  // Every other country code: no owner-approved envelope exists (P-b only
  // approved US-mainland and UK). Fail closed -- never dial under an
  // envelope nobody approved for this jurisdiction.
  return { refused: "no_legal_floor" };
}

/** `date`'s wall-clock reading in `tz`, against one day's "HH:MM-HH:MM" entry. */
function isInsideZone(date, windows, tz) {
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(date.getTime(), tz);
  const w = parseWindow(windows[shortWeekday] ?? null);
  return !!w && minutesOfDay >= w.start && minutesOfDay < w.end;
}

/**
 * Is `date` inside the floor? A floor with more than one zone (the US
 * "no timezone on file" case) requires EVERY zone to pass, not any one of
 * them -- named risk 2: applying the rule with only one of the two coasts
 * would silently narrow "both" to "either".
 * @param {Date} date
 * @param {{zones: string[], windows: Record<string,string>}} floor - a
 *   non-refused `floorFor` result
 * @returns {boolean}
 */
export function isInsideFloor(date, floor) {
  return floor.zones.every((tz) => isInsideZone(date, floor.windows, tz));
}

/**
 * The next instant at or after `now` where BOTH the floor (every zone) and
 * the campaign's own calling window (on the contact's resolved clock) are
 * open at once. Bounded -- `maxDays` calendar days -- and FAILS CLOSED: a
 * caller that gets `null` back must treat it as "no legal opening exists",
 * never as "allow" (named risk 1).
 *
 * Per-minute resolution (matches schedule.js's own isInsideWindow/
 * nextWindowOpening minute granularity): both envelopes' entries always sit
 * on whole-hour boundaries today, but a per-minute scan needs no such
 * assumption to stay correct, and `maxDays` bounds the cost.
 *
 * @param {Date} now
 * @param {{zones: string[], windows: Record<string,string>}} floor - a
 *   non-refused `floorFor` result
 * @param {object|null} callingWindow - the campaign's own `calling_window`
 * @param {string} contactTz - the contact's RESOLVED timezone (schedule.js's
 *   `contactTimezone()` fallback already applied) -- the same zone the
 *   campaign's own window check already evaluates against
 * @param {{maxDays?: number, stepMs?: number}} [o]
 * @returns {Date|null}
 */
export function nextLegalOpening(now, floor, callingWindow, contactTz, { maxDays = 8, stepMs = 60_000 } = {}) {
  const limit = now.getTime() + maxDays * DAY_MS;
  for (let t = now.getTime() + stepMs; t <= limit; t += stepMs) {
    const candidate = new Date(t);
    if (isInsideFloor(candidate, floor) && isInsideCallingWindow(candidate, callingWindow, contactTz)) {
      return candidate;
    }
  }
  return null;
}
