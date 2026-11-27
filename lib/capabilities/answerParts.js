/**
 * Hammersleys round 6, item 2 (design 2026-11-27). An answer the business says
 * must contain certain parts -- a street pickup needs a house number and a
 * postcode -- is asked for the missing parts once.
 *
 * Pure and offline. Generic: the parts are a fixed vocabulary of detectors;
 * which label needs which parts is the business's `messages.answerParts`
 * setting, e.g. "Pickup: house_number, postcode_uk if street". "if street"
 * limits the rule to answers that look like a street address, so a pub, a
 * station or an airport is never asked (owner R40).
 *
 * The detectors were settled on the owner's round-4/5 test-call pickups plus
 * synthetic variants (spaced, hyphenated and spoken postcodes; a named house;
 * a pub on a street; "Station Road"); see tests/answerParts.test.js.
 */

/** The fixed vocabulary. */
export const PART_NAMES = ["house_number", "postcode_uk", "zip_us", "email", "phone"];

const SPOKEN = {
  house_number: "house number",
  postcode_uk: "postcode",
  zip_us: "ZIP code",
  email: "email address",
  phone: "phone number",
};

/** How the reply names a part to the model. */
export function partSpoken(part) {
  return SPOKEN[part] || String(part);
}

const ENTRY_RE = /^([^:]{1,40}):\s*(.+?)(\s+if\s+street)?\s*$/i;

function parseEntry(entry) {
  if (typeof entry !== "string") return null;
  const m = ENTRY_RE.exec(entry.replace(/\s+/g, " ").trim());
  if (!m) return null;
  const label = m[1].trim();
  const parts = m[2].split(/[\s,]+/).filter(Boolean);
  if (!label || !parts.length || !parts.every((p) => PART_NAMES.includes(p))) return null;
  return { label, parts: [...new Set(parts)], ifStreet: Boolean(m[3]) };
}

/**
 * @param {unknown} list - the setting (the loader keeps a list of short strings)
 * @returns {{label: string, parts: string[], ifStreet: boolean}[]} one rule per parsed entry; bad entries dropped
 */
export function parseAnswerParts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const rule = parseEntry(entry);
    if (rule && !out.some((r) => r.label.toLowerCase() === rule.label.toLowerCase())) out.push(rule);
  }
  return out;
}

/** The entries that do not parse, for render-tenant-prompt's warning. */
export function badAnswerPartsEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => parseEntry(e) === null).map((e) => String(e));
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------
const DIGIT_WORDS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const CARDINALS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
  "sixty", "seventy", "eighty", "ninety", "hundred",
]);
const STREET_WORDS = new Set([
  "street", "road", "lane", "avenue", "close", "way", "drive", "crescent", "place", "gardens", "grove", "hill",
  "court", "terrace", "row", "square", "mews",
]);
/** Abbreviations count only after the first word ("St Mary's" is a saint, "High St" a street). */
const STREET_ABBREVIATIONS = new Set(["st", "rd", "ln", "ave", "dr", "cres", "gdns", "ct", "sq", "pl"]);
/** A word that names a place rather than an address -- unless a street word follows ("Station Road"). */
const PLACE_WORDS = new Set([
  "pub", "inn", "arms", "hotel", "station", "airport", "terminal", "school", "academy", "hospital", "surgery",
  "church", "chapel", "college", "university", "club", "centre", "center", "shop", "store", "supermarket",
  "restaurant", "cafe", "bar", "hall", "farm", "lodge", "manor", "garage",
]);
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/i;
const UK_OUTWARD = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

const tokensOf = (s) =>
  String(s || "")
    .split(/[\s,;/()]+/)
    .map((t) => t.replace(/^[.'"]+|[.'"]+$/g, ""))
    .filter(Boolean);
const wordsOf = (s) =>
  String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);

/** The token span [from, to] that spells a full UK postcode, or null. Short tokens join ("R H 7 6 A U", "RH7 6AU"). */
function ukPostcodeSpan(tokens) {
  const short = tokens.map((t) => {
    const digit = DIGIT_WORDS[t.toLowerCase()];
    const v = digit !== undefined ? String(digit) : t.replace(/[-.]/g, "");
    return /^[A-Za-z0-9]{1,4}$/.test(v) ? v : null;
  });
  for (let i = 0; i < short.length; i++) {
    let joined = "";
    for (let j = i; j < short.length && short[j] !== null; j++) {
      joined += short[j];
      if (joined.length > 8) break;
      if (UK_POSTCODE.test(joined)) return [i, j];
    }
  }
  return null;
}

function hasHouseNumber(answer) {
  const tokens = tokensOf(answer);
  const span = ukPostcodeSpan(tokens);
  const rest = tokens.filter((t, i) => !(span && i >= span[0] && i <= span[1]) && !UK_OUTWARD.test(t));
  if (rest.some((t) => /^\d{1,4}[a-z]?$/i.test(t) || /^\d{1,4}[a-z]?-\d{1,4}[a-z]?$/i.test(t))) return true;
  const first = rest[0]?.toLowerCase().split("-")[0];
  return Boolean(first && CARDINALS.has(first));
}

const DETECTORS = {
  house_number: hasHouseNumber,
  postcode_uk: (a) => ukPostcodeSpan(tokensOf(a)) !== null,
  zip_us: (a) => /(?:^|\D)\d{5}(?:-\d{4})?(?:\D|$)/.test(String(a || "")),
  email: (a) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(String(a || "")) || /\S\s+at\s+\S+\s+dot\s+[a-z]{2,}/i.test(String(a || "")),
  phone: (a) => (String(a || "").match(/\d/g) || []).length >= 10,
};

/** Does the answer contain the part? */
export function hasPart(part, answer) {
  const detect = DETECTORS[part];
  return detect ? detect(answer) : true;
}

/**
 * A street address: a street word, and not a named place. A named place is
 * "The <name>" (unless the name is a street word: "The Street", "The Close"),
 * or a place word that does not name a street ("East Grinstead Station", but
 * not "Station Road").
 */
export function looksLikeStreetAddress(answer) {
  const w = wordsOf(answer);
  const streetAt = (i) => STREET_WORDS.has(w[i]) || (i > 0 && STREET_ABBREVIATIONS.has(w[i]));
  if (!w.some((_, i) => streetAt(i))) return false;
  if (w[0] === "the" && w[1] && !streetAt(1)) return false;
  if (w.some((x, i) => PLACE_WORDS.has(x) && !(w[i + 1] && streetAt(i + 1)))) return false;
  return true;
}

/**
 * @param {{parts: string[], ifStreet: boolean}} rule
 * @param {string} answer
 * @returns {string[]} the rule's parts the answer lacks, in the rule's order
 */
export function missingParts(rule, answer) {
  if (!rule || !Array.isArray(rule.parts)) return [];
  if (rule.ifStreet && !looksLikeStreetAddress(answer)) return [];
  return rule.parts.filter((p) => !hasPart(p, answer));
}

// ---------------------------------------------------------------------------
// The AI's own words
// ---------------------------------------------------------------------------
const NAMED_BY = {
  house_number: /\b(?:house|flat|door|building|apartment)\s+(?:number|no\b)|\b(?:which|what)\s+number\s+(?:is|on|in|at)\b|\bnumber\s+of\s+the\s+(?:house|building)\b/i,
  postcode_uk: /\bpost\s?-?code\b/i,
  zip_us: /\bzip\b/i,
  email: /\be-?mail\b/i,
  phone: /\b(?:phone|mobile|cell|contact|callback)\s+number\b|\bnumber\s+to\s+(?:call|reach)\b/i,
};

/** Do these words (the assistant's) ask for the part? */
export function namesPart(text, part) {
  const re = NAMED_BY[part];
  return Boolean(re && typeof text === "string" && re.test(text));
}

/** The labels' parts still owed, across a call's saves (in memory; parts and labels only, no answers). */
export const PARTS_REPLY_CAP = 3;
const ANCHOR_CHARS = 60;

/**
 * One save's step for the parts owed. Each entry is
 * `{label, owed: string[], closed: string[], replies: number, anchor: string}`:
 * a part is owed until the save carries it, or until the assistant's OWN words
 * after the entry was first listed name it (that is the one ask), or until
 * PARTS_REPLY_CAP replies listed it. A closed part is never owed again, so a
 * caller who does not know it is asked once.
 *
 * @param {object} o
 * @param {{label: string, parts: string[], ifStreet: boolean}[]} o.rules
 * @param {unknown} o.pending - the previous save's entries
 * @param {{label: string, answer: string}[]} o.answers - this save's answers
 * @param {string|undefined} o.said - assistantSaidThisCall (Live); not a string on the cascade
 * @param {string} [o.inTurn] - this turn's words before the save
 * @param {(ruleLabel: string, savedLabel: string) => boolean} o.labelMatch
 * @returns {{pending: object[], asked: number, capped: number}} pending entries whose `owed` is non-empty
 *   are the ones this reply lists (their `replies` already counts it)
 */
export function advanceParts({ rules, pending, answers, said, inTurn = "", labelMatch }) {
  const live = typeof said === "string";
  const entries = (Array.isArray(pending) ? pending : [])
    .filter((e) => e && typeof e.label === "string")
    .map((e) => ({
      label: e.label,
      owed: Array.isArray(e.owed) ? e.owed.filter((p) => PART_NAMES.includes(p)) : [],
      closed: Array.isArray(e.closed) ? e.closed.filter((p) => PART_NAMES.includes(p)) : [],
      replies: Number.isFinite(e.replies) ? e.replies : 0,
      anchor: typeof e.anchor === "string" ? e.anchor : "",
    }));
  const find = (label) => entries.find((e) => e.label.toLowerCase() === label.toLowerCase());
  for (const a of Array.isArray(answers) ? answers : []) {
    if (!a || typeof a.label !== "string" || typeof a.answer !== "string") continue;
    const rule = (rules || []).find((r) => labelMatch(r.label, a.label));
    if (!rule) continue;
    const missing = missingParts(rule, a.answer);
    const entry = find(rule.label);
    if (entry) {
      entry.owed = missing.filter((p) => !entry.closed.includes(p));
    } else if (missing.length) {
      entries.push({ label: rule.label, owed: missing, closed: [], replies: 0, anchor: live ? said.slice(-ANCHOR_CHARS) : "" });
    }
  }
  let asked = 0;
  let capped = 0;
  for (const e of entries) {
    if (!e.owed.length) continue;
    const words = `${live ? textSince(said, e.anchor) : ""} ${typeof inTurn === "string" ? inTurn : ""}`;
    const named = e.owed.filter((p) => namesPart(words, p));
    // The cascade composes its words after the tool reply: one listing reply is the ask.
    const close = !live && e.replies >= 1 ? [...e.owed] : named;
    asked += close.length;
    e.closed.push(...close);
    e.owed = e.owed.filter((p) => !close.includes(p));
    if (e.owed.length && e.replies >= PARTS_REPLY_CAP) {
      e.closed.push(...e.owed);
      e.owed = [];
      capped += 1;
    }
    if (e.owed.length) e.replies += 1;
  }
  return { pending: entries, asked, capped };
}

/**
 * The text after the LAST occurrence of `anchor` -- a search, never a length
 * offset into a capped string (the LVX192 trap). An empty anchor, or one that
 * has rolled out of the cap, gives everything.
 */
export function textSince(said, anchor) {
  if (typeof said !== "string") return "";
  if (typeof anchor !== "string" || !anchor) return said;
  const at = said.lastIndexOf(anchor);
  return at < 0 ? said : said.slice(at + anchor.length);
}
