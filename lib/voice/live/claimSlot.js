// ---------------------------------------------------------------------------
// Which verified slot did the assistant just name out loud?
//
// LVX114. The assistant said "we're all set for Monday, September 14th, at 1 PM",
// never called book_appointment, and the caller hung up believing in an
// appointment that did not exist. Monday 1 PM WAS real -- a
// check_appointment_availability had returned it minutes earlier, so it was
// sitting in guards.js `verifiedSlots` the whole time. The booking was
// completable in code from evidence already in memory.
//
// This is the half that reads the sentence. It answers one question and
// refuses to answer anything else: of the slots a real availability call
// confirmed, which EXACTLY ONE does this sentence name?
//
// ---------------------------------------------------------------------------
// RENDER, DO NOT PARSE
// ---------------------------------------------------------------------------
//
// There is no spoken-datetime parser here and there must not be one. A parser
// would happily produce a time nobody checked, and the whole safety rule is
// that an auto-completed booking can only ever land on a slot an availability
// tool put on the record. So the candidate set is `verifiedSlots` and nothing
// else: each key is rendered into the things a receptionist could say about it,
// and the sentence is tested against those. A time that was never checked has
// no candidate to match and is structurally unreachable.
//
// slotOfferRe's comment makes the same argument from the other side -- speech
// renders times a dozen ways, so a time parser here would be a false-positive
// generator.
//
// NO TIMEZONE IN THIS FILE. `verifiedSlots` keys are already naive LOCAL wall
// clock at minute precision (guards.js slotKey), so the weekday is pure
// calendar arithmetic on the key and there is no DST boundary to get wrong.
//
// AMBIGUITY IS A REFUSAL. Two candidates, or none, returns null and the caller
// falls to the ladder -- ask the caller once, plainly, then escalate. Guessing
// between two verified slots would write an appointment at a time the caller
// did not hear, which is the defect wearing a different hat.
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Spoken day-of-month ordinals. "September ninth" is verbatim from LVX97. */
const ORDINAL_WORDS = [
  null, "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth",
  "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth",
  "nineteenth", "twentieth", "twenty-?first", "twenty-?second", "twenty-?third",
  "twenty-?fourth", "twenty-?fifth", "twenty-?sixth", "twenty-?seventh",
  "twenty-?eighth", "twenty-?ninth", "thirtieth", "thirty-?first",
];

const HOUR_WORDS = [
  null, "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve",
];

// A spoken meridiem. "at one in the afternoon" carries no "p.m." anywhere and
// is exactly how LVX97's fabricated consultation was confirmed.
const PM_PHRASES = "in the afternoon|in the evening|at night|this afternoon|this evening";
const AM_PHRASES = "in the morning|this morning";

/**
 * Split a verifiedSlots key into everything a sentence could name it by.
 *
 * @param {string} key - "YYYY-MM-DDTHH:MM", naive local
 */
export function slotParts(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour24 = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour24 > 23) return null;
  return {
    key,
    year,
    month,
    day,
    hour24,
    minute,
    weekday: WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()],
    monthName: MONTHS[month - 1],
    hour12: hour24 % 12 || 12,
    meridiem: hour24 < 12 ? "am" : "pm",
  };
}

/**
 * Remove clock expressions so a day-number probe cannot match the time.
 *
 * "at 1 PM" must not satisfy the first of the month, and a caller's phone
 * number must not satisfy anything at all.
 */
function stripTimes(text) {
  return text
    .replace(/\b\d{1,2}:\d{2}\s*(?:[ap]\.?\s?m\.?)?/gi, " ")
    .replace(/\b\d{1,2}\s*[ap]\.?\s?m\.?/gi, " ");
}

/**
 * Does the sentence name this slot's day?
 *
 * @returns {string|null} which anchor matched, for logging shape only
 */
function namesDay(text, p, relativeLabel) {
  // A NAMED MONTH IS A VETO, NOT AN ANCHOR.
  //
  // Found by running the fixture table, not by reading it. Without this, two
  // verified slots a month apart on the same day number -- September 14th and
  // October 14th, both 1 PM -- BOTH match "October 14th at 1 PM". The count
  // comes to two and an unambiguous sentence is discarded as ambiguous; drop
  // one of the two and the WRONG one matches alone.
  //
  // Only ever a veto. Plenty of real claims name a weekday and no month at all
  // ("You're all set for Wednesday at one"), so requiring a month would throw
  // away the phrasings this exists to catch.
  const named = MONTHS.filter((m) => new RegExp(`\\b${m}\\b`, "i").test(text));
  if (named.length > 0 && !named.includes(p.monthName)) return null;

  if (new RegExp(`\\b${p.weekday}\\b`, "i").test(text)) return "weekday";

  const dayText = stripTimes(text);
  if (new RegExp(`\\b${p.day}(?:st|nd|rd|th)?\\b`).test(dayText)) return "daynum";

  const word = ORDINAL_WORDS[p.day];
  if (word && new RegExp(`\\b${word}\\b`, "i").test(text)) return "ordinal";

  if (relativeLabel && new RegExp(`\\b${relativeLabel}\\b`, "i").test(text)) return "relative";

  return null;
}

/**
 * Does the sentence name this slot's time?
 *
 * A meridiem is NOT required. "You're all set for Wednesday at one" is a real
 * phrasing (LVX94) and carries none -- so a bare hour counts, and the
 * exactly-one rule in matchClaimSlot is what keeps that safe: a bare hour that
 * could mean two verified slots matches neither.
 *
 * @returns {string|null} which form matched, for logging shape only
 */
function namesTime(text, p) {
  const h = p.hour12;
  const hw = HOUR_WORDS[h];
  const mm = String(p.minute).padStart(2, "0");
  const merid = p.meridiem === "pm" ? "p\\.?\\s?m\\.?" : "a\\.?\\s?m\\.?";
  const meridPhrase = p.meridiem === "pm" ? PM_PHRASES : AM_PHRASES;

  // A SLOT WITH MINUTES MUST HAVE THEM SAID. "4" cannot reach 4:30, because
  // 4:00 and 4:30 are different appointments and the caller heard one of them.
  if (p.minute !== 0) {
    if (new RegExp(`\\b${h}:${mm}\\b`).test(text)) return "hhmm";
    if (new RegExp(`\\b${h}\\s+${mm}\\s*(?:${merid})`, "i").test(text)) return "hhmm_spoken";
    if (hw && new RegExp(`\\b${hw}\\s+(?:${mm}|thirty|fifteen|forty-?five)\\b`, "i").test(text)) {
      return "hhmm_words";
    }
    return null;
  }

  // Noon and midnight are said with no digits at all.
  if (p.hour24 === 12 && /\b(?:noon|midday|mid-day)\b/i.test(text)) return "noon";
  if (p.hour24 === 0 && /\bmidnight\b/i.test(text)) return "midnight";

  if (new RegExp(`\\b${h}(?::00)?\\s*(?:${merid})`, "i").test(text)) return "digit_merid";
  if (hw && new RegExp(`\\b${hw}\\s*(?:o'?clock\\s*)?(?:${merid}|${meridPhrase})`, "i").test(text)) {
    return "word_merid";
  }

  // A BARE HOUR IS ONLY BARE IF NOTHING AFTER IT CONTRADICTS THE SLOT.
  //
  // Two things can, and both were found by running real sentences rather than
  // by reading this:
  //
  //   A MERIDIEM.  "at 1 AM" used to match the 1 PM slot. Nothing consumed the
  //                "AM", so a sentence that explicitly disagrees with the slot
  //                read as one that merely omitted the meridiem. Twelve hours
  //                wrong, on the field the caller cares most about.
  //
  //   MINUTES.     Found on the call of 2026-09-11, and it survived the fix
  //                above because every fixture in the table used a colon. The
  //                transcript renders half past four as "4 30pm" -- NO COLON --
  //                so `at 4` matched with " 30pm" left over. The 4:00 and the
  //                4:30 slot BOTH matched, the sentence was declared ambiguous,
  //                the booking that already existed was reported unverified,
  //                and the assistant told the caller it had not gone through.
  //
  // The minute guard is `\d{2}`, not `\d{1,2}`: a bare hour followed by a
  // one-digit number is not a time ("at 4, 5 of us"), and widening it would
  // start refusing hours that really are bare.
  const noMerid =
    `(?!\\s*(?:o'?clock\\s*)?(?:[ap]\\.?\\s?m\\.?|${PM_PHRASES}|${AM_PHRASES}))` +
    `(?!\\s*[:.]?\\s*\\d{2}(?!\\d))`;
  if (new RegExp(`\\bat\\s+${h}(?::00)?\\b${noMerid}`, "i").test(text)) return "bare_digit";
  if (hw && new RegExp(`\\bat\\s+${hw}\\b${noMerid}`, "i").test(text)) return "bare_word";

  return null;
}

/**
 * The one verified slot this sentence names, or null.
 *
 * @param {string} text - the matched CLAIM SPAN, not the whole turn. Bounded by
 *   the claim regex, so a long turn cannot drag unrelated dates in.
 * @param {Iterable<string>} slotKeys - guards.js verifiedSlots
 * @param {object} [opts]
 * @param {(key: string) => ("today"|"tomorrow"|null)} [opts.relativeLabelFor]
 *   "9 AM tomorrow" (LVX113) names its day without a weekday or a number.
 * @returns {string|null} the slot key, or null for zero or several
 */
export function matchClaimSlot(text, slotKeys, opts = {}) {
  const sentence = typeof text === "string" ? text : "";
  if (!sentence.trim()) return null;
  const relFor = typeof opts.relativeLabelFor === "function" ? opts.relativeLabelFor : () => null;

  let found = null;
  for (const key of slotKeys || []) {
    const p = slotParts(key);
    if (!p) continue;
    if (!namesDay(sentence, p, relFor(key))) continue;
    if (!namesTime(sentence, p)) continue;
    // Two candidates means the sentence does not identify one. Stop and refuse
    // rather than keep the first: "first wins" would be a coin toss wearing a
    // rule's clothes.
    if (found) return null;
    found = key;
  }
  return found;
}

/**
 * WHICH ACT the claim span named, if it named one at all. LVX114.
 *
 * Paired with matchClaimSlot above and kept in this file for one reason: both
 * answer a question about the SAME bounded span, and both must refuse rather
 * than guess when the span will not support an answer.
 *
 * @param {string} span - the matched claim span
 * @param {Array<{action: string, re: RegExp}>} probes - locale vocabulary
 * @param {Record<string, object>} known - claimActionMap(); an act no pack
 *   declares is not a kind this system can match a write to
 * @returns {string} the action, or "unspecified"
 */
export function classifyClaimAction(span, probes, known) {
  const text = typeof span === "string" ? span : "";
  if (!text.trim()) return "unspecified";

  const hits = [];
  for (const probe of probes || []) {
    if (!probe?.action || !probe.re) continue;
    // An act no pack owns has no tool that could satisfy it, so calling it
    // anything but unspecified would demand a write that can never exist.
    if (known && !known[probe.action]) continue;
    if (probe.re.test(text)) hits.push(probe.action);
  }

  // TWO ACTS IS UNSPECIFIED, NOT THE FIRST ONE. "I've cancelled that and booked
  // you in for Monday" names both; recording it as either demands the wrong
  // write and reports a call that went fine. Falling back to the old any-write
  // rule is the conservative direction -- LVX57: a false alarm teaches the
  // reader to ignore the ledger.
  return hits.length === 1 ? hits[0] : "unspecified";
}

/**
 * The sentence containing a match, bounded at clause-terminal punctuation.
 *
 * THREE DIFFERENT WINDOWS ARE NEEDED and conflating them is a real bug I shipped
 * in the first draft of this file. The claim predicate matches the PREDICATE
 * only -- "we're all set" is the whole of it -- so a span that is right for
 * deciding WHICH ACT was claimed carries no date at all and matched no slot.
 *
 *   the matched span      which act was claimed. Tightest, so "I've cancelled
 *                         that and booked you for Monday" cannot be read as one
 *                         act.
 *   THIS SENTENCE         which slot was named. "we're all set FOR MONDAY,
 *                         SEPTEMBER 14TH, AT 1 PM" -- the time is here and
 *                         nowhere else, and stopping at the full stop is what
 *                         keeps a different date in the next sentence out.
 *   the whole turn        the name, because the read-back is usually its own
 *                         sentence one clause earlier ("Thanks, John. So, we're
 *                         all set..."). See recoverClaimedName.
 *
 * @param {string} text
 * @param {number} index - offset of the match within `text`
 * @returns {string}
 */
export function sentenceAround(text, index) {
  const s = typeof text === "string" ? text : "";
  if (!s) return "";
  const at = Number.isFinite(index) && index >= 0 ? Math.min(index, s.length) : 0;
  let start = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (s[i] === "." || s[i] === "?" || s[i] === "!") {
      start = i + 1;
      break;
    }
  }
  let end = s.length;
  for (let i = at; i < s.length; i += 1) {
    if (s[i] === "." || s[i] === "?" || s[i] === "!") {
      end = i + 1;
      break;
    }
  }
  return s.slice(start, end).trim();
}
