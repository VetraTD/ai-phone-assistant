// ---------------------------------------------------------------------------
// S4-F3: a spelled name or email, read back letter by letter from what was
// SAVED, and whether those letters have already been spoken on this call.
//
// The prompt asks the model to spell a spelled name back, and on the 2026-11
// test calls it did so about half the time. Call 15: the caller spelled
// R-A-M-A-N, the save wrote "Roman", nothing was read back, and the wrong
// surname reached the owner. So capabilities/messages.js hands the model the
// letters of what it just saved, in the save's own reply, and this module is
// the pure half: compose those letters, and decide whether the assistant has
// already said them (a second read-back of letters the caller just heard is
// the repetition the say-it-once round removed).
//
// "Already said" is judged on the assistant's own words, never the caller's:
// a caller spelling R-A-M-A-N proves nothing about what was written down.
//
// Prototyped on the 440 assistant turns in call-corpus/ (2026-09 Live calls):
// 9 spelled letter runs of three or more, all upper case; 6 sit beside the name
// they spell in the same turn, and all 6 read as voiced; the same names with
// one letter changed read as voiced 0 times, and 435 ordinary lower-case words
// taken as names read as voiced 0 times against every turn. Two of the 9 runs are
// comma-separated ("X, X, X"), which strings.js spelledLettersRe does not read,
// so this matcher has its own run reader. No turn spells in lower case (the
// only lower-case single-letter runs are "a.m."/"p.m."); case is ignored here
// anyway, because it costs nothing.
//
// Pure: no state, no logging. Callers pass the caller's name and email to the
// MODEL only (LVX24).
// ---------------------------------------------------------------------------
import { spelled } from "./savePolicy.js";
import { emailsIn } from "./contactReadBack.js";

/** Words that join spelled characters when said aloud ("P-R-I-Y-A dot R-A-M-A-N"). */
const JOINER_WORDS = "dot|underscore|dash|hyphen|apostrophe|plus";
const JOIN = String.raw`(?:\s*[-.,]\s*|(?:\s*,\s*|\s+)(?:${JOINER_WORDS})(?:\s*,\s*|\s+)|\s+)`;
// A single letter or digit: nothing alphanumeric (or an apostrophe, so "I'm"
// and "O'Neill" never yield one) touching it on either side.
const SINGLE = String.raw`[\p{L}\p{N}](?![\p{L}\p{N}'’])`;
const RUN_RE = new RegExp(String.raw`(?<![\p{L}\p{N}'’])${SINGLE}(?:${JOIN}${SINGLE})+`, "giu");
// The run's own characters: single ones only, so a joiner word's letters
// ("dot") are never read as spelled.
const CHAR_RE = new RegExp(String.raw`(?<![\p{L}\p{N}'’])${SINGLE}`, "gu");

/** A separator's kind: the joiner word, else its punctuation, else a space. */
function separatorKind(raw) {
  const word = /[a-z]+/i.exec(raw);
  if (word) return word[0].toLowerCase();
  return raw.replace(/\s+/g, "") || " ";
}

/**
 * Every run of spelled characters in `text`: its characters (upper case) and
 * its segments. A run is cut into segments where the separator changes from
 * the run's usual one, so "P-R-I-Y-A, R-A-M-A-N" is PRIYA + RAMAN while
 * "R, A, M, A, N" stays RAMAN.
 *
 * @returns {Array<{ chars: string, segments: string[] }>}
 */
function spelledRuns(text) {
  const out = [];
  for (const m of String(text || "").matchAll(RUN_RE)) {
    const s = m[0];
    const chars = [];
    const seps = [];
    let last = -1;
    for (const c of s.matchAll(CHAR_RE)) {
      if (last >= 0) seps.push(separatorKind(s.slice(last + 1, c.index)));
      chars.push(c[0].toUpperCase());
      last = c.index;
    }
    const count = new Map();
    for (const k of seps) count.set(k, (count.get(k) || 0) + 1);
    let usual = null;
    for (const [k, n] of count) if (usual === null || n > count.get(usual)) usual = k;
    const segments = [];
    let cur = chars[0];
    seps.forEach((k, i) => {
      if (k === usual) cur += chars[i + 1];
      else {
        segments.push(cur);
        cur = chars[i + 1];
      }
    });
    segments.push(cur);
    out.push({ chars: chars.join(""), segments });
  }
  return out;
}

/** Every join of consecutive segments of every spelled run in `text`. */
function spelledPieces(text) {
  const out = new Set();
  for (const { segments } of spelledRuns(text)) {
    for (let i = 0; i < segments.length; i++) {
      let piece = "";
      for (let j = i; j < segments.length; j++) {
        piece += segments[j];
        out.add(piece);
      }
    }
  }
  return out;
}

const nameWords = (name) => String(name || "").trim().split(/\s+/).filter(Boolean);
const lettersOf = (s) => String(s).replace(/[^\p{L}]/gu, "").toUpperCase();
const alnumOf = (s) => String(s).replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();

/**
 * The saved name, every word spelled -- the rule composeReadBack uses for a
 * booking (lib/voice/savePolicy.js, LVX179 "EVERY name spelled, first name
 * too"): "Priya, P-R-I-Y-A, Raman, R-A-M-A-N". Null when no word has a letter.
 */
export function spelledNameReadBack(name) {
  const words = nameWords(name);
  if (!words.some((w) => spelled(w))) return null;
  return words.map((w) => (spelled(w) ? `${w}, ${spelled(w)}` : w)).join(", ");
}

/**
 * Has the assistant already spoken this name's letters? Yes when its surname
 * (the last word), or the words up to the end of the name run together, is
 * spelled as one piece of a run: "Raman, R-A-M-A-N" in the summary that saved
 * it, or "P-R-I-Y-A R-A-M-A-N" in one breath. A first name spelled alone is not
 * enough, and other letters never are: R-O-M-A-N does not voice "Raman", nor
 * J-O-A-N-N-E "Ann".
 */
export function nameVoicedIn(name, text) {
  const words = nameWords(name);
  const pieces = spelledPieces(text);
  for (let k = 0; k < words.length; k++) {
    const target = lettersOf(words.slice(k).join(""));
    if (target.length >= 2 && pieces.has(target)) return true;
  }
  return false;
}

const LOCAL_SYMBOLS = { ".": "dot", _: "underscore", "-": "dash", "+": "plus" };
const localOf = (email) => email.slice(0, email.lastIndexOf("@"));
const hostOf = (email) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * The email addresses in one saved answer, lower-cased. A written address and
 * a spoken one ("priya dot raman at gmail dot com") both count; a website
 * ("they found us at www.x.com") does not.
 */
export function emailsInAnswer(answer) {
  return emailsIn(answer).filter((e) => !hostOf(e).startsWith("www."));
}

/**
 * The local part letter by letter (digits as digits), the domain said plainly:
 * "priya.raman23@gmail.com" -> "P-R-I-Y-A dot R-A-M-A-N-2-3 at gmail dot com".
 */
export function spelledEmailReadBack(email) {
  const parts = [];
  let group = [];
  const flush = () => {
    if (group.length) parts.push(group.join("-"));
    group = [];
  };
  for (const ch of localOf(email)) {
    if (/[\p{L}\p{N}]/u.test(ch)) group.push(ch.toUpperCase());
    else {
      flush();
      if (LOCAL_SYMBOLS[ch]) parts.push(LOCAL_SYMBOLS[ch]);
    }
  }
  flush();
  return `${parts.join(" ")} at ${hostOf(email).split(".").filter(Boolean).join(" dot ")}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Has the assistant already said this address? The whole address as text
 * (written, or spoken with "at" and "dot"), or its local part spelled as one
 * run with the same domain said in the same text.
 */
export function emailVoicedIn(email, text) {
  const local = alnumOf(localOf(email));
  const host = hostOf(email);
  if (!local || !host) return false;
  for (const said of emailsIn(text)) {
    if (hostOf(said) === host && alnumOf(localOf(said)) === local) return true;
  }
  const written = String(text || "").replace(/\s+dot\s+/gi, ".");
  const domainSaid = new RegExp(String.raw`(?<![\p{L}\p{N}.-])${escapeRe(host)}(?![\p{L}\p{N}-])`, "iu").test(written);
  return domainSaid && spelledRuns(text).some((r) => r.chars === local);
}
