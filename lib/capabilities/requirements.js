/**
 * Requirement kinds — the structured half of the hybrid config model.
 *
 * A business configures a capability two ways. Prose `notes` go into the prompt
 * and the model usually follows them. Requirement KINDS are checked here, in
 * code, before a write tool is allowed to run, and a failure returns the model
 * an instruction rather than performing the action.
 *
 * The split is decided by one question: **if the AI ignores this, does someone
 * get hurt, sued, or angry?** Yes means it belongs here. No means it belongs in
 * `notes`, because a prompt line is a request, never a guarantee.
 *
 * KINDS vs VALUES is what stops this becoming a workflow DSL. The kinds below
 * are few and change rarely. Operators supply unlimited VALUES of them — a
 * clinic demanding a "dental number" before it will move an appointment is a
 * new value of `identity`, needing no code at all. Inventing a keyword per
 * customer request would be the same hardcoding trap in a new costume.
 *
 * The kinds:
 *   identity            facts the caller must provide before a write may run
 *   confirmBeforeWrite  an explicit read-back and yes
 *   requiredFields      tool arguments that may not be missing
 *   businessHoursOnly   no writes while the business is closed
 *   adapter             which backend the capability writes to (routing, not a check)
 *   notes               prose; deliberately NOT enforced
 */

import { resolveDayHours } from "../businessHours.js";
import { zonedWeekdayAndMinutes } from "./datetime.js";

/**
 * One capability's per-business configuration.
 *
 * Lives HERE, not in the registry, because a capability pack must never import
 * capabilities/index.js: the registry imports every pack, so a pack importing it
 * back is a cycle whose failure depends on which module loads first. Importing
 * a pack directly (as its unit test does) would evaluate the registry while that
 * pack was still in flight, leaving it `undefined` in the pack list.
 *
 * Always returns an object, so packs and the requirement engine can read
 * `cfg.require` and `cfg.notes` without guarding. An unconfigured business
 * behaves as one with no requirements — enforcement is opt-in, and a missing
 * row must never lock a tenant out of its own capability.
 *
 * @param {object} config - normalised business config from loadConfig
 * @param {string} packId
 * @returns {object}
 */
export function capabilityConfig(config, packId) {
  return config?.capabilities?.[packId] || {};
}

/**
 * Argument name a custom identity field is collected under. Namespaced so an
 * operator-invented key can never collide with a tool's own parameters.
 * @param {string} key
 */
export function identityArgName(key) {
  return `identity_${key}`;
}

/** Argument the model sets to assert the caller explicitly confirmed. */
export const CONFIRMATION_ARG = "caller_confirmed";

/**
 * JSON-schema properties a capability must add to its write tools so the
 * configured requirements are collectable at all.
 *
 * This is the link that makes configuration real: a field the operator adds
 * becomes a tool parameter the model is asked for, and then a check that
 * refuses the write without it. Config alone would just be a prompt hint.
 *
 * @param {object} cfg - capability config
 * @returns {{properties: object, required: string[]}}
 */
export function requirementParams(cfg) {
  const require = cfg?.require || {};
  const properties = {};
  const required = [];

  for (const field of require.identity?.custom || []) {
    if (!field?.key) continue;
    const name = identityArgName(field.key);
    properties[name] = {
      type: "string",
      description:
        `${field.label || field.key}, as given by the caller. ` +
        `Ask for it like this: "${field.ask || `What is your ${field.label || field.key}?`}". ` +
        `Required — the action will be refused without it.`,
    };
    required.push(name);
  }

  if (require.confirmBeforeWrite) {
    properties[CONFIRMATION_ARG] = {
      type: "boolean",
      description:
        "Set true ONLY after you have read the details back to the caller and they " +
        "explicitly confirmed (\"yes\", \"that's right\", \"go ahead\"). Never set it " +
        "pre-emptively — the action is refused without it.",
    };
    required.push(CONFIRMATION_ARG);
  }

  return { properties, required };
}

/**
 * Merge the requirement parameters into a write tool's declaration.
 *
 * Returns the declaration untouched when nothing is configured, so a business
 * with no requirements sees byte-identical tools — which is what lets the golden
 * prompt snapshots keep guarding against accidental drift.
 *
 * @param {object} declaration - a Gemini function declaration
 * @param {object} cfg - capability config
 */
export function withRequirements(declaration, cfg) {
  const { properties, required } = requirementParams(cfg);
  if (Object.keys(properties).length === 0) return declaration;

  return {
    ...declaration,
    parameters: {
      ...declaration.parameters,
      properties: { ...(declaration.parameters?.properties || {}), ...properties },
      required: [...(declaration.parameters?.required || []), ...required],
    },
  };
}

/**
 * Prompt lines describing the configured requirements, so the model knows to
 * collect them rather than discovering it by being refused.
 *
 * Enforcement without instruction still works, but it costs the caller a turn
 * every time — the model tries, gets refused, then asks. Telling it up front is
 * the difference between a receptionist who asks for your date of birth and one
 * who apologises and asks after fumbling.
 *
 * @param {object} cfg
 * @returns {string[]}
 */
export function requirementPromptLines(cfg) {
  const require = cfg?.require || {};
  const lines = [];

  const custom = require.identity?.custom || [];
  for (const field of custom) {
    if (!field?.key) continue;
    lines.push(
      `- Before making any change, you MUST ask for the caller's ${field.label || field.key}. ` +
        `Ask it as: "${field.ask || `What is your ${field.label || field.key}?`}" ` +
        `Pass it as ${identityArgName(field.key)}. Never guess or invent this value.`
    );
  }

  if (require.confirmBeforeWrite) {
    lines.push(
      `- Before making any change, read the details back to the caller and wait for an ` +
        `explicit yes. Only then call the tool, with ${CONFIRMATION_ARG} set to true.`
    );
  }

  return lines;
}

/**
 * Check a tool call against the capability's configured requirements.
 *
 * Fails CLOSED and one reason at a time: the receptionist should ask for the
 * missing thing, not recite a list of everything wrong. The returned message is
 * addressed to the model, not spoken to the caller.
 *
 * @param {object} cfg - capability config
 * @param {object} args - tool arguments
 * @param {object} ctx - turn context (config, businessId, ...)
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkRequirements(cfg, args = {}, ctx = {}) {
  const require = cfg?.require || {};

  for (const name of require.requiredFields || []) {
    if (isBlank(args[name])) {
      return { ok: false, message: `Missing required field: ${name}. Ask the caller for it before trying again.` };
    }
  }

  for (const field of require.identity?.custom || []) {
    if (!field?.key) continue;
    const value = args[identityArgName(field.key)];
    const label = field.label || field.key;

    if (isBlank(value)) {
      return {
        ok: false,
        message:
          `Missing required identity field: ${label}. ` +
          `Ask the caller: "${field.ask || `What is your ${label}?`}" then try again.`,
      };
    }

    if (field.pattern && !matchesPattern(String(value), field.pattern)) {
      return {
        ok: false,
        message:
          `The ${label} the caller gave does not look right. ` +
          `Ask them to repeat it once, then try again. Do not guess it.`,
      };
    }

    // verify: "collect_only" stops here — the value is collected and stored but
    // never compared against a record. That is a speed bump, not a lock, and it
    // is deliberately all this does today: real verification needs the adapter
    // to hold the field (see adapters' verifiableFields) and production
    // credentials to test against.
  }

  if (require.confirmBeforeWrite && args[CONFIRMATION_ARG] !== true) {
    return {
      ok: false,
      message:
        "Read the details back to the caller and get an explicit yes first, then call this " +
        `again with ${CONFIRMATION_ARG} set to true.`,
    };
  }

  if (require.businessHoursOnly) {
    const closed = isClosedNow(ctx?.config);
    if (closed) {
      return {
        ok: false,
        message:
          "The business is closed right now and this action is only allowed during opening " +
          "hours. Offer to take a message instead.",
      };
    }
  }

  return { ok: true };
}

/**
 * Values a capability should persist alongside whatever it writes: the identity
 * proofs the caller gave. Collected but unverified is still worth storing —
 * staff can check it later, which is most of what collect_only buys.
 * @param {object} cfg
 * @param {object} args
 */
export function collectedIdentity(cfg, args = {}) {
  const out = {};
  for (const field of cfg?.require?.identity?.custom || []) {
    if (!field?.key) continue;
    const value = args[identityArgName(field.key)];
    if (!isBlank(value)) out[field.key] = String(value);
  }
  return out;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

/**
 * Operator-supplied patterns are untrusted input. A malformed one must not take
 * down a live call, and it must not silently pass either — an unusable pattern
 * means the field is collected without format checking, which is the same
 * outcome as configuring no pattern at all.
 */
function matchesPattern(value, pattern) {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

/** Is the business closed at this instant? Mirrors gemini.js isBusinessOpen. */
function isClosedNow(config) {
  const hours = config?.businessHours;
  if (!hours) return false; // no hours configured means always available
  const timezone = config.timezone || "America/Chicago";
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(Date.now(), timezone);
  const day = resolveDayHours(hours, shortWeekday);
  if (day.closed) return true;
  if (!day.open || !day.close) return false;
  const [openH, openM] = day.open.split(":").map(Number);
  const [closeH, closeM] = day.close.split(":").map(Number);
  return minutesOfDay < openH * 60 + openM || minutesOfDay >= closeH * 60 + closeM;
}
