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
