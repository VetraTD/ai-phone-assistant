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
    out = expandSymbols(out);
    out = expandSlashPairs(out);
    out = stripEmoji(out);
    out = out.replace(/\s+/g, " ").trim();
    return out;
  } catch {
    return text;
  }
}
