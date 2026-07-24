/**
 * Capability config validation.
 *
 * Every pack declares a `configSchema` describing the knobs an operator may
 * turn. It does two jobs: it validates what is loaded from
 * business_capabilities, and — later — it is what a dashboard renders to draw
 * the settings screen, so a new capability's settings appear without anyone
 * hand-writing a React component.
 *
 * The schema vocabulary is deliberately tiny (choice, multi, toggle, text,
 * longtext, identityFields) because it has to be renderable, not expressive.
 * Anything that needs more expressiveness than this belongs in the prose
 * `notes` field, which is exactly what that field is for.
 *
 * Validation NEVER throws and never rejects a whole config: a bad value is
 * dropped and logged, and the rest is kept. This runs while a call is being
 * set up. A caller must not hear silence because someone typed a bad regex
 * into a settings box.
 */

import { log } from "../logger.js";

/**
 * Validate and normalise one capability's config against its pack's schema.
 *
 * @param {object} raw - the `config` jsonb column
 * @param {object} pack - the owning capability pack
 * @param {string} [businessId] - for log context only
 * @returns {object} a config safe to hand to the pack
 */
export function validateCapabilityConfig(raw, pack, businessId) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  const schema = pack?.configSchema || {};
  const drop = (field, reason) =>
    log.error("capability_config_invalid", {
      businessId,
      capability: pack?.id,
      field,
      reason,
      severity: "warn",
    });

  if (raw.notes !== undefined) {
    if (typeof raw.notes === "string") {
      // Bounded for the same reason custom_instructions is: prose goes into the
      // prompt, and an unbounded paste would push the cacheable prefix around
      // and crowd out the conversation.
      out.notes = raw.notes.slice(0, 2000);
    } else {
      drop("notes", "not a string");
    }
  }

  if (raw.adapter !== undefined) {
    const allowed = schema.adapter?.options;
    if (typeof raw.adapter !== "string") {
      drop("adapter", "not a string");
    } else if (Array.isArray(allowed) && !allowed.includes(raw.adapter)) {
      // Routing a capability at a backend that does not exist would fail at the
      // worst moment — mid-call, after the caller has given their details.
      drop("adapter", `not one of ${allowed.join(", ")}`);
    } else {
      out.adapter = raw.adapter;
    }
  }

  const require = validateRequire(raw.require, drop);
  if (Object.keys(require).length > 0) out.require = require;

  const availability = validateAvailability(raw.availability, drop);
  if (Object.keys(availability).length > 0) out.availability = availability;

  return out;
}

/**
 * Availability config: the two numbers that define a slot (length, capacity).
 * There is no on/off flag — the built-in calendar always checks. Defaults are
 * NEVER written here (read-time `?? 30`, `?? 1` supplies them), so absence stays
 * absence. A stray `enabled` from an older shape is simply ignored.
 */
function validateAvailability(raw, drop) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  const num = (key, min, max) => {
    if (raw[key] === undefined) return;
    const v = raw[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) out[key] = v;
    else drop(`availability.${key}`, `not an integer in ${min}–${max}`);
  };
  num("length", 5, 480);
  num("capacity", 1, 100);

  return out;
}

function validateRequire(raw, drop) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  if (raw.confirmBeforeWrite !== undefined) {
    if (typeof raw.confirmBeforeWrite === "boolean") out.confirmBeforeWrite = raw.confirmBeforeWrite;
    else drop("require.confirmBeforeWrite", "not a boolean");
  }

  if (raw.businessHoursOnly !== undefined) {
    if (typeof raw.businessHoursOnly === "boolean") out.businessHoursOnly = raw.businessHoursOnly;
    else drop("require.businessHoursOnly", "not a boolean");
  }

  if (raw.requiredFields !== undefined) {
    if (Array.isArray(raw.requiredFields)) {
      out.requiredFields = raw.requiredFields.filter((f) => typeof f === "string" && f.trim());
    } else {
      drop("require.requiredFields", "not an array");
    }
  }

  const identity = validateIdentity(raw.identity, drop);
  if (Object.keys(identity).length > 0) out.identity = identity;

  return out;
}

function validateIdentity(raw, drop) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  if (Array.isArray(raw.builtin)) {
    out.builtin = raw.builtin.filter((f) => typeof f === "string" && f.trim());
  }

  if (raw.custom !== undefined) {
    if (!Array.isArray(raw.custom)) {
      drop("require.identity.custom", "not an array");
      return out;
    }

    const custom = [];
    const seen = new Set();
    for (const field of raw.custom) {
      if (!field || typeof field !== "object" || typeof field.key !== "string" || !field.key.trim()) {
        drop("require.identity.custom", "entry has no key");
        continue;
      }
      const key = field.key.trim();
      if (!/^[a-z][a-z0-9_]*$/i.test(key)) {
        // The key becomes part of a tool parameter name, so it has to survive
        // being one.
        drop(`require.identity.custom.${key}`, "key must be alphanumeric/underscore");
        continue;
      }
      if (seen.has(key)) {
        drop(`require.identity.custom.${key}`, "duplicate key");
        continue;
      }
      seen.add(key);

      if (typeof field.pattern === "string" && field.pattern.length > MAX_PATTERN_LEN) {
        // A pattern is a regex SOURCE, so — unlike label/ask — it cannot be
        // safely sliced: cutting mid-escape (`\d` → `\`) or mid-group would
        // silently produce a different or broken regex. Reject an overlong
        // pattern outright, keeping the field unchecked, rather than corrupting
        // it. (label/ask are plain prose, sliced in cleanField.)
        drop(`require.identity.custom.${key}.pattern`, `exceeds ${MAX_PATTERN_LEN} characters`);
        custom.push(cleanField(field, key, null));
        continue;
      }

      if (field.pattern !== undefined && !isUsableRegex(field.pattern)) {
        // Kept, minus the pattern: the field is still collected, just not
        // format-checked. Dropping the whole field would quietly remove a
        // requirement the operator asked for.
        drop(`require.identity.custom.${key}.pattern`, "not a valid regular expression");
        custom.push(cleanField(field, key, null));
        continue;
      }

      custom.push(cleanField(field, key, field.pattern ?? null));
    }
    if (custom.length > 0) out.custom = custom;
  }

  return out;
}

// Length caps for custom identity fields. label and ask are plain prose, so
// they are silently SLICED (same treatment as `notes` above) — they flow into
// guardrail bullets + tool param descriptions (prefix bloat) and `ask` is spoken
// verbatim, so both must be bounded at injection. pattern is a regex source and
// is REJECTED rather than sliced (see validateIdentity), because slicing could
// corrupt the expression.
const MAX_LABEL_LEN = 100;
const MAX_ASK_LEN = 300;
const MAX_PATTERN_LEN = 200;

function cleanField(field, key, pattern) {
  const verify = field.verify;
  return {
    key,
    label:
      typeof field.label === "string" && field.label.trim()
        ? field.label.trim().slice(0, MAX_LABEL_LEN)
        : key,
    ask:
      typeof field.ask === "string" && field.ask.trim()
        ? field.ask.trim().slice(0, MAX_ASK_LEN)
        : `What is your ${key}?`,
    ...(pattern ? { pattern } : {}),
    // Anything other than a recognised verify mode degrades to collect_only.
    // Failing towards the WEAKER check is right here: the alternative is
    // claiming a verification the backend may not be able to perform, and a
    // guarantee that is not real is worse than an honest speed bump.
    verify: verify && typeof verify === "object" && verify.adapter_field ? verify : "collect_only",
  };
}

function isUsableRegex(pattern) {
  if (typeof pattern !== "string") return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
