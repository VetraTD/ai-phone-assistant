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

import { stripMarkerAnywhere } from "../intentMarker.js";
import { bumpCounter } from "./metrics.js";
import { log } from "../logger.js";

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
 * Shared-meridiem time RANGES — "3:00-5:00 PM" / "3:00 to 5:00 PM" -> "3 to
 * 5 PM". Must run BEFORE collapseTopOfTheHour: that rule only fires when a
 * meridiem is directly ADJACENT to a ":00", so in "3:00-5:00 PM" it only
 * ever matches the second time (the one actually touching "PM") and
 * collapses it alone, leaving the first time's ":00" dangling with nothing
 * to collapse it — corrupting "3:00-5:00 PM" into "3:00-5 PM" instead of
 * normalizing the range as a unit. Treating the whole range as one token
 * up front avoids that split entirely.
 *
 * Both dash forms (hyphen and en dash) and the worded "to" are handled.
 * Minutes are preserved per-side where non-zero (e.g. "3:30-5:00 PM" ->
 * "3:30 to 5 PM") — only a genuine ":00" is collapsed, matching the same
 * restraint principle collapseTopOfTheHour applies to a single time. A
 * range with NO meridiem at all (e.g. "9:00 to 5:00") is intentionally left
 * unmatched (the meridiem capture group is mandatory below) — ambiguous,
 * same as a single bare 12-hour time with no marker.
 */
function collapseSharedMeridiemRange(text) {
  return text.replace(
    /\b(\d{1,2}):([0-5]\d)\s*(?:[-–]|\bto\b)\s*(\d{1,2}):([0-5]\d)[ \t]*([AaPp])\.?[Mm]\.?\b/g,
    (_match, h1, mm1, h2, mm2, half) => {
      const period = `${half.toUpperCase()}M`;
      const first = mm1 === "00" ? h1 : `${h1}:${mm1}`;
      const second = mm2 === "00" ? h2 : `${h2}:${mm2}`;
      return `${first} to ${second} ${period}`;
    }
  );
}

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
  return convertBareMilitaryTime(collapseTopOfTheHour(collapseSharedMeridiemRange(text)));
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

// ---------------------------------------------------------------------------
// Emphasis damping — the voice "gets more emotional the longer the call goes,
// sometimes starts yelling".
//
// ElevenLabs reads exclamation marks and ALL-CAPS as emphasis, and nothing
// between the model and the TTS socket removed either: toSpeakable stripped
// emoji and markdown but passed "Great!!!" and "I NEED that" through verbatim.
// At the catalog's stability those land as genuine shouting.
//
// It compounds across a call. Each turn's spoken text is threaded into the NEXT
// turn's TTS as `previous_text` (services/elevenlabs.js) so prosody carries
// over — which means an emphatic turn seeds an emphatic turn, and energy
// ratchets up. Damping here also calms that anchor, because the anchor is the
// post-toSpeakable text.
//
// Acronyms must survive: "PDF", "DOB", "NHS", "AI" are read letter-by-letter by
// the TTS precisely BECAUSE they are capitalized, and the once-per-call name
// spell-back emits single letters. So only runs of 4+ letters are de-shouted
// (acronyms are overwhelmingly 2-3), minus an allowlist of the longer ones that
// show up in this domain, and never anything containing a digit.
// ---------------------------------------------------------------------------

/** Longer acronyms that must not be de-shouted despite being 4+ letters. */
const ACRONYM_ALLOWLIST = new Set([
  "ASAP", "HIPAA", "HVAC", "HTML", "HTTP", "HTTPS", "FAQS", "NHS", "PPO", "HMO",
  "DMCA", "OSHA", "IRS", "DMV", "USA", "NASA", "PDF", "PDFS", "CPAP", "MRI", "CT",
]);

const ALL_CAPS_WORD_RE = /\b[A-Z]{4,}(?:'S)?\b/g;

/**
 * Reduce shouted emphasis to ordinary speech.
 * @param {string} text
 * @returns {string}
 */
export function dampEmphasis(text) {
  // "Great!!!" -> "Great!" -> "Great." A receptionist's warmth should come from
  // word choice and the voice itself, not from punctuation the engine reads as
  // volume. The system prompt also asks the model not to emit these; this is
  // the backstop for when it does anyway.
  let out = text.replace(/!{2,}/g, "!").replace(/!/g, ".");

  out = out.replace(ALL_CAPS_WORD_RE, (word) => {
    const bare = word.endsWith("'S") ? word.slice(0, -2) : word;
    if (ACRONYM_ALLOWLIST.has(bare)) return word;
    const suffix = word.endsWith("'S") ? "'s" : "";
    return bare.charAt(0) + bare.slice(1).toLowerCase() + suffix;
  });

  return out;
}

// ---------------------------------------------------------------------------
// Internal-vocabulary guard.
//
// A caller on a live call heard the assistant say "API" mid-booking. Nothing
// anywhere inspected what the model said before it reached TTS — toSpeakable
// was purely a pronunciation normalizer — so there was no layer that could
// have stopped it.
//
// This is the last line of defence, not the first. The first is that tool text
// is no longer spoken verbatim (services/gemini.js) and that the prompt is
// derived from registered capabilities. This catches what those miss: the
// model improvising a word it was never given, or operator free-text carrying
// one in.
//
// Deliberately narrow. Every entry is a word that has no business in a
// receptionist's speech but plenty of business in a debug log, and each is
// matched only as a WHOLE WORD so ordinary speech survives — "database" goes,
// "data" stays; "endpoint" goes, "end" stays. Words with innocent everyday
// meanings ("function", "error", "schema") are deliberately absent: silently
// mangling "the error was on our side" is its own kind of bad call.
const INTERNAL_TERMS = [
  "api", "apis", "endpoint", "endpoints", "webhook", "webhooks",
  "database", "supabase", "postgres", "sql", "json", "uuid",
  "twilio", "deepgram", "elevenlabs", "gemini",
  "stacktrace", "stack trace", "traceback", "nullpointer", "undefined variable",
  // Named in the prompt's banned-vocabulary bullet but missing here, which an
  // eval run caught: the model refused correctly and still said "our backend
  // systems" out loud. Neither word has an innocent use in a receptionist's
  // speech, so removing them costs nothing — "I can't get into our backend"
  // becomes "I can't get into our", and the sentence tier repairs the rest.
  "backend", "back end", "telephony",
];

const INTERNAL_TERM_RE = new RegExp(`\\b(?:${INTERNAL_TERMS.join("|")})\\b`, "gi");

// "HTTP 502", "status 404", "error code 500" — a status code read to a caller
// is meaningless at best and alarming at worst.
const HTTP_STATUS_RE = /\b(?:HTTP|status(?:\s+code)?|error\s+code)\s+[1-5]\d{2}\b/gi;

// A bare UUID. Appointment ids travel through tool arguments, and the model
// occasionally decides one is worth reciting.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Strip internal implementation vocabulary from text about to be spoken.
 *
 * Removes rather than rewrites: there is no safe generic substitute, and a
 * sentence with a word missing still lands as speech, whereas one with
 * "[redacted]" in it announces the failure to the caller. The counter and log
 * line are how this is noticed — silently scrubbing would hide whether the
 * upstream fixes are actually working.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInternalTerms(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  out = out.replace(UUID_RE, " ");
  out = out.replace(HTTP_STATUS_RE, " ");
  out = out.replace(INTERNAL_TERM_RE, " ");
  if (out === text) return text;
  // Tidy the punctuation the removal orphaned ("the API error" -> "the error",
  // "our API." -> "our.") so what remains still reads as a sentence.
  out = out.replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  bumpCounter("internal_term_leaks");
  // log has no .warn — the codebase's convention for a warning is log.error
  // with severity:"warn" (see lib/voice/session.js's no_business_found).
  log.error("internal_term_stripped", { original: text.slice(0, 200), severity: "warn" });
  return out;
}

// ---------------------------------------------------------------------------
// Structural leak guard.
//
// The word list above is necessary but provably not sufficient. On 2026-08-04,
// after it shipped, a caller heard "default api get caller appointments from
// db": `\bapi\b` cannot match inside `default_api` because `_` is a word
// character, and no hand-maintained list would ever have contained
// `get_caller_appointments_from_db`.
//
// So this matches SHAPES rather than words — the syntax of identifiers, calls,
// paths and structured data — plus the LIVE tool registry passed in by the
// caller. The registry is the part that makes this not-an-enumeration: it
// covers a business's webhook tools and any capability pack added later
// without anyone editing this file.
//
// Response is tiered, because deleting tokens in place produces confident
// garbage. Under the old policy the production leak would have been spoken as
// "default : get caller appointments from db One moment while I check that for
// you." Instead:
//
//   1. Excise the offending SPAN. "default_api:get_…{} One moment while I check
//      that for you." -> "One moment while I check that for you." Nothing lost.
//   2. If what remains is not speakable, replace the whole sentence with the
//      caller-facing fallback — once per utterance, however many sentences
//      leak, because hearing the apology three times says "this is broken".
//   3. The word denylist keeps its in-place deletion, which works for what it
//      was built for: one stray ordinary word in an otherwise good sentence.
// ---------------------------------------------------------------------------

/** snake_case, SCREAMING_SNAKE, and env-var shaped tokens. */
const IDENTIFIER_RE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/;
/** ns:name{...} / ns.name(...) / name(...) — anything shaped like a call. */
const CALL_SHAPE_RE = /\b[A-Za-z][A-Za-z0-9_]*\s*[.:]?\s*[A-Za-z0-9_]*\s*[{(][^{}()]*[})]/;
/** Source paths and file names. */
const PATH_RE = /\b(?:[\w-]+\/)+[\w-]+(?:\.\w+)?\b|\b[\w-]+\.(?:js|ts|json|sql|py)\b/;
/** Stack frames, bare IPs, ports, internal hosts. */
const TRACE_RE = /\bat\s+\w+\s*\([^)]*:\d+:\d+\)|\b\d{1,3}(?:\.\d{1,3}){3}\b|:\d{4,5}\b|\b[\w-]+\.supabase\.co\b/;
/** A quoted JSON key, or a brace blob carrying key:value pairs. */
const JSON_RE = /["']\w+["']\s*:|[{[][^}\]]*\w+\s*:\s*\w+[^}\]]*[}\]]/;

const HIGH_CONFIDENCE = [IDENTIFIER_RE, CALL_SHAPE_RE, PATH_RE, TRACE_RE, JSON_RE];

/**
 * Split into sentences, keeping their terminators so rejoining is lossless.
 *
 * A terminator only counts when whitespace or the end of the string follows it,
 * or "services/tools.js" splits into two fragments and the half carrying the
 * evidence gets judged apart from the half carrying the words.
 */
function splitSentences(text) {
  return text.match(/[\s\S]*?(?:[.!?]+(?=\s|$)|$)/g)?.filter(Boolean) || [text];
}

/**
 * Remove internal implementation detail from text about to be spoken.
 *
 * @param {string} text
 * @param {object} [ctx]
 * @param {string[]} [ctx.toolNames] - LIVE tool declarations for this call
 * @param {string} [ctx.fallback] - localized line to speak in place of a
 *   sentence that cannot be repaired. Passed in rather than imported because
 *   this module is locale-agnostic and getStrings needs the business config.
 * @returns {string}
 */
export function sanitizeOutbound(text, ctx = {}) {
  if (typeof text !== "string" || !text) return text;
  const names = Array.isArray(ctx.toolNames) ? ctx.toolNames.filter(Boolean) : [];
  const fallback = typeof ctx.fallback === "string" && ctx.fallback ? ctx.fallback : "";

  // Tool names, matched literally AND in the spoken form a TTS engine produces
  // from them — "get_caller_appointments_from_db" reads aloud as
  // "get caller appointments from db", which no shape rule would ever catch.
  const registryRes = names.map(
    (n) => new RegExp(`\\b${n.split("_").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_]+")}\\b`, "i")
  );

  const sentences = splitSentences(text);
  let apologised = false;
  let changed = false;
  const kept = [];

  for (const sentence of sentences) {
    // 1. Excise call-shaped spans first — they are the only class with exact
    //    boundaries, so they are the only one that can be removed losslessly.
    let s = sentence.replace(new RegExp(CALL_SHAPE_RE.source, "g"), " ");
    // A namespaced name with no argument block ("default_api:book_appointment").
    s = s.replace(/\bdefault_api\s*[.:]\s*[A-Za-z][A-Za-z0-9_]*/gi, " ");
    if (s !== sentence) changed = true;

    const tripped =
      HIGH_CONFIDENCE.some((re) => re.test(s)) || registryRes.some((re) => re.test(s));
    const residue = s.replace(/[^A-Za-z0-9]+/g, " ").trim();
    const speakable = residue.split(/\s+/).filter(Boolean).length >= 3;

    if (!tripped && speakable) { kept.push(s); continue; }
    if (!tripped && !changed) { kept.push(s); continue; }
    if (!tripped && !speakable) { changed = true; continue; } // excised to nothing

    // 2. Not repairable — drop it, apologising at most once.
    changed = true;
    if (!apologised && fallback) { kept.push(fallback); apologised = true; }
  }

  if (!changed) return text;

  const out = kept.join(" ").replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  bumpCounter("internal_term_leaks");
  log.error("outbound_sanitized", { original: text.slice(0, 200), severity: "warn" });
  // 3. Never hand TTS nothing: silence is the failure this whole change exists
  //    to prevent.
  return out || fallback || "";
}

/**
 * Normalize LLM text for TTS. Never throws — returns the input unchanged
 * (whatever it was) if anything inside fails.
 * @param {string} text
 * @returns {string}
 */
export function toSpeakable(text, ctx) {
  try {
    if (typeof text !== "string") {
      if (text === null || text === undefined) return text;
      text = String(text);
    }
    let out = text;
    // Before stripMarkdown, which would otherwise pull the ** off a decorated
    // marker and leave the marker itself behind. services/gemini.js already
    // removes well-formed markers from the stream; this catches the malformed
    // ones, and a caller hearing one is the only failure of this design that
    // reaches the ear.
    const unmarked = stripMarkerAnywhere(out);
    // Reaching here means the stream-level strip missed one. Repair it, but
    // record it: this is the only failure of the marker design a caller can
    // hear, and it must be visible without someone listening for it.
    if (unmarked !== out) bumpCounter("intent_marker_leaks");
    out = unmarked;
    // Before every pronunciation transform, so both guards match the model's
    // own words rather than something a later expansion invented.
    //
    // Structural first: it excises call-shaped spans losslessly, which leaves
    // the word tier looking at ordinary prose. A caller with no ctx (tests,
    // the text harness) gets exactly the old behavior.
    if (ctx) out = sanitizeOutbound(out, ctx);
    out = stripInternalTerms(out);
    out = stripMarkdown(out);
    // After stripMarkdown so "**REALLY**" is already bare, and before the
    // number/time expansions so it never sees a shape they produced.
    out = dampEmphasis(out);
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
