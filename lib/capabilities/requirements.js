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
 * Built-in identity fields — the fixed set an operator ticks in the dashboard
 * (Full name, Date of birth, Calling-from-number), as opposed to `custom`
 * fields they invent. `require.identity.builtin` was stored but honoured
 * nowhere; these specs are what wire it into tool params, prompt lines and the
 * pre-write check, so ticking a box actually changes a call.
 *
 * Two shapes:
 *   - COLLECTED fields (name/dob/callback_number) become a tool parameter. They
 *     REUSE a parameter the tool already carries when one exists (`paramAliases`)
 *     so the model is never asked for the same thing twice, and add a namespaced
 *     `fallbackArg` only when it does not (e.g. book_appointment has no dob).
 *   - VERIFIED fields (phone_on_file) are never a model parameter. They are
 *     proven by trusted call metadata (the number the caller is calling FROM) or
 *     by an adapter's own ownership check, so on the internal change tools —
 *     which already prove ownership — the check is skipped (`selfVerifiedTools`).
 */
const BUILTIN_IDENTITY = {
  name: {
    label: "full name",
    paramAliases: ["client_name", "caller_name"],
    fallbackArg: "identity_name",
  },
  dob: {
    label: "date of birth",
    paramAliases: ["caller_dob"],
    fallbackArg: "identity_dob",
  },
  callback_number: {
    label: "callback number",
    paramAliases: ["callback_number"],
    fallbackArg: "identity_callback_number",
  },
  phone_on_file: {
    label: "phone number on file",
    // No model parameter: proven by ctx.callerPhone, or by the adapter's
    // ownership check on the internal change tools (skipped there).
    verifiedOnly: true,
    selfVerifiedTools: ["cancel_appointment_db", "reschedule_appointment_db"],
    satisfiedBy: (args, ctx) =>
      !isBlank(ctx?.callerPhone) ||
      ["callback_number", "identity_callback_number"].some((n) => !isBlank(args?.[n])),
  },
};

/** The arg names a collected builtin field may arrive under, aliases first. */
function collectedArgNames(spec) {
  return [...(spec.paramAliases || []), spec.fallbackArg].filter(Boolean);
}

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
/**
 * Parameters contributed by the configured BUILT-IN identity fields, deciding
 * reuse-vs-add against the declaration the tool already has: a builtin whose
 * value the tool already collects (e.g. `client_name`) is only marked required;
 * one it does not (e.g. `dob` on book_appointment) adds a namespaced parameter.
 *
 * @param {object} declaration - the tool's Gemini function declaration
 * @param {object} cfg - capability config
 * @returns {{properties: object, required: string[]}}
 */
function builtinParamsFor(declaration, cfg) {
  const keys = cfg?.require?.identity?.builtin || [];
  const existing = declaration?.parameters?.properties || {};
  const properties = {};
  const required = [];

  for (const key of keys) {
    const spec = BUILTIN_IDENTITY[key];
    if (!spec || spec.verifiedOnly) continue; // phone_on_file adds no parameter

    const alias = (spec.paramAliases || []).find((a) => a in existing);
    if (alias) {
      required.push(alias); // reuse the param the tool already has
      continue;
    }
    properties[spec.fallbackArg] = {
      type: "string",
      description:
        `${spec.label}, as given by the caller. ` +
        `Required — the action will be refused without it.`,
    };
    required.push(spec.fallbackArg);
  }

  return { properties, required };
}

export function withRequirements(declaration, cfg) {
  const custom = requirementParams(cfg);
  const builtin = builtinParamsFor(declaration, cfg);

  const properties = { ...custom.properties, ...builtin.properties };
  const required = [...custom.required, ...builtin.required];
  if (Object.keys(properties).length === 0 && required.length === 0) return declaration;

  return {
    ...declaration,
    parameters: {
      ...declaration.parameters,
      properties: { ...(declaration.parameters?.properties || {}), ...properties },
      // Set dedups a reused alias that the tool already lists as required.
      required: [...new Set([...(declaration.parameters?.required || []), ...required])],
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

  for (const key of require.identity?.builtin || []) {
    const spec = BUILTIN_IDENTITY[key];
    if (!spec) continue;
    if (key === "phone_on_file") {
      lines.push(
        `- Only book or change an appointment for a record that matches the number the caller ` +
          `is calling from. If they are calling from a different number, take a callback number ` +
          `instead of proceeding.`
      );
    } else {
      lines.push(
        `- Before booking or changing an appointment, you MUST ask for the caller's ${spec.label}. ` +
          `Never guess or invent this value.`
      );
    }
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
 * The operator's prose `notes` for a capability, as prompt line(s). Guidance,
 * not an enforced rule — this is exactly the free-text half of the hybrid config
 * model, and it was being stored and never shown to the model. Bounded to 2000
 * chars at validation (configSchema.js), so it is safe to inline.
 *
 * @param {object} cfg - capability config
 * @returns {string[]}
 */
export function notesPromptLines(cfg) {
  const n = typeof cfg?.notes === "string" ? cfg.notes.trim() : "";
  return n ? [n] : [];
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

  for (const key of require.identity?.builtin || []) {
    const spec = BUILTIN_IDENTITY[key];
    if (!spec) continue;
    // Skip a field the tool already proves in code (e.g. phone_on_file on the
    // internal change tools, whose ownership check is the real gate).
    if (spec.selfVerifiedTools?.includes(ctx?.toolName)) continue;

    const satisfied = spec.satisfiedBy
      ? spec.satisfiedBy(args, ctx)
      : collectedArgNames(spec).some((n) => !isBlank(args[n]));
    if (!satisfied) {
      return {
        ok: false,
        message: spec.verifiedOnly
          ? `We can only proceed for a record matching the caller's number. Ask for a callback ` +
            `number and note it, then try again.`
          : `Missing required identity detail: ${spec.label}. Ask the caller for it, then try again.`,
      };
    }
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

/**
 * Is the business closed at this instant? Mirrors gemini.js isBusinessOpen.
 * Exported so the prompt can steer the model away from a booking flow that the
 * businessHoursOnly requirement would only refuse at the final tool call.
 * @param {object} config
 * @param {number} [nowMs] - instant to test; defaults to now.
 */
export function isClosedNow(config, nowMs = Date.now()) {
  const hours = config?.businessHours;
  if (!hours) return false; // no hours configured means always available
  const timezone = config.timezone || "America/Chicago";
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(nowMs, timezone);
  const day = resolveDayHours(hours, shortWeekday);
  if (day.closed) return true;
  if (!day.open || !day.close) return false;
  const [openH, openM] = day.open.split(":").map(Number);
  const [closeH, closeM] = day.close.split(":").map(Number);
  return minutesOfDay < openH * 60 + openM || minutesOfDay >= closeH * 60 + closeM;
}
