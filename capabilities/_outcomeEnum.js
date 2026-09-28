// capabilities/_outcomeEnum.js
/**
 * The tier-4 outbound outcome vocabulary, mirrored rather than imported.
 *
 * services/gemini.js's OUTBOUND_OUTCOME_ENUM (the summary model's own guess,
 * spec §11 tier 4) is the canonical list. capabilities/outcome.js cannot
 * import it directly: services/gemini.js imports capabilities/index.js
 * (buildCallTools' collectTools/collectAdapterTools), and capabilities/
 * index.js imports every pack including this one -- a pack importing
 * services/gemini.js back would close that cycle.
 *
 * So this is its own tiny literal, kept in a file of its own so
 * tests/outboundPacks.test.js can pin it equal to OUTBOUND_OUTCOME_ENUM
 * without either module importing the other, plus `wrong_number` -- the one
 * outcome set_call_outcome accepts that the tier-4 summary never guesses,
 * because it is a fact from the call (a suppression the tool itself wrote)
 * rather than a read of the conversation.
 */
export const OUTBOUND_OUTCOME_ENUM_MIRROR = Object.freeze([
  "qualified_no_booking",
  "not_interested",
  "not_a_fit",
  "callback_requested",
  "wrong_person",
  "wrong_number",
  "other",
]);
