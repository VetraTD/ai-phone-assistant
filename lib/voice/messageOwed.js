// ---------------------------------------------------------------------------
// "A message was owed": the rule behind the after-call message.
//
// A caller leaves, or the receptionist ends the call, before the message is
// saved, and the business owner never hears about them. At the end of a Live
// inbound call this decides whether a message was owed and nothing was saved;
// lib/voice/live/index.js then writes ONE normal message through the existing
// save path, so the owner gets the same normal email. Nothing new is said to
// the caller.
//
// Pure: plain facts in, an answer out. No I/O, no clock, no logging. The
// caller's words stay inside this module's return values and never reach a log.
// ---------------------------------------------------------------------------

import { isHesitationOnly } from "../transcriptUtils.js";

/** Types whose calls are other people's sales calls: only the business's own seller rule lets them leave a message. */
const SELLER_TYPES = new Set(["supplier", "sales_pitch"]);

/** Types for which a stated reason is enough to owe a message. */
const REASON_TYPES = new Set(["new_enquiry", "existing_customer", "personal"]);

const REQUEST_TOOLS = new Set(["record_customer_request", "record_quote_request"]);

/**
 * The caller withdrew the message. Matched against their LAST worded
 * utterance only: "No, that's all, thanks" to the closing "anything else?" is
 * not a decline, "Never mind. I'm done." is.
 */
export const DECLINE_RE = new RegExp(
  [
    String.raw`\bnever\s*mind\b`,
    String.raw`\bforget\s+(?:it|about\s+it|the\s+message)\b`,
    String.raw`\bcancel\s+(?:the|my|that)\s+message\b`,
    String.raw`\bno\s+(?:need\s+(?:for|to\s+leave)\s+a\s+)?message\b`,
    String.raw`\b(?:don'?t|do\s+not)\s+(?:need|want|worry\s+about)\s+(?:to\s+leave\s+)?(?:a|the|any)\s+message\b`,
    String.raw`\b(?:i'?ll|i\s+will|i'?m\s+going\s+to|i'?m\s+gonna)\s+(?:just\s+)?(?:call|ring|phone|try)\s+(?:back|again|later|another\s+time|tomorrow)\b`,
  ].join("|"),
  "i"
);

/**
 * @param {unknown} lastUtterance
 * @returns {boolean}
 */
export function callerDeclined(lastUtterance) {
  return (
    typeof lastUtterance === "string" && DECLINE_RE.test(lastUtterance) && !CONTACT_WANTED_RE.test(lastUtterance)
  );
}

/**
 * B24: a "no need for a message" that in the same breath asks to be called,
 * told or passed on is not a decline: they still want to be reached.
 */
const CONTACT_WANTED_RE = new RegExp(
  [
    String.raw`\b(?:call|ring|phone)\s+me\b`,
    String.raw`\bpass\s+(?:it|that|this)\s+on\b`,
    String.raw`\btell\s+(?:him|her|them)\b`,
    String.raw`\blet\s+(?:him|her|them)\s+know\b`,
    String.raw`\bhear\s+back\b`,
  ].join("|"),
  "i"
);

const PROMISE_RE = new RegExp(
  [
    String.raw`\bpass(?:ing)?\b[^.?!]{0,60}\bon\b`,
    String.raw`\blet\s+(?!me\b|us\b)\w+\s+know\b`,
    String.raw`\bmake\s+sure\s+(?:that\s+)?\w+\s+(?:gets?|knows?|hears?|receives?)\b`,
    String.raw`\b(?:i'?ve|i\s+have)\s+(?:noted|passed|sent|let)\b`,
  ].join("|"),
  "i"
);
const NEGATION_RE =
  /\b(?:can'?t|cannot|can\s+not|won'?t|unable|not\s+able|don'?t|do\s+not|doesn'?t|isn'?t|aren'?t|no\s+longer|not\s+(?:accept|take|pass))\b/i;

/**
 * B20: true when one sentence of the assistant's own words promises to pass
 * something on and is not negated. A seller's pitch is owed to the owner only
 * when the receptionist actually told them it would be passed on.
 * @param {unknown} text
 * @returns {boolean}
 */
export function assistantPromised(text) {
  return String(text || "")
    .split(/(?<=[.?!])\s+/)
    .some((sentence) => PROMISE_RE.test(sentence) && !NEGATION_RE.test(sentence));
}

/** A caller utterance with a real word in it: not noise, not filler alone ("Um", "Hmm"). */
function isWorded(text) {
  return typeof text === "string" && /\p{L}{2,}/u.test(text) && !isHesitationOnly(text);
}

/**
 * Should a message be written for this call?
 *
 * @param {object} facts
 * @param {boolean} facts.outbound
 * @param {boolean} facts.healthcare - healthcare tier (never written here)
 * @param {boolean} facts.hasBusiness
 * @param {boolean} facts.hasCallRow
 * @param {number} facts.messagesRecorded - successful record_customer_request / record_quote_request
 * @param {boolean} facts.hasPendingWrite - a refused write is stashed
 * @param {Iterable<string>} facts.toolsAttempted - refused or completed action tools this call
 * @param {boolean} facts.transferStarted
 * @param {string[]} facts.utterances - the caller's per-turn words
 * @param {string|null} facts.callerType - type at close (a valid pending report beats state)
 * @param {boolean} facts.reasonGiven
 * @param {boolean} facts.takeIntent - take_message / callback_request reported
 * @param {boolean} facts.sellerRule - the business's own seller rule exists
 * @param {boolean} facts.assistantPromised - the receptionist's own words promised to pass it on (B20)
 * @param {boolean} facts.appointmentToolCalled - any appointments-pack tool ran, read or write (B19)
 * @returns {boolean}
 */
export function messageOwed(facts) {
  const f = facts || {};
  if (f.outbound || f.healthcare || !f.hasBusiness || !f.hasCallRow) return false;
  if (Number(f.messagesRecorded) > 0 || f.hasPendingWrite) return false;
  // Mirrors lib/postCallVerify.js `appointmentToolAttempted`.
  if ([...(f.toolsAttempted || [])].some((name) => !REQUEST_TOOLS.has(name))) return false;
  if (f.transferStarted) return false;

  const worded = (f.utterances || []).filter(isWorded);
  if (!worded.length) return false;

  const type = f.callerType ?? null;
  if (type === "wrong_number") return false;
  if (callerDeclined(worded[worded.length - 1])) return false;

  // B19: the appointment flow's own call (a lookup, an availability check) is not a message.
  if (f.appointmentToolCalled === true && f.takeIntent !== true) return false;

  if (SELLER_TYPES.has(type)) return f.takeIntent === true && f.sellerRule === true && f.assistantPromised === true;
  if (type === "other") return f.takeIntent === true;
  if (type === null || REASON_TYPES.has(type)) return f.takeIntent === true || f.reasonGiven === true;
  return false;
}

const WORDS_CAP = 500;

/**
 * The message text for an after-call message, about the caller, never "the
 * assistant". Never logged.
 * @param {{ utterances: string[], numberReal: boolean }} input
 * @returns {string}
 */
export function afterCallMessageText({ utterances, numberReal }) {
  let words = (utterances || [])
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(isWorded)
    .join(" / ");
  if (words.length > WORDS_CAP) {
    const cut = words.slice(0, WORDS_CAP);
    const atWord = words[WORDS_CAP] === " " ? cut : cut.replace(/\s+\S*$/, "");
    words = `${atWord.trimEnd()}…`;
  }
  let text = `In their words: "${words}". No full message was left on the call.`;
  if (!numberReal) text += " Their number was withheld or did not come through.";
  return text;
}
