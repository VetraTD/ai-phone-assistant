// ---------------------------------------------------------------------------
// speakableText.js — normalizes LLM-generated text into something a TTS
// engine will actually pronounce naturally: strips markdown glyphs the model
// sometimes emits, spaces out phone numbers into speakable groups, expands
// symbols ($, %, &, "and/or"-style slashes) into words, and spells URLs out
// as "example dot com" instead of reading punctuation literally.
//
// Called by lib/voice/session.js on each sentence-batched chunk of streamed
// LLM text before handing it to ttsTurn.write() (see session.js's
// sentence-boundary buffering — batching at the sentence level, rather than
// per-raw-delta, is what keeps every transform below operating on a whole
// token instead of an LLM-delta-boundary split mid $5.50 or mid phone
// number).
//
// Never throws — always returns a string when given one, and returns the
// original input unchanged if anything inside goes wrong (so a normalizer
// bug can never take down a live call's TTS).
// ---------------------------------------------------------------------------

const COMMON_TLDS = new Set([
  "com", "org", "net", "io", "co", "gov", "edu", "info", "biz", "us", "uk", "ca", "app",
]);

// Matches an optional scheme/www prefix + a dot-separated hostname + an
// optional path, e.g. "https://www.example.com/booking" or "example.org".
const URL_TOKEN_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^\s.,!?;:)"']*)?/gi;

// A run of digits with optional -/. separators, anchored on digits at both
// ends so trailing sentence punctuation (e.g. the "." after a phone number)
// is never swallowed.
const PHONE_RUN_RE = /\d[\d\-.]*\d/g;

/** Strip markdown glyphs. Wholesale removal (not paired-regex) so a
 * fragment missing its closing marker (e.g. a sentence-batch chunk that
 * starts a **bold** span the LLM will close in a later chunk) is still
 * handled safely — the stray glyph is dropped rather than left as literal
 * "asterisk" noise or, worse, greedily eating unrelated later text.
 */
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}[ \t]+/gm, "") // headers
    .replace(/[*`]/g, ""); // bold/italic asterisks, inline-code backticks
}

/** Spell recognizable URLs naturally; leave non-URL dotted text alone. */
function spellUrls(text) {
  return text.replace(URL_TOKEN_RE, (match, hostPart) => {
    const withoutScheme = hostPart.replace(/^https?:\/\//i, "");
    const host = withoutScheme.replace(/^www\./i, "");
    const labels = host.split(".");
    const tld = (labels[labels.length - 1] || "").toLowerCase();
    if (!COMMON_TLDS.has(tld)) return match; // not a recognized URL — leave untouched
    return labels.join(" dot ");
  });
}

/**
 * "5551234567" -> "555 123 4567" (10-digit 3-3-4).
 *
 * An 11-digit run starting with 1 is a US/Canada number carrying its country
 * code (the E.164 form every number in the database is stored in). Drop the
 * leading 1 and group the rest — blindly chunking by 3s turned
 * "+18175803291" into "181 758 032 91", which a TTS engine reads as an
 * unintelligible mumble rather than a phone number.
 */
function groupPhoneDigits(digits) {
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length === 10) {
    return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }
  const groups = [];
  for (let i = 0; i < local.length; i += 3) groups.push(local.slice(i, i + 3));
  return groups.join(" ");
}

/**
 * Space out 10+ digit runs (phone numbers); leave shorter digit runs alone.
 * A leading "+" is consumed along with the run so the spoken form is
 * "817 580 3291", not "+817 580 3291" — PHONE_RUN_RE itself only matches
 * digits, so the sign has to be handled here.
 */
function spacePhoneNumbers(text) {
  return text.replace(/\+?\d[\d\-.]*\d/g, (match) => {
    const digits = match.replace(/[^\d]/g, "");
    if (digits.length < 10) return match;
    return groupPhoneDigits(digits);
  });
}

/** $N / $N.NN, &, % -> words. Decimal case must run before the whole-dollar
 * case so "$5.50" isn't first collapsed by the simpler $N pattern. */
function expandSymbols(text) {
  return text
    .replace(/\$(\d+)\.(\d{2})\b/g, "$1 dollars $2")
    .replace(/\$(\d+)\b/g, "$1 dollars")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent");
}

/** "his/her" -> "his or her" — word/word pairs only (URLs are already
 * resolved by spellUrls before this runs, so their slashes are gone). */
function expandSlashPairs(text) {
  return text.replace(/\b([a-z]+)\/([a-z]+)\b/gi, "$1 or $2");
}

/** Drop emoji / other non-speakable pictographic symbols. */
function stripEmoji(text) {
  return text.replace(/\p{Extended_Pictographic}/gu, "");
}

// ---------------------------------------------------------------------------
// Abbreviation expansion — single source. Previously lived in lib/twiml.js
// (used only by the Google SSML path via buildSayContent); now lives here so
// BOTH the ElevenLabs path (via toSpeakable, below) and the Google fallback
// path (buildSayContent still imports this) expand the same way. Calling it
// twice in a row is a safe no-op (see the idempotence note on toSpeakable),
// so buildSayContent does not need to know whether the text it receives has
// already been through toSpeakable() once.
//
// Context sensitivity: none. "St." always expands to "Saint" — there is no
// Street-vs-Saint disambiguation (e.g. "Main St. Suite 5" becomes "Main
// Saint Suite 5", which is wrong for the Street sense). This is the exact
// heuristic (or lack of one) the original lib/twiml.js implementation had;
// ported as-is rather than inventing new disambiguation logic.
// ---------------------------------------------------------------------------

/**
 * Expand common abbreviations so TTS reads them naturally, e.g.
 * "Dr. Smith" -> "Doctor Smith" (avoids TTS reading "Dr." as "drive").
 * Each rule only fires when followed by whitespace + a capital letter (the
 * start of the name/word it precedes) — an abbreviation with nothing
 * capitalized after it (e.g. trailing at the end of a sentence) is left
 * untouched, matching the original implementation's behavior.
 * @param {string} text
 * @returns {string}
 */
export function expandAbbreviations(text) {
  if (!text || typeof text !== "string") return text || "";
  return text
    .replace(/\bDr\.\s+([A-Z])/g, "Doctor $1")
    .replace(/\bMr\.\s+([A-Z])/g, "Mister $1")
    .replace(/\bMrs\.\s+([A-Z])/g, "Missus $1")
    .replace(/\bMs\.\s+([A-Z])/g, "Ms $1")
    .replace(/\bSt\.\s+([A-Z])/g, "Saint $1")
    .replace(/\bAve\.\s+([A-Z])/g, "Avenue $1")
    .replace(/\bBlvd\.\s+([A-Z])/g, "Boulevard $1")
    .replace(/\bRd\.\s+([A-Z])/g, "Road $1")
    .replace(/\bSte\.\s+([A-Z])/g, "Suite $1")
    .replace(/\bApt\.\s+([A-Z])/g, "Apartment $1");
}

// ---------------------------------------------------------------------------
// Times — drop a redundant ":00" from an explicit 12-hour time, and convert
// an unambiguous bare 24-hour time into 12-hour form. Anything TTS already
// reads fine (":30" minutes, an ordinary 12-hour hour with no minutes) is
// left alone — restraint principle: only normalize what's demonstrably
// mispronounced.
// ---------------------------------------------------------------------------

/**
 * "3:00 PM" / "3:00pm" -> "3 PM". Only the ":00" case is collapsed —
 * "3:30 PM" is untouched (TTS reads that fine as-is). Meridiem casing is
 * normalized to upper "AM"/"PM" as part of the same rule.
 */
function collapseTopOfTheHour(text) {
  return text.replace(/\b(\d{1,2}):00[ \t]*([AaPp])\.?[Mm]\.?\b/g, (_match, hour, half) => {
    return `${hour} ${half.toUpperCase()}M`;
  });
}

/**
 * Bare 24-hour time ("15:00", "15:30") -> 12-hour form ("3 PM", "3:30 PM").
 * Only fires for hours that are unambiguously 24-hour notation (13-23, or
 * midnight "00") — an hour of 1-12 with no AM/PM marker (e.g. "9:00") is
 * ambiguous (could be a 24-hour "09:00" or just an already-fine 12-hour
 * time) and is deliberately left alone rather than guessed at.
 *
 * The negative lookahead skips anything collapseTopOfTheHour already
 * normalized (or any other H:MM already carrying an AM/PM marker), and the
 * \b anchors keep this from ever matching a fragment of a larger digit run
 * (a date, a phone number, ...) — see spacePhoneNumbers, which runs before
 * this in toSpeakable and has already consumed real phone numbers.
 */
function convertBareMilitaryTime(text) {
  return text.replace(/\b(\d{1,2}):([0-5]\d)\b(?!\s*[AaPp]\.?[Mm]\.?)/g, (match, hh, mm) => {
    const hour = parseInt(hh, 10);
    if (hour > 23) return match; // not a valid 24-hour hour — leave alone
    if (hour !== 0 && hour < 13) return match; // ambiguous 12-hour-range hour, no marker — leave alone
    const period = hour >= 12 ? "PM" : "AM";
    let hour12 = hour % 12;
    if (hour12 === 0) hour12 = 12;
    return mm === "00" ? `${hour12} ${period}` : `${hour12}:${mm} ${period}`;
  });
}

function normalizeTimes(text) {
  return convertBareMilitaryTime(collapseTopOfTheHour(text));
}

// ---------------------------------------------------------------------------
// Numeric dates — "7/30" -> "July 30", "07/30/2026" -> "July 30, 2026".
// US-market reading: this repo only ever serves US businesses, so a numeric
// date is interpreted M/D(/YYYY), not D/M. "July 30" and "July 30th" already
// read fine and are never touched (this rule only matches digit/digit).
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Month 1-12, day 1-31, optional /YYYY. Bounding both halves is also what
// keeps this from firing on an unrelated digit/digit fraction whose first
// number isn't a plausible month (e.g. "13/5" — no month 13, left alone).
const NUMERIC_DATE_RE = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(?:\/(\d{4}))?\b/g;

function expandNumericDates(text) {
  return text.replace(NUMERIC_DATE_RE, (_match, month, day, year) => {
    const monthName = MONTH_NAMES[parseInt(month, 10) - 1];
    const dayNum = parseInt(day, 10);
    return year ? `${monthName} ${dayNum}, ${year}` : `${monthName} ${dayNum}`;
  });
}

// ---------------------------------------------------------------------------
// Number ranges — "9-5" / "9–5" (en dash) -> "9 to 5". Some TTS engines read
// a bare digit-hyphen-digit as subtraction ("nine minus five"); "to" is
// unambiguous. Bounded to 0-24 on both sides (an hours-of-day-shaped range)
// so this doesn't touch an arbitrary numeric difference like "20-30 people".
// Deliberately NOT restricted to literal open/close hours: something like
// "10-15 minutes" also reads better as "10 to 15 minutes" than "ten minus
// fifteen minutes", and the same small-integer-range shape covers it.
// ---------------------------------------------------------------------------

const HOUR_RANGE_RE = /\b([0-9]|1[0-9]|2[0-4])[-–]([0-9]|1[0-9]|2[0-4])\b/g;

function expandHourRanges(text) {
  return text.replace(HOUR_RANGE_RE, "$1 to $2");
}

// ---------------------------------------------------------------------------
// "o'clock" — the reported mispronunciation is the LLM emitting a
// typographic apostrophe (’) rather than the plain word being wrong, so the
// word itself is always kept; only the glyph is normalized to ASCII. Scoped
// narrowly to this one word (not a blanket curly-quote-to-straight-quote
// pass over the whole sentence) — other apostrophes elsewhere (e.g. in
// "it's") are left exactly as the LLM wrote them.
// ---------------------------------------------------------------------------

function normalizeOclock(text) {
  return text.replace(/\bo['’]?clock\b/gi, "o'clock");
}

/**
 * Normalize LLM text for TTS. Never throws — returns the input unchanged
 * (whatever it was) if anything inside fails.
 * @param {string} text
 * @returns {string}
 */
export function toSpeakable(text) {
  try {
    if (typeof text !== "string") {
      if (text === null || text === undefined) return text;
      text = String(text);
    }
    let out = text;
    out = stripMarkdown(out);
    out = spellUrls(out);
    out = spacePhoneNumbers(out);
    out = expandAbbreviations(out);
    out = normalizeTimes(out);
    out = expandNumericDates(out);
    out = expandHourRanges(out);
    out = normalizeOclock(out);
    out = expandSymbols(out);
    out = expandSlashPairs(out);
    out = stripEmoji(out);
    out = out.replace(/\s+/g, " ").trim();
    return out;
  } catch {
    return text;
  }
}
