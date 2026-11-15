/**
 * The intake settings a business can choose on the messages pack, read through
 * accessors so an unknown or missing value is always the default.
 *
 * The healthcare tier ignores both settings (callers check isHealthcareTier
 * first), so its prompt text stays exactly as it was.
 */

import { capabilityConfig } from "./requirements.js";
import { CALLER_TYPES } from "./customerRequests.js";

export const CONFIRM_STYLES = Object.freeze(["end", "each"]);
export const SPELL_UP_FRONT = Object.freeze(["no", "leads", "everyone"]);

/** The caller types the model may report, plus a wrong number. */
export const INTAKE_CALLER_TYPES = Object.freeze([...CALLER_TYPES, "wrong_number"]);

/** Callers whose message is a lead or an existing client's: the ones worth a spelled read-back. */
export const LEAD_LIKE = Object.freeze(new Set(["new_enquiry", "existing_customer"]));

/** @returns {"end"|"each"} */
export function confirmStyleOf(config) {
  const v = capabilityConfig(config, "messages").confirmStyle;
  return CONFIRM_STYLES.includes(v) ? v : "end";
}

/** @returns {"no"|"leads"|"everyone"} */
export function spellUpFrontOf(config) {
  const v = capabilityConfig(config, "messages").spellUpFront;
  return SPELL_UP_FRONT.includes(v) ? v : "no";
}

/** @returns {boolean} */
export function isHealthcareTier(config) {
  return config?.complianceTier === "hipaa";
}

/**
 * The caller type a message decision uses: a valid type on this save's own
 * arguments, else a valid one the call already reported, else null. Null is
 * read as a new enquiry by the callers below, so a call whose type was never
 * reported still gets the lead treatment.
 * @returns {string|null}
 */
export function intakeTypeFor(args, ctx) {
  const own = args?.caller_type;
  if (typeof own === "string" && INTAKE_CALLER_TYPES.includes(own)) return own;
  const call = ctx?.callerType;
  if (typeof call === "string" && INTAKE_CALLER_TYPES.includes(call)) return call;
  return null;
}

/**
 * Must a message save wait for the caller's spelled name? The healthcare tier
 * keeps its gate as it is (true: the gate itself decides). Otherwise the
 * setting decides, by caller type for "leads".
 * @returns {boolean}
 */
export function messagesSpellingRequired({ config, callerType } = {}) {
  if (isHealthcareTier(config)) return true;
  const v = spellUpFrontOf(config);
  if (v === "everyone") return true;
  if (v === "leads") return LEAD_LIKE.has(callerType ?? "new_enquiry");
  return false;
}
