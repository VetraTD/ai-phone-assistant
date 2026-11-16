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
  return typeof lastUtterance === "string" && DECLINE_RE.test(lastUtterance);
}

/** A caller utterance with at least one real word in it (not "Ah", not noise). */
function isWorded(text) {
  return typeof text === "string" && /\p{L}{2,}/u.test(text);
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

  if (SELLER_TYPES.has(type)) return f.takeIntent === true && f.sellerRule === true;
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
  let text = `In their words: "${words}". They left before the message was finished.`;
  if (!numberReal) text += " Their number was withheld or did not come through.";
  return text;
}
