/**
 * Round A1 part 4, F-F. How many times ONE assistant turn read a booking back,
 * and whether it named the person.
 *
 * The confirm audit counted read-back TURNS, so call b (CAdefce6ab) read
 * saves_over_one_readback 0 although its caller heard the read-back twice in
 * one turn: the model's own "...booking that now" and the handed sentence,
 * glued by Live with no space -- "...booking that now.Wednesday, October 21 at
 * 10:00 AM...".
 *
 * Counting every read-back SENTENCE was prototyped first and over-counts: on
 * the 434 assistant turns in call-corpus/, 10 say "Friday at 2 PM for Jon.
 * Shall I go ahead with that?" -- one read-back, two matching sentences. The
 * unit is a read-back sentence that NAMES THE SLOT: call b counts 2, each of
 * those 10 counts 1 (the trailing question names no time).
 */
import { readBackMentionsSlot } from "./slotMention.js";

// A period that ends a title or a lone letter ends no sentence: "Dr. Patel",
// "a.m. for", "D. O. D. L. A.", "D.O.D.L.A.". Except a meridiem's last letter,
// which does end one when a capital follows: "at 2 p.m. Is there anything else?"
const TITLE_END = /(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|St|Jr|Sr)\.$/;
const LETTER_END = /(?:^|[\s(.])[A-Za-z]\.$/;
const MERIDIEM_END = /(?:^|[^A-Za-z])[AaPp]\.[Mm]\.$/;

/**
 * Split after . ! ? when a capital follows -- a space is optional, because
 * Live glues one turn's sentences together ("now.Wednesday").
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const s = String(text || "");
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    let j = i + 1;
    while (j < s.length && /["')\]’”]/.test(s[j])) j++;
    let k = j;
    while (k < s.length && /\s/.test(s[k])) k++;
    // A lowercase letter, digit or comma next: the same sentence goes on.
    if (k < s.length && !/[A-Z]/.test(s[k])) continue;
    if (c === ".") {
      const head = s.slice(Math.max(0, i - 6), i + 1);
      if (TITLE_END.test(head)) continue;
      if (LETTER_END.test(head) && !MERIDIEM_END.test(head)) continue;
    }
    const piece = s.slice(start, j).trim();
    if (piece) out.push(piece);
    start = k;
    i = k - 1;
  }
  const tail = s.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

const isReadBack = (sentence, S) =>
  Boolean(S?.readBackStatementRe?.test(sentence) || S?.confirmReadBackRe?.test(sentence));

/**
 * Read-back sentences in `text` that name `slot`.
 *
 * @param {string} text - one assistant turn
 * @param {string} slot - the naive datetime being written
 * @param {object} S - getStrings() for the call
 * @returns {number}
 */
export function slotReadBackCount(text, slot, S) {
  if (!slot) return 0;
  return splitSentences(text).filter((p) => isReadBack(p, S) && readBackMentionsSlot(p, slot)).length;
}

// COUNTING ONLY. The shared spellRequestRe misses "could you PLEASE spell"
// (call b's own ask, and 3 more of the 450 assistant turns on disk, every one
// a real ask). It is not widened here: the reducer's spelling cap reads it,
// and widening a shared fact moves readers nobody listed. Counters read this.
const SPELL_ASK_EXTRA = /\b(?:(?:could|can|would|will)\s+you\s+(?:please\s+|kindly\s+)?spell|please\s+spell)\b/i;

/**
 * Whether `text` asks the caller to spell something (counters only).
 *
 * @param {string} text
 * @param {object} S
 * @returns {boolean}
 */
export function isSpellAsk(text, S) {
  return Boolean(S?.spellRequestRe?.test(text) || SPELL_ASK_EXTRA.test(text));
}

/**
 * A spelling ask that comes AFTER a read-back in the same turn -- call b's
 * "...booking that now.Before I finalize that, could you please spell...".
 * The ask-now rule (F-A) says the ask comes first; this is what it prevents.
 *
 * @param {string} text
 * @param {object} S
 * @returns {boolean}
 */
export function readBackBeforeSpellAsk(text, S) {
  const parts = splitSentences(text);
  const ask = parts.findIndex((p) => isSpellAsk(p, S));
  return ask > 0 && parts.slice(0, ask).some((p) => isReadBack(p, S));
}

/**
 * Whether `text` says the person's first name or surname as a whole word.
 * Owner, 2026-10-16: a name on file is SAID (never spelled), and either half
 * counts as saying it.
 *
 * @param {string} text
 * @param {string|null|undefined} name - the name the write carried
 * @returns {boolean}
 */
export function namesPerson(text, name) {
  const tokens = String(name || "")
    .toLowerCase()
    .match(/\p{L}+(?:['’]\p{L}+)*/gu);
  if (!tokens) return false;
  const wanted = new Set([tokens[0], tokens[tokens.length - 1]].filter((t) => t.length >= 2));
  const words = String(text || "")
    .toLowerCase()
    .match(/\p{L}+(?:['’]\p{L}+)*/gu);
  return Boolean(words?.some((w) => wanted.has(w)));
}
