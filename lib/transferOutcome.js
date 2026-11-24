// transferOutcome.js -- what the caller hears after a transfer's <Dial> ends.
//
// Twilio POSTs the Dial's `action` URL when the dialled leg finishes, with a
// DialCallStatus. "completed" means the staff member ANSWERED and the bridged
// call then ended (or the Dial's timeLimit ran out): the caller has just had a
// real conversation, and playing "leave a message" after it is the defect this
// function exists to prevent. Every other status (busy, no-answer, failed,
// canceled, answered, missing, garbage) means nobody spoke to the caller, so
// they get to leave a message instead of silence.
//
// Pure and import-free so the decision is testable on its own. Designed for the
// warm transfer (first month): "nobody pressed 1" becomes one more returned
// case (e.g. "receptionist"), not a rewrite. No `business` parameter until that
// case needs one.

/**
 * @param {{ DialCallStatus?: unknown, DialBridged?: unknown }|null|undefined} body - the action request's form body
 * @param {{ flagged: true, outcome?: "unscreened"|"accepted"|"not_accepted"|null }|undefined} [screening] - present only for a dial
 *   whose action URL carried the screened flag; outcome is the stored verdict (null: unknown or the read failed)
 * @returns {"hangup"|"message"}
 */
export function transferOutcome(body, screening) {
  // A screened dial reports "completed" even when the whisper leg hung up, so
  // the status alone proves nothing: the caller gets the message unless the
  // bridge happened and nobody is recorded as having declined. With the
  // database down the verdict is unknown and DialBridged decides alone.
  if (screening?.flagged === true && (screening.outcome === "not_accepted" || body?.DialBridged === "false")) {
    return "message";
  }
  if (body?.DialCallStatus === "completed") return "hangup";
  return "message";
}
