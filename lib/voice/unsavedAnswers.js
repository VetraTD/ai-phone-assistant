// lib/voice/unsavedAnswers.js
//
// LVX192. Pure helpers for the save guard: which caller turns carry
// information the business would lose if the call ended now. No state, no I/O,
// and nothing here writes a caller's words anywhere.
import { isHesitationOnly, isAffirmative, callerClosesCall } from "../transcriptUtils.js";
import { READBACK_CHECK_RE, getStrings } from "./strings.js";

// A plain closer: every word is a courtesy or a "nothing more" word. Anything
// with a content word ("no, two passengers") is NOT a closer.
const CLOSER_WORDS = new Set([
  "no", "nope", "nah", "thanks", "thank", "you", "cheers", "ta", "bye", "goodbye",
  "ok", "okay", "cool", "great", "lovely", "perfect", "brilliant", "that's", "thats",
  "that", "is", "all", "it", "everything", "nothing", "else", "much", "very", "so",
  "i'm", "im", "good", "fine", "have", "a", "nice", "day", "take", "care", "thank-you",
  "alright", "too", "mate", "não", "nao", "nein", "it's",
]);
// Agreement words: a closer only beside another courtesy ("yeah, cheers"). Alone
// they answer the question just asked ("anything else?" "yeah" means yes).
const AGREE_WORDS = new Set(["yeah", "yep", "sure", "right"]);
// What an agreement word needs beside it to make a closer ("that's right" has none: it answers).
const STRONG_COURTESY = new Set([
  "thanks", "thank", "cheers", "ta", "bye", "goodbye", "mate", "too", "nope", "nah", "no",
  "nothing", "else", "take", "care", "day", "não", "nao", "nein", "thank-you",
]);
// Sounds a caller makes before the real words. Stripped before every check.
const FILLERS = new Set(["a", "ah", "ahm", "aha", "oh", "uh", "um", "erm", "hmm"]);
const CONTINUATION_RE = /\b(?:but|also|another|and)\b/i;
// Fix round 2. Sounds that say "I'm listening", not an answer ("Mhm.", "Yeah.").
// They carry something to save only as the answer to a yes/no question.
const BACKCHANNEL = new Set([
  "mhm", "mhmm", "mm", "mmm", "mmhmm", "mm-hmm", "mm-hm", "uh-huh", "uhhuh", "huh",
  "yeah", "yep", "yup", "ok", "okay",
]);
// A question that starts with one of these asks for a yes or a no.
const YES_NO_START = new Set([
  "do", "does", "did", "is", "are", "am", "was", "were", "will", "would", "can", "could", "shall",
  "should", "have", "has", "had", "may", "might", "any", "need", "want", "got",
]);
// Words a question may open with before its real first word ("Great, and do you ...?").
const QUESTION_LEAD = new Set([
  "and", "so", "ok", "okay", "great", "lovely", "perfect", "right", "also", "then", "thanks", "thank",
  "you", "brilliant", "alright", "sure", "oh", "now", "fab", "fantastic", "cool",
]);

function wordsOf(text) {
  return text
    .toLowerCase()
    .replace(/[.!,;:…?"“”]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function stripFillers(words) {
  let i = 0;
  while (i < words.length && FILLERS.has(words[i])) i += 1;
  return words.slice(i);
}

// A question that asks the caller to confirm what was just read back.
const READ_BACK_RE =
  /\b(?:is\s+that\s+(?:right|correct|ok|okay|all\s+right)|(?:that|this)\s+(?:right|correct)|did\s+i\s+(?:get|have)\s+that|have\s+i\s+got\s+that)\b|\b(?:right|correct|ok|okay)\s*\?/i;

function isPlainCloser(words, afterAnythingElse) {
  if (words.length === 0) return false;
  let agree = false;
  let strong = false;
  for (const w of words) {
    if (AGREE_WORDS.has(w)) {
      // "Yeah, thanks" answers a yes/no question; it closes only after "anything else?".
      if (!afterAnythingElse) return false;
      agree = true;
    }
    else if (CLOSER_WORDS.has(w)) strong = strong || STRONG_COURTESY.has(w);
    else return false;
  }
  return agree ? strong : true;
}

/** The last sentence of `prevReply` that asks something, or "". */
function lastQuestionOf(prevReply) {
  if (typeof prevReply !== "string") return "";
  const sentences = prevReply.match(/[^.!?]*\?/g);
  return sentences ? sentences[sentences.length - 1].trim() : "";
}

/**
 * Does a bare backchannel answer what was just asked? Only a yes/no question
 * that is not a read-back check and not "anything else?" (a "yeah" there says
 * more is coming; the next turn carries it).
 */
function backchannelAnswers(prevReply, readBackRe, closingRe) {
  const q = lastQuestionOf(prevReply);
  if (!q) return false;
  if ((readBackRe instanceof RegExp ? readBackRe : READ_BACK_RE).test(prevReply)) return false;
  if (/\banything\s+else\b/i.test(q)) return false;
  if (closingRe instanceof RegExp && closingRe.test(q)) return false;
  const words = wordsOf(q);
  let i = 0;
  while (i < words.length && QUESTION_LEAD.has(words[i])) i += 1;
  return YES_NO_START.has(words[i]);
}

/**
 * @param {string} text - the caller's words for one turn
 * @param {string} prevReply - what the assistant said just before
 * @param {RegExp} [readBackRe] - the locale's read-back question test (getStrings(config).confirmReadBackRe);
 *   the built-in default is narrower and English only
 * @param {RegExp} [closingRe] - the locale's closing-courtesy test (closingRegexFor); a short turn
 *   that matches it, with no question, digit or continuation, is a closer
 * @returns {boolean} true when the turn holds something worth saving
 */
export function isInformativeCallerTurn(text, prevReply, readBackRe, closingRe) {
  if (typeof text !== "string") return false;
  // A letter the transcript could not render arrives as "?" inside a word
  // ("Não" -> "N?o"). Read it as the word, not as a question.
  const t = text.trim().replace(/(\p{L})\?(?=\p{L})/gu, "$1");
  if (!t) return false;
  if (isHesitationOnly(t)) return false;
  const words = stripFillers(wordsOf(t));
  if (words.length === 0) return false;
  if (words.every((w) => BACKCHANNEL.has(w))) return backchannelAnswers(prevReply, readBackRe, closingRe);
  const core = words.join(" ");
  const afterAnythingElse = closingRe instanceof RegExp && typeof prevReply === "string" && closingRe.test(prevReply);
  if (isPlainCloser(words, afterAnythingElse) || callerClosesCall(t)) return false;
  if (
    closingRe instanceof RegExp &&
    !t.includes("?") &&
    !/\d/.test(t) &&
    !CONTINUATION_RE.test(t) &&
    words.length <= 4 &&
    closingRe.test(core)
  ) {
    return false;
  }
  if (isAffirmative(t) && typeof prevReply === "string" && (readBackRe instanceof RegExp ? readBackRe : READ_BACK_RE).test(prevReply)) {
    return false;
  }
  return true;
}

/**
 * @param {{index:number, caller:string, prevReply:string, voiced?:boolean}[]} turns
 * @param {number} savedThroughTurn
 * @param {RegExp} [readBackRe]
 * @param {RegExp} [closingRe]
 * @returns {number} informative turns with index > savedThroughTurn. A turn with
 *   no text but voiced speech counts (a misheard answer; costs one re-save).
 */
export function countUnsaved(turns, savedThroughTurn, readBackRe, closingRe) {
  if (!Array.isArray(turns)) return 0;
  const through = Number.isFinite(savedThroughTurn) ? savedThroughTurn : 0;
  let n = 0;
  for (const turn of turns) {
    if (!turn || !(turn.index > through)) continue;
    const text = typeof turn.caller === "string" ? turn.caller.trim() : "";
    if (!text) {
      if (turn.voiced === true) n += 1;
      continue;
    }
    if (isInformativeCallerTurn(text, turn.prevReply, readBackRe, closingRe)) n += 1;
  }
  return n;
}

const readBackReCache = new Map();
/**
 * The question test the engine and the harness pass: the locale's own
 * "does that check a read-back" regex (right?, is that correct?) plus the tag
 * question "OK?". Deliberately NOT the write-order gate's confirmReadBackRe,
 * which also matches offers ("shall I ...", "would you like me to ..."); a yes
 * to an offer is an answer the business needs.
 *
 * @param {string} [lang] - "en" | "es"
 * @returns {RegExp}
 */
export function readBackQuestionRe(lang) {
  const key = lang === "es" ? "es" : "en";
  let re = readBackReCache.get(key);
  if (!re) {
    re = new RegExp(`${READBACK_CHECK_RE[key].source}|\\b(?:ok|okay)\\s*\\?`, "i");
    readBackReCache.set(key, re);
  }
  return re;
}

const closingReCache = new WeakMap();
/**
 * One regex for a locale's closing courtesies (the "anything else?" question and
 * the farewell phrases), from getStrings(config). Null when the locale has none.
 *
 * @param {object} [config] - the business config
 * @returns {RegExp|null}
 */
export function closingRegexFor(config) {
  const strings = getStrings(config);
  if (!strings) return null;
  let re = closingReCache.get(strings);
  if (re === undefined) {
    const parts = [strings.closingTicRe, strings.farewellRe].filter((r) => r instanceof RegExp).map((r) => r.source);
    re = parts.length ? new RegExp(parts.join("|"), "i") : null;
    closingReCache.set(strings, re);
  }
  return re;
}
