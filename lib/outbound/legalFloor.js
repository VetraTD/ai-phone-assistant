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
 * jurisdiction (an unrecognised +1 area code must never fall through to the
 * US floor by omission -- see US_MAINLAND_NANP's own header).
 *
 * Pure: no I/O, no Date.now(). `floorFor` takes no clock at all; the window
 * functions below take an injected `now`.
 */
import { readFileSync } from "node:fs";
import { zonedWeekdayAndMinutes, zonedComponentsToUtcMs } from "../capabilities/datetime.js";
import { parseWindow, isInsideWindow as isInsideCallingWindow, dayWindow } from "./schedule.js";
import { log } from "../logger.js";

const DAY_MS = 86_400_000;

/**
 * NANP area codes assigned to a GEOGRAPHIC location in the continental
 * United States (the 48 contiguous states + DC) -- P-b's "US-mainland
 * envelope". This is an ALLOW-list (controller Ruling R4, superseding Ruling
 * S3-7a below): a +1 number whose area code is NOT in this set gets NO floor
 * (`{refused: "no_legal_floor"}`), REGARDLESS of whether it is a known
 * non-US NANP code, an Alaska/Hawaii/territory code, or simply a code this
 * list happens to be missing. The previous design was a DENY-list
 * (`NON_US_NANP`, listing Canada/Caribbean/territory codes): any code that
 * list omitted silently fell through to the US-mainland envelope, so the
 * design failed OPEN on the list's own incompleteness -- the exact failure
 * mode an owner-approved calling-hours floor must never have. An allow-list
 * fails CLOSED on the identical kind of gap instead: an omitted code is
 * refused, not dialled under hours nobody approved for it.
 *
 * Alaska (907) and Hawaii (808) are deliberately NOT in this set: P-b
 * approved a "US-mainland" envelope only, and neither state's calling hours
 * were reviewed against it (own knowledge; FLAG below).
 *
 * SOURCE: nationalnanpa.com's published area-code assignments is the
 * canonical source, but it was UNREACHABLE from this environment when this
 * list was built (2026-09-28, WebFetch of
 * https://nationalnanpa.com/area_codes/index.html failed DNS resolution:
 * "getaddrinfo EAI_AGAIN nationalnanpa.com", the same failure Ruling S3-7a
 * recorded). Built instead from two WebFetch passes over
 * https://en.wikipedia.org/wiki/List_of_North_American_Numbering_Plan_area_codes
 * (fetched 2026-09-28) -- the first pass truncated California, Arizona,
 * North Dakota, South Dakota and Vermont entirely (the summariser dropped
 * them, not the source table), so a second, narrower fetch targeted just
 * those regions. A residual set of overlay codes the fetch's own summary
 * left as "not detailed in excerpt" (e.g. many original 1947 codes whose
 * Wikipedia cell is a footnote rather than a plain sentence) plus several
 * more recent overlays (e.g. GA 470/478/762/943, TX 682/806/940, NC 980, MI
 * 586/616/906, WI 534/715, PA 484, VA 571, LA 985, MS 769, SC 839/854, IA
 * 641/712, CT 959, MA 857, NV 725, FL 727/754/813/863, AZ 480/520/602/623/928,
 * CA 530/559/619/626/657/661/714/747/820/858/909/925/949/951, ND 701, SD 605,
 * VT 802) are the implementer's own knowledge, NOT independently
 * corroborated by either fetch pass.
 *
 * FLAG (report: owner/counsel): verify this full list directly against
 * NANPA before a live campaign could reach a number whose area code is not
 * obviously a major-metro one -- nationalnanpa.com was not reachable from
 * this environment at all during this task. A refused number under-serves a
 * legitimate US-mainland contact (safe direction); a wrongly-included one
 * would not (there are none here by construction -- every code below is
 * either fetch-sourced or a well-known metro/state code), but the list is
 * very unlikely to be exhaustive over every overlay ever assigned.
 */
export const US_MAINLAND_NANP = Object.freeze(
  new Set([
    // Alabama
    "205", "251", "256", "334", "483", "659", "938",
    // Arizona
    "480", "520", "602", "623", "928",
    // Arkansas
    "327", "501", "870",
    // California
    "209", "213", "279", "310", "323", "341", "350", "357", "408", "415",
    "424", "442", "530", "559", "619", "626", "650", "657", "661", "669",
    "707", "714", "747", "760", "805", "818", "820", "831", "858", "909",
    "916", "925", "949", "951",
    // Colorado
    "303", "719", "720", "970", "983",
    // Connecticut
    "203", "475", "860", "959",
    // Delaware
    "302",
    // District of Columbia
    "202", "771",
    // Florida
    "239", "305", "321", "324", "352", "386", "407", "448", "561", "645",
    "689", "727", "754", "786", "813", "850", "863", "904", "941", "954",
    // Georgia
    "229", "404", "470", "478", "678", "706", "762", "770", "912", "943",
    // Idaho
    "208", "986",
    // Illinois
    "217", "224", "309", "312", "331", "447", "630", "708", "773", "815",
    "847", "861", "872",
    // Indiana
    "219", "260", "317", "463", "574", "765",
    // Iowa
    "319", "515", "563", "641", "712",
    // Kansas
    "316", "620", "785", "913",
    // Kentucky
    "270", "364", "502", "606", "859",
    // Louisiana
    "225", "318", "337", "457", "504", "985",
    // Maine
    "207",
    // Maryland
    "227", "240", "301", "410", "443", "667",
    // Massachusetts
    "339", "351", "413", "508", "617", "774", "781", "857", "978",
    // Michigan
    "231", "248", "269", "313", "517", "586", "616", "679", "734", "810",
    "906", "947", "989",
    // Minnesota
    "218", "320", "507", "612", "651", "763", "952",
    // Mississippi
    "228", "601", "662", "769",
    // Missouri
    "235", "314", "417", "557", "573", "636", "660", "816",
    // Montana
    "406",
    // Nebraska
    "308", "402", "531",
    // Nevada
    "702", "725", "775",
    // New Hampshire
    "603",
    // New Jersey
    "201", "551", "609", "732", "848", "856", "862", "908", "973",
    // New Mexico
    "505", "575",
    // New York
    "212", "315", "329", "332", "347", "363", "465", "516", "518", "585",
    "607", "631", "646", "680", "716", "718", "845", "914", "917", "929",
    // North Carolina
    "252", "336", "704", "743", "828", "910", "919", "980", "984",
    // North Dakota
    "701",
    // Ohio
    "216", "220", "234", "283", "326", "330", "380", "419", "436", "440",
    "513", "567", "614", "937",
    // Oklahoma
    "405", "572", "580", "918",
    // Oregon
    "458", "503", "541",
    // Pennsylvania
    "215", "223", "267", "272", "412", "445", "484", "570", "610", "717",
    "724", "814", "835", "878",
    // Rhode Island
    "401",
    // South Carolina
    "803", "839", "843", "854", "864",
    // South Dakota
    "605",
    // Tennessee
    "423", "615", "729", "865", "901", "931",
    // Texas
    "210", "214", "254", "281", "325", "346", "361", "409", "430", "432",
    "469", "512", "621", "682", "713", "726", "737", "806", "817", "830",
    "832", "903", "915", "936", "940", "945", "956", "972", "979",
    // Utah
    "385", "435", "801",
    // Vermont
    "802",
    // Virginia
    "276", "434", "540", "571", "703", "757", "804", "826",
    // Washington
    "206", "253", "360", "425", "509", "564",
    // West Virginia
    "304", "681",
    // Wisconsin
    "262", "274", "353", "414", "534", "608", "715", "920",
    // Wyoming
    "307",
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
 * IANA zone identifiers this floor treats as "inside GB" (P-b: GB has one
 * zone, Europe/London -- there is no second UK zone to honour).
 */
const GB_ZONES = Object.freeze(new Set(["Europe/London"]));

/**
 * IANA zone identifiers inside the continental United States (tzdata's own
 * per-state zones for the mainland, EXCLUDING Alaska/Hawaii -- the same
 * "mainland only" scope US_MAINLAND_NANP documents above). A raw contact
 * timezone outside this set can never legitimately describe a US-mainland
 * number, so it must never override the dual-coast default (controller
 * Ruling R5 / review I6).
 */
const US_MAINLAND_ZONES = Object.freeze(
  new Set([
    "America/New_York", "America/Detroit", "America/Kentucky/Louisville",
    "America/Kentucky/Monticello", "America/Indiana/Indianapolis",
    "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Indiana/Marengo",
    "America/Indiana/Petersburg", "America/Indiana/Vevay", "America/Indiana/Tell_City",
    "America/Indiana/Knox", "America/Chicago", "America/Menominee",
    "America/North_Dakota/Center", "America/North_Dakota/New_Salem",
    "America/North_Dakota/Beulah", "America/Denver", "America/Boise",
    "America/Phoenix", "America/Los_Angeles",
  ])
);

/**
 * Does `tz` lie inside `country`'s own floor jurisdiction? A tz that fails
 * this (e.g. a GB number with an America/* contact timezone, or a US number
 * with an Asia/* one) must be IGNORED by `floorFor`, not honoured -- an
 * unvalidated contact/trigger-supplied timezone must never move a statutory
 * floor to a jurisdiction P-b never approved for that number (controller
 * Ruling R5 / review I6).
 * @param {string} tz
 * @param {"US"|"GB"} country
 * @returns {boolean}
 */
function zoneInsideCountry(tz, country) {
  if (country === "GB") return GB_ZONES.has(tz);
  if (country === "US") return US_MAINLAND_ZONES.has(tz);
  const eu = EU_BY_ISO.get(country);
  return !!eu && eu.valid.includes(tz);
}

// ---------------------------------------------------------------------------
// S4-5: the EU floor. ONE strict default for all 27 member states, sized to
// the strictest rule the research found (France, decret 2022-1313, B2C):
// Mon-Fri, 10:00-13:00 and 14:00-20:00 on the contact's local clock, no
// weekends, no nationwide public holidays. It applies to every audience (B2B
// too). Looser national values (IE, ES, IT, NL, PT hours; B2B exemptions) are
// deliberately NOT applied -- docs/outbound-eu-calling-floor.md carries the
// research and the owner/counsel sign-off list.
// ---------------------------------------------------------------------------

/** A day's entry is null (closed), one "HH:MM-HH:MM" string (GB/US rows), or a list of them (EU rows). */
const EU_DAY = Object.freeze(["10:00-13:00", "14:00-20:00"]);
const EU_WINDOWS = Object.freeze({
  mon: EU_DAY, tue: EU_DAY, wed: EU_DAY, thu: EU_DAY, fri: EU_DAY, sat: null, sun: null,
});

/**
 * [ISO, calling code, default zones (ALL must be inside the window when the
 * contact's own zone is unknown), extra valid zones (a contact zone honoured
 * only if it is one of default+extra)].
 * Ceuta/Melilla are Africa/Ceuta (Madrid clock); Aland is Europe/Mariehamn.
 */
const EU_TABLE = [
  ["AT", "43", ["Europe/Vienna"]], ["BE", "32", ["Europe/Brussels"]], ["BG", "359", ["Europe/Sofia"]],
  ["HR", "385", ["Europe/Zagreb"]], ["CY", "357", ["Asia/Nicosia"], ["Asia/Famagusta"]],
  ["CZ", "420", ["Europe/Prague"]], ["DK", "45", ["Europe/Copenhagen"]], ["EE", "372", ["Europe/Tallinn"]],
  ["FI", "358", ["Europe/Helsinki", "Europe/Mariehamn"]], ["FR", "33", ["Europe/Paris"]],
  ["DE", "49", ["Europe/Berlin"], ["Europe/Busingen"]], ["GR", "30", ["Europe/Athens"]],
  ["HU", "36", ["Europe/Budapest"]], ["IE", "353", ["Europe/Dublin"]], ["IT", "39", ["Europe/Rome"]],
  ["LV", "371", ["Europe/Riga"]], ["LT", "370", ["Europe/Vilnius"]], ["LU", "352", ["Europe/Luxembourg"]],
  ["MT", "356", ["Europe/Malta"]], ["NL", "31", ["Europe/Amsterdam"]], ["PL", "48", ["Europe/Warsaw"]],
  ["PT", "351", ["Europe/Lisbon", "Atlantic/Madeira", "Atlantic/Azores"]],
  ["RO", "40", ["Europe/Bucharest"]], ["SK", "421", ["Europe/Bratislava"]], ["SI", "386", ["Europe/Ljubljana"]],
  ["ES", "34", ["Europe/Madrid", "Atlantic/Canary"], ["Africa/Ceuta"]], ["SE", "46", ["Europe/Stockholm"]],
];

/**
 * Calling codes that share leading digits with, or sit next to, a member
 * state's code but are NOT in the EU (or are overseas parts of FR/ES/PT/NL
 * that have their own code). Longest-prefix matching against the union of
 * EU_TABLE and this list is what keeps e.g. +354 (Iceland) from ever reading
 * as anything else. E.164 codes are prefix-free, so this is belt-and-braces
 * documentation as much as logic -- and it is what a later edit to the
 * matcher has to keep passing.
 */
const NON_EU_CODES = Object.freeze([
  "350", "354", "355", "373", "374", "375", "376", "377", "378", "379", "380", "381", "382", "383",
  "387", "389", "423", "298", "299", "262", "590", "594", "596", "508", "599", "297", "689", "687",
]);

const EU_BY_ISO = new Map();
const EU_BY_CODE = new Map();
for (const [iso, code, zones, extra = []] of EU_TABLE) {
  const entry = Object.freeze({ iso, code, zones: Object.freeze(zones), valid: Object.freeze([...zones, ...extra]) });
  EU_BY_ISO.set(iso, entry);
  EU_BY_CODE.set(code, entry);
}
const NON_EU_SET = new Set(NON_EU_CODES);

/** Loose national-number length bounds for a member-state number (digits after the country code). */
const EU_NATIONAL_MIN = 6;
const EU_NATIONAL_MAX = 12;

/**
 * Italian-numbered Vatican (+39 06 698...) and San Marino (+39 0549...)
 * ranges: they are not in the EU and must not get an EU floor. Refused, fail
 * closed; the demand is negligible.
 */
const IT_NUMBERED_NON_EU = /^(06698|0549)/;

/** E.164 number -> EU table entry, or null (not an EU number / not refused-as-malformed). Longest prefix wins. */
function euCountryFor(phone) {
  const m = /^\+(\d{7,15})$/.exec(phone);
  if (!m) return null;
  const digits = m[1];
  for (const len of [3, 2]) {
    const prefix = digits.slice(0, len);
    if (NON_EU_SET.has(prefix)) return null;
    const entry = EU_BY_CODE.get(prefix);
    if (entry) {
      const national = digits.slice(len);
      if (national.length < EU_NATIONAL_MIN || national.length > EU_NATIONAL_MAX) return null;
      if (entry.iso === "IT" && IT_NUMBERED_NON_EU.test(national)) return null;
      return entry;
    }
  }
  return null;
}

// Nationwide public holidays, generated by scripts/outbound/gen-eu-holidays.mjs.
// Loaded once at import time; a missing/corrupt file throws at import (fail
// closed: the EU floor cannot be applied without it). Fixed sets, O(1) lookup.
const EU_HOLIDAY_DATA = JSON.parse(readFileSync(new URL("./euHolidays.json", import.meta.url), "utf8"));
const HOLIDAY_YEARS = Object.freeze({ first: EU_HOLIDAY_DATA.years[0], last: EU_HOLIDAY_DATA.years[1] });
const HOLIDAY_SETS = new Map(Object.entries(EU_HOLIDAY_DATA.holidays).map(([cc, dates]) => [cc, new Set(dates)]));
for (const iso of EU_BY_ISO.keys()) {
  if (!HOLIDAY_SETS.has(iso)) throw new Error(`euHolidays.json has no table for ${iso}`);
}

/** Throttle for the stale-table alert: one error line per (country, year) per minute, not per candidate minute. */
const staleLoggedAt = new Map();
function noteStaleHolidayTable(country, year) {
  const key = `${country}:${year}`;
  const nowMs = Date.now();
  if (nowMs - (staleLoggedAt.get(key) ?? 0) < 60_000) return;
  staleLoggedAt.set(key, nowMs);
  log.error("outbound_holiday_table_stale", { country, year, covered: `${HOLIDAY_YEARS.first}-${HOLIDAY_YEARS.last}` });
}

/**
 * Is local date `ymd` a day this floor bans outright? A floor with no
 * `holidays` (GB, US) bans none. A year outside the generated table is
 * treated as BANNED (never "no holidays") and alerted.
 */
/** "ok" | "holiday" | "stale" for a local date; a floor without `holidays` (GB, US) is always "ok". */
function holidayStatus(floor, { year, month, day }) {
  if (!floor.holidays) return "ok";
  if (year < HOLIDAY_YEARS.first || year > HOLIDAY_YEARS.last) {
    noteStaleHolidayTable(floor.country, year);
    return "stale";
  }
  return floor.holidays.has(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`) ? "holiday" : "ok";
}

/**
 * R-t4-eve: on a weekday whose NEXT local calendar day is a national public
 * holiday, the last range ends at 19:00 instead of 20:00 (the Italian Code of
 * Conduct ends pre-holiday days at 19:00; applied EU-wide in the one default
 * row). The next day's year is checked too: 31 Dec into a year outside the
 * table is refused outright (fail closed), not merely shortened.
 * @returns {boolean} true when this local date/time passes the floor's holiday rules
 */
const EVE_END_MIN = 19 * 60;
function passesHolidayRules(floor, ymd, minutesOfDay) {
  if (!floor.holidays) return true;
  if (holidayStatus(floor, ymd) !== "ok") return false;
  const next = holidayStatus(floor, addCalendarDays(ymd, 1));
  if (next === "stale") return false;
  if (next === "holiday") return minutesOfDay < EVE_END_MIN;
  return true;
}

const rangeCache = new Map();
/** A day entry (null | "HH:MM-HH:MM" | ["HH:MM-HH:MM", ...]) -> [{start,end}] minutes. */
function rangesOf(entry) {
  if (entry === null || entry === undefined) return [];
  const list = Array.isArray(entry) ? entry : [entry];
  return list.map((s) => {
    let r = rangeCache.get(s);
    if (!r) { r = parseWindow(s); rangeCache.set(s, r); }
    return r;
  });
}
const inRanges = (ranges, minutesOfDay) => ranges.some((w) => minutesOfDay >= w.start && minutesOfDay < w.end);

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
 *   caller already substituted in. Ruling R5 (review I6): a timezone that
 *   does NOT lie inside the number's own country is treated the same as no
 *   timezone at all -- an unvalidated tz must never move the floor to a
 *   jurisdiction the number's own country code contradicts.
 * @returns {{country: string, zones: string[], windows: Record<string, string|string[]|null>, holidays?: Set<string>}
 *   | {refused: "no_legal_floor"}} `country` is "GB", "US" or an EU ISO code; `windows` days are one
 *   "HH:MM-HH:MM" string (GB/US) or a list of them (EU), null = closed; `holidays` (EU only) is that country's
 *   set of banned local dates (also drives the pre-holiday 19:00 end, R-t4-eve).
 */
export function floorFor(phoneE164, rawTimezone) {
  const phone = typeof phoneE164 === "string" ? phoneE164 : "";
  const tz = typeof rawTimezone === "string" && rawTimezone.trim() ? rawTimezone.trim() : null;

  if (phone.startsWith("+44")) {
    const zone = tz && zoneInsideCountry(tz, "GB") ? tz : "Europe/London";
    return { country: "GB", zones: [zone], windows: GB_WINDOWS };
  }

  const nanp = /^\+1(\d{3})\d{7}$/.exec(phone);
  if (nanp) {
    const areaCode = nanp[1];
    if (!US_MAINLAND_NANP.has(areaCode)) return { refused: "no_legal_floor" };
    // No owner-approved timezone on file, OR the raw tz does not lie inside
    // the US at all (Ruling R5): BOTH US coasts must clear the floor at once
    // (Ruling S3-7a) -- isInsideFloor (below) requires every listed zone to
    // pass, so listing both here is what enforces "both".
    const zones = tz && zoneInsideCountry(tz, "US") ? [tz] : ["America/New_York", "America/Los_Angeles"];
    return { country: "US", zones, windows: US_WINDOWS };
  }

  // S4-5: the 27 EU member states, one strict default (see EU_WINDOWS).
  const eu = euCountryFor(phone);
  if (eu) {
    // A contact zone INSIDE the country is honoured; otherwise the window must
    // hold in EVERY zone of the country (ES Canary, PT Azores/Madeira, FI Aland).
    const zones = tz && zoneInsideCountry(tz, eu.iso) ? [tz] : [...eu.zones];
    return { country: eu.iso, zones, windows: EU_WINDOWS, holidays: HOLIDAY_SETS.get(eu.iso) };
  }

  // Every other country code: no owner-approved envelope exists (P-b approved
  // US-mainland and UK; S4-5 the EU member states). Fail closed -- never dial
  // under an envelope nobody approved for this jurisdiction.
  return { refused: "no_legal_floor" };
}

/** `date`'s wall-clock reading in `tz`, against one day's entry (string or list of ranges) and the floor's banned dates. */
function isInsideZone(date, floor, tz) {
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(date.getTime(), tz);
  if (!inRanges(rangesOf(floor.windows[shortWeekday]), minutesOfDay)) return false;
  return passesHolidayRules(floor, localDateInZone(date.getTime(), tz), minutesOfDay);
}

/**
 * Is `date` inside the floor? A floor with more than one zone (the US
 * "no timezone on file" case) requires EVERY zone to pass, not any one of
 * them -- named risk 2: applying the rule with only one of the two coasts
 * would silently narrow "both" to "either".
 * @param {Date} date
 * @param {{country: string, zones: string[], windows: Record<string, string|string[]|null>, holidays?: Set<string>}} floor - a
 *   non-refused `floorFor` result
 * @returns {boolean}
 */
export function isInsideFloor(date, floor) {
  return floor.zones.every((tz) => isInsideZone(date, floor, tz));
}

/** Local calendar date (y, m, d) of an instant in a zone (mirrors schedule.js's own private `localDate`). */
function localDateInZone(ms, tz) {
  const parts = Object.fromEntries(
    dateFormatterFor(tz)
      .formatToParts(new Date(ms)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)])
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** The same local date moved by `days` calendar days (DST-safe: calendar arithmetic, not ms). */
function addCalendarDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ---------------------------------------------------------------------------
// I9 (controller ruling, perf): a TIMEZONE-KEYED Intl.DateTimeFormat cache,
// local to this file. Constructing an Intl.DateTimeFormat is the expensive
// part of every zoned conversion lib/capabilities/datetime.js does
// (getTzOffsetMs/zonedWeekdayAndMinutes each build a fresh formatter EVERY
// call); calling .formatToParts()/.format() on an ALREADY-BUILT formatter is
// roughly an order of magnitude cheaper. A single nextLegalOpening search
// calls these primitives dozens of times but only ever sees a HANDFUL of
// distinct timezones (the floor's own zone(s), plus the contact's), so
// caching by timezone alone removes nearly all of the construction cost.
// Deliberately NOT hoisted into datetime.js: that module's functions are
// called all over the codebase for one-off conversions where construction
// cost was never the bottleneck, and this cache's unbounded growth is safe
// only because the key space here (IANA zone strings actually seen by an
// outbound floor/window check) is small and effectively fixed at runtime.
// ---------------------------------------------------------------------------
const dateFormatterCache = new Map();
function dateFormatterFor(tz) {
  let f = dateFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatterCache.set(tz, f);
  }
  return f;
}

const offsetFormatterCache = new Map();
function offsetFormatterFor(tz) {
  let f = offsetFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    offsetFormatterCache.set(tz, f);
  }
  return f;
}

/** lib/capabilities/datetime.js's own getTzOffsetMs, cached by timezone (same algorithm). */
function cachedTzOffsetMs(ms, tz) {
  const parts = {};
  for (const { type, value } of offsetFormatterFor(tz).formatToParts(new Date(ms))) {
    if (type !== "literal") parts[type] = value;
  }
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - ms;
}

/** lib/capabilities/datetime.js's own zonedComponentsToUtcMs, cached by timezone (same algorithm; the two must agree). */
function cachedZonedComponentsToUtcMs({ year, month, day, hour, minute, second }, tz) {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = cachedTzOffsetMs(guessMs, tz);
  let utcMs = guessMs - offset1;
  const offset2 = cachedTzOffsetMs(utcMs, tz);
  if (offset2 !== offset1) utcMs = guessMs - offset2;
  return utcMs;
}

const weekdayFormatterCache = new Map();
function weekdayFormatterFor(tz) {
  let f = weekdayFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
    weekdayFormatterCache.set(tz, f);
  }
  return f;
}

const timeFormatterCache = new Map();
function timeFormatterFor(tz) {
  let f = timeFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" });
    timeFormatterCache.set(tz, f);
  }
  return f;
}

/** lib/capabilities/datetime.js's own zonedWeekdayAndMinutes, cached by timezone (same result, for the same input, always). */
function cachedZonedWeekdayAndMinutes(utcMs, tz) {
  const zoned = new Date(utcMs);
  const shortWeekday = weekdayFormatterFor(tz).format(zoned).slice(0, 3).toLowerCase();
  const parts = {};
  for (const { type, value } of timeFormatterFor(tz).formatToParts(zoned)) {
    if (type !== "literal") parts[type] = value;
  }
  const minutesOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  return { shortWeekday, minutesOfDay };
}

/** isInsideZone (above), using the cached weekday/minutes lookup -- see the I9 cache block's own header. */
function isInsideZoneCached(date, floor, tz) {
  const { shortWeekday, minutesOfDay } = cachedZonedWeekdayAndMinutes(date.getTime(), tz);
  if (!inRanges(rangesOf(floor.windows[shortWeekday]), minutesOfDay)) return false;
  return passesHolidayRules(floor, localDateInZone(date.getTime(), tz), minutesOfDay);
}

/** isInsideFloor (above), using the cached weekday/minutes lookup. */
function isInsideFloorCached(date, floor) {
  return floor.zones.every((tz) => isInsideZoneCached(date, floor, tz));
}

/** isInsideWindow (schedule.js), using the cached weekday/minutes lookup. */
function isInsideCallingWindowCached(date, callingWindow, tz) {
  const { shortWeekday, minutesOfDay } = cachedZonedWeekdayAndMinutes(date.getTime(), tz);
  const w = dayWindow(callingWindow, shortWeekday);
  return !!w && minutesOfDay >= w.start && minutesOfDay < w.end;
}

/** The absolute instant of `minutesOfDay` (0-1439) on local date `ymd`, in `tz`. */
function atZoneMinute(ymd, minutesOfDay, tz) {
  return cachedZonedComponentsToUtcMs({ ...ymd, hour: Math.floor(minutesOfDay / 60), minute: minutesOfDay % 60, second: 0 }, tz);
}

const SHORT_WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * The weekday of a LOCAL calendar date -- a property of the Gregorian
 * calendar date alone, never of a timezone or a time-of-day, so (unlike
 * every other conversion in this file) it needs no Intl call at all. I9
 * (perf): `collectStartBoundaries` calls this once per candidate day
 * instead of round-tripping through `zonedWeekdayAndMinutes` (two more
 * `Intl.DateTimeFormat` constructions on top of `atZoneMinute`'s own two),
 * which is most of what made the per-minute scan this replaces slow enough
 * to matter in the first place.
 * @param {{year:number,month:number,day:number}} ymd
 * @returns {string}
 */
function shortWeekdayOfDate({ year, month, day }) {
  return SHORT_WEEKDAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/**
 * Every "window opens" boundary instant, across every day in `[start, start +
 * (maxDays+2) days]` and every zone that matters (each floor zone, plus the
 * campaign window's own contact zone) -- I9 (review, controller ruling): the
 * AND of several daily on/off windows changes value ONLY at one of these
 * "start" instants (an end instant can only turn a window off, never turn
 * the combined AND on), so scanning candidates drawn from this finite set,
 * rather than every minute in the range, finds the identical first legal
 * instant in O(days) Intl calls instead of O(days * 1440). `+2` days of
 * slack absorbs any single-day local-date shift between zones with
 * different UTC offsets; boundaries past the caller's own `limit` are
 * filtered out by the caller, not here, so the slack cannot manufacture an
 * out-of-range result.
 * @param {number} start - ms, the earliest instant to consider
 * @param {number} maxDays
 * @param {{zones: string[], windows: object, holidays?: Set<string>}} floor
 * @param {object|null} callingWindow
 * @param {string} contactTz
 * @returns {number[]} candidate instants, ms, unsorted, may include duplicates or out-of-range values
 */
function collectStartBoundaries(start, maxDays, floor, callingWindow, contactTz) {
  const dayCount = maxDays + 2;
  const points = [];
  const zones = new Set([...floor.zones, contactTz]);
  for (const tz of zones) {
    const today = localDateInZone(start, tz);
    for (let k = 0; k <= dayCount; k++) {
      const ymd = addCalendarDays(today, k);
      const shortWeekday = shortWeekdayOfDate(ymd);
      if (floor.zones.includes(tz)) {
        // Every range of the day opens a window (EU rows have two: 10:00 and 14:00).
        // A holiday date is not filtered here: the candidate fails isInsideZoneCached.
        for (const fw of rangesOf(floor.windows[shortWeekday])) points.push(atZoneMinute(ymd, fw.start, tz));
      }
      if (tz === contactTz) {
        const cw = dayWindow(callingWindow, shortWeekday);
        if (cw) points.push(atZoneMinute(ymd, cw.start, tz));
      }
    }
  }
  return points;
}

/**
 * The default search bound. 14, not 8 (FINAL FIX WAVE N3): the final review
 * measured a worst gap of 7.958 days (BG, 2030, an evening campaign window
 * 19:00-21:00 across an Easter + May Day run) against the old bound of 8, i.e.
 * under an hour of slack, and a null here closes the outreach for good
 * (`never("no_legal_floor")`). The wider bound costs nothing measurable
 * (tests/outboundEuFloor.test.js keeps a 14-day worst-case search under 20 ms).
 */
export const DEFAULT_MAX_DAYS = 14;

/**
 * The next instant at or after `now` where BOTH the floor (every zone) and
 * the campaign's own calling window (on the contact's resolved clock) are
 * open at once. Bounded -- `maxDays` calendar days -- and FAILS CLOSED: a
 * caller that gets `null` back must treat it as "no legal opening exists",
 * never as "allow" (named risk 1).
 *
 * Boundary-jumping, NOT a per-minute scan (I9, controller ruling: the old
 * per-minute loop blocked the event loop -- 3.4 s measured for an empty
 * floor-intersect-window search, `rr5/probe3.mjs` -- on the SAME Cloud Run
 * service that paces every concurrent call's 20 ms audio, a correctness bug
 * by way of a performance one). `collectStartBoundaries` (above) finds every
 * instant that could be the first legal opening in O(days) Intl calls; this
 * function tests only those candidates, in order, and returns the first that
 * actually satisfies both the floor and the window -- identical results to
 * the old per-minute scan (both operate at whole-minute granularity; see
 * that function's own doc for why checking only "start" instants is
 * sufficient), at roughly 1/1000th the Intl call count.
 *
 * @param {Date} now
 * @param {{zones: string[], windows: object, holidays?: Set<string>}} floor - a
 *   non-refused `floorFor` result
 * @param {object|null} callingWindow - the campaign's own `calling_window`
 * @param {string} contactTz - the contact's RESOLVED timezone (schedule.js's
 *   `contactTimezone()` fallback already applied) -- the same zone the
 *   campaign's own window check already evaluates against
 * @param {{maxDays?: number, stepMs?: number}} [o] - `stepMs` sets only how
 *   far past `now` the search starts (its pre-I9 role as the scan's
 *   increment no longer applies), preserved so an existing caller that never
 *   passed a custom value keeps the exact same "starts at now+60s" behaviour.
 * @returns {Date|null}
 */
export function nextLegalOpening(now, floor, callingWindow, contactTz, { maxDays = DEFAULT_MAX_DAYS, stepMs = 60_000 } = {}) {
  const start = now.getTime() + stepMs;
  const limit = now.getTime() + maxDays * DAY_MS;
  if (start > limit) return null;

  const candidates = collectStartBoundaries(start, maxDays, floor, callingWindow, contactTz);
  candidates.push(start); // the search's own lower bound: may already be inside both windows
  candidates.sort((a, b) => a - b);

  for (const t of candidates) {
    if (t < start || t > limit) continue;
    const candidate = new Date(t);
    // The cached variants (I9 perf block, above) -- provably the same result
    // as the exported isInsideFloor/isInsideCallingWindow for the same
    // input, since they run the identical algorithm over the identical
    // Intl-derived weekday/minutes reading; only the formatter's lifetime
    // differs.
    if (isInsideFloorCached(candidate, floor) && isInsideCallingWindowCached(candidate, callingWindow, contactTz)) {
      return candidate;
    }
  }
  return null;
}
