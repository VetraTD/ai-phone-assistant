// ---------------------------------------------------------------------------
// The reduced-prompt arm of the LVX23 bisect. NOT a candidate prompt.
//
// The question this exists to answer: the bare spike -- ten-line prompt, no
// tools -- was recorded as "it sounds amazing", and the production surface
// (~17,000-character prompt, ten tools) produced a call with three bookings, a
// cancellation, a mid-booking hang-up and audible confusion. Nothing in the
// commits between them explains it, so the honest hypothesis is the surface
// itself. Two knobs let the same handset move one variable at a time.
//
// ---------------------------------------------------------------------------
// Why this is not the spike's prompt, even though the spike is what sounded
// good
// ---------------------------------------------------------------------------
//
// The spike's said the assistant had NO tools and that "someone will confirm",
// and that wording alone was enough to suppress reading a caller's phone
// number back -- a behaviour production depends on, and one that took a day to
// diagnose (backlog LVX4). Copying it would build a known defect into the
// instrument and then measure it.
//
// It also keeps one guardrail: do not say tool names aloud. Dropping it would
// make this arm more likely to leak on a real caller than the arm it is being
// compared against, which is a bad thing to do deliberately on a live line and
// would measure the LVX21 guard rather than the flow.
//
// Everything else the production prompt carries -- the GUARDRAILS block, the
// knowledge base, the capability matrix, the per-step tail -- is deliberately
// absent. That absence IS the variable.
// ---------------------------------------------------------------------------

/**
 * @param {object} config - normalised business config
 * @returns {string}
 */
export function buildMinimalInstruction(config = {}) {
  const name = config.businessName || "this business";
  const tz = config.timezone || "Europe/London";
  let today = "";
  try {
    today = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date());
  } catch {
    today = new Date().toISOString().slice(0, 10);
  }

  return [
    `You are the receptionist answering the telephone for ${name}.`,
    "",
    `Today is ${today}. The business works in the ${tz} timezone, and every`,
    "time you say out loud is a time in that zone.",
    "",
    "Speak the way a person speaks on a phone call: short sentences, one",
    "question at a time, no lists and no headings.",
    "",
    "You can book, check, move and cancel appointments and take a message,",
    "using the tools you have. Use them rather than guessing, and tell the",
    "caller in plain words what you have done.",
    "",
    "When a caller gives you a name or a phone number, say it back to them so",
    "they can correct it.",
    "",
    "Never say a tool name, a parameter name, or any code out loud.",
    "",
    "When the caller has what they need, say goodbye and end the call.",
  ].join("\n");
}
