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
 * @param {"unscreened"|"accepted"|"not_accepted"|null} [screening] - how the dial was screened (null: unknown or no database)
 * @returns {"hangup"|"message"}
 */
export function transferOutcome(body, screening) {
  // A screened dial that nobody accepted reports "completed" when the whisper
  // leg hangs up, so the status alone proves nothing: the caller gets the
  // message. An accepted one still needs the bridge to have happened.
  if (screening === "not_accepted") return "message";
  if (screening === "accepted" && body?.DialBridged === "false") return "message";
  if (body?.DialCallStatus === "completed") return "hangup";
  return "message";
}
