/**
 * The per-caller-type path, handed back in the set_call_intent tool reply.
 *
 * The prompt describes the goal for every caller; this note tells the model the
 * short path for the type it has just reported. On Live a tool reply is obeyed
 * at once, in the same turn, where a line elsewhere in the prompt is not, so the
 * path rides there.
 *
 * Described, never scripted: no quoted sentence for the model to recite (the
 * 2026-09-05 tic rule, tests/promptConversationTruth.test.js).
 *
 * Null (no note) for: the healthcare tier (its protocol is unchanged and it gets
 * no path), outbound, a null or unknown type, and a wrong number (the
 * guardrail bullet already says what to do).
 */

import { businessHandlesSellerCalls } from "../sellerCalls.js";
import { confirmStyleOf, spellUpFrontOf, isHealthcareTier, LEAD_LIKE } from "../capabilities/intakeSettings.js";

const TAG = "[not caller speech]";

/** What the end read-back covers, for leads and clients. One place, so the prompt and the note agree. */
export const END_READ_BACK =
  "the surname spelled, the email if given, a number only if it is not the number they are calling from, said digit by digit " +
  "(otherwise say they will be called back on the number they are calling from, and they can give another), " +
  "the preferred time if given, and a one-line reason; then ask whether that is right, and if they correct " +
  "anything, save again with the fix";

/**
 * @param {object} args
 * @param {string|null} args.callerType - the type the model just reported
 * @param {object} args.config - the business config (loadConfig output)
 * @param {boolean} args.callerNumberReal - the caller's number came through (not withheld, not the business's own line)
 * @param {boolean} [args.outbound]
 * @returns {string|null}
 */
export function intakePathNote({ callerType, config, callerNumberReal, outbound } = {}) {
  if (outbound || isHealthcareTier(config) || typeof callerType !== "string") return null;
  const spell = spellUpFrontOf(config);
  const each = confirmStyleOf(config) === "each";
  const numberLine = callerNumberReal
    ? "Do not ask for a number: they will be called back on the number they are calling from."
    : "Their number did not come through, so ask for the best number once.";

  if (callerType === "personal") {
    return [
      `${TAG} This is a personal call.`,
      "Take their first name and their message, nothing more.",
      numberLine,
      spell === "everyone"
        ? "Ask them to spell their name before you save."
        : "Do not ask them to spell anything.",
      "Confirm plainly what you will pass on, with no read-back.",
    ].join(" ");
  }

  if (LEAD_LIKE.has(callerType)) {
    const who = callerType === "existing_customer" ? "an existing client" : "a new enquiry";
    return [
      `${TAG} This is ${who}.`,
      "Take their name and what they want, and save as soon as you have both.",
      numberLine,
      "Then ask this business's own questions, if it has any, one at a time, skipping anything already answered.",
      each
        ? "Confirm each answer briefly as it is given, spelling the surname back from what you heard and saying any number digit by digit; there is no closing recap."
        : `Finish with one read-back: ${END_READ_BACK}.`,
      spell === "no"
        ? "Do not ask them to spell; the " + (each ? "confirmation" : "read-back") + " spells it."
        : "Ask them to spell their surname before you save.",
    ].join(" ");
  }

  if (callerType === "supplier" || callerType === "sales_pitch") {
    return [
      `${TAG} This caller is selling or supplying something.`,
      businessHandlesSellerCalls(config)
        ? "Follow this business's own rule for these calls."
        : "Follow the default for sales calls in your guardrails.",
      spell === "everyone" ? "Ask them to spell their name before you save." : "Do not ask them to spell anything.",
    ].join(" ");
  }

  if (callerType === "other") {
    return `${TAG} It is not clear yet what this call is about. Ask one open question about how you can help, before any detail question.`;
  }

  return null;
}
