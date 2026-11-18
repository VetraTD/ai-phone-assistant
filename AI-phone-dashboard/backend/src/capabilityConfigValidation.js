/**
 * Validate capability settings on the way IN.
 *
 * Deliberately stricter than the engine's own loader
 * (lib/capabilities/configSchema.js), and the difference is the point. The
 * loader runs mid-call: it drops a bad value, logs it and carries on, because
 * failing a caller over a malformed setting would be far worse than ignoring
 * one. Here there is a human watching who can fix the mistake, so a bad value
 * is REJECTED and named. Saving something that silently does nothing is how an
 * operator ends up believing they configured a guarantee they did not.
 *
 * Both must agree on shape. The engine is the authority on what is honored, so
 * anything accepted here must survive its loader unchanged.
 */

const MAX_NOTES = 2000;
/** A key becomes part of a tool parameter name, so it has to survive being one. */
const KEY_RE = /^[a-z][a-z0-9_]*$/i;

/**
 * @param {unknown} raw - the submitted `config` object
 * @param {string} capabilityId
 * @param {object} schemas - the generated capability schema export
 * @returns {{config: object, errors: string[]}}
 */
function validateCapabilityConfig(raw, capabilityId, schemas) {
  const errors = [];
  const config = {};

  if (raw === undefined || raw === null) return { config, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { config, errors: ["config must be an object"] };
  }

  const def = schemas.capabilities.find((c) => c.id === capabilityId);
  const schema = def?.configSchema || {};

  if (raw.notes !== undefined && raw.notes !== "") {
    if (typeof raw.notes !== "string") {
      errors.push("Notes must be text");
    } else if (raw.notes.length > MAX_NOTES) {
      // Notes go into the prompt. An unbounded paste crowds out the
      // conversation and pushes the cacheable prefix around.
      errors.push(`Notes must be ${MAX_NOTES} characters or fewer`);
    } else {
      config.notes = raw.notes;
    }
  }

  // What to do when the caller already has an upcoming appointment. Rejected
  // rather than silently dropped, per this file's contract: a value the engine
  // would ignore must not be saved looking as though it took effect. Absence is
  // left as absence — the engine defaults to "confirm" at read time.
  if (raw.existingAppointment !== undefined && raw.existingAppointment !== "") {
    const allowed = schema.existingAppointment?.options || [];
    if (typeof raw.existingAppointment !== "string" || !allowed.includes(raw.existingAppointment)) {
      errors.push("Choose what to do when the caller already has an appointment");
    } else {
      config.existingAppointment = raw.existingAppointment;
    }
  }

  const require = raw.require;
  if (require !== undefined) {
    if (typeof require !== "object" || require === null || Array.isArray(require)) {
      errors.push("Requirements must be an object");
    } else {
      const out = {};

      for (const flag of ["confirmBeforeWrite", "businessHoursOnly"]) {
        if (require[flag] === undefined) continue;
        if (typeof require[flag] !== "boolean") errors.push(`${flag} must be true or false`);
        else if (require[flag]) out[flag] = true;
      }

      const identity = validateIdentity(require.identity, schema, errors);
      if (identity) out.identity = identity;

      if (Object.keys(out).length > 0) config.require = out;
    }
  }

  const availability = validateAvailability(raw.availability, errors);
  if (availability) config.availability = availability;

  return { config, errors };
}

/**
 * Slot availability: appointment length and slot capacity (the built-in calendar
 * always checks — there is no on/off flag). Rejects (and names) bad values; the
 * engine loader's bounds (5–480 minutes, 1–100 per slot) must accept exactly
 * what passes here. A stray `enabled` from an older shape is ignored.
 */
function validateAvailability(raw, errors) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("Availability must be an object");
    return null;
  }

  const out = {};
  const num = (key, min, max, label) => {
    if (raw[key] === undefined) return;
    const v = raw[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${label} must be a whole number between ${min} and ${max}`);
    } else {
      out[key] = v;
    }
  };
  num("length", 5, 480, "Appointment length");
  num("capacity", 1, 100, "Slot capacity");

  return Object.keys(out).length ? out : null;
}

function validateIdentity(raw, schema, errors) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("Identity requirements must be an object");
    return null;
  }

  const out = {};
  const allowedBuiltin = schema?.require?.identity?.builtinOptions || [];

  if (raw.builtin !== undefined) {
    if (!Array.isArray(raw.builtin)) {
      errors.push("Identity fields must be a list");
    } else {
      const unknown = raw.builtin.filter((f) => !allowedBuiltin.includes(f));
      if (unknown.length) errors.push(`Unknown identity field: ${unknown[0]}`);
      else if (raw.builtin.length) out.builtin = raw.builtin;
    }
  }

  if (raw.custom !== undefined) {
    if (!Array.isArray(raw.custom)) {
      errors.push("Custom identity fields must be a list");
      return Object.keys(out).length ? out : null;
    }

    const custom = [];
    const seen = new Set();
    for (const field of raw.custom) {
      if (!field || typeof field !== "object") {
        errors.push("Each custom field must be an object");
        continue;
      }
      const key = typeof field.key === "string" ? field.key.trim() : "";
      if (!key) {
        errors.push("Each custom field needs a key");
        continue;
      }
      if (!KEY_RE.test(key)) {
        errors.push(`"${key}" must start with a letter and contain only letters, numbers and underscores`);
        continue;
      }
      if (seen.has(key)) {
        errors.push(`Duplicate custom field: ${key}`);
        continue;
      }
      seen.add(key);

      if (!field.ask || typeof field.ask !== "string" || !field.ask.trim()) {
        // Without this the receptionist has to invent the wording, and the
        // whole point of the field is that the business chose how to ask.
        errors.push(`"${field.label || key}" needs wording for how to ask the caller`);
        continue;
      }

      if (field.pattern !== undefined && field.pattern !== "") {
        if (typeof field.pattern !== "string" || !isUsableRegex(field.pattern)) {
          errors.push(`The format for "${field.label || key}" is not a valid expression`);
          continue;
        }
      }

      custom.push({
        key,
        label: typeof field.label === "string" && field.label.trim() ? field.label.trim() : key,
        ask: field.ask.trim(),
        ...(field.pattern ? { pattern: field.pattern } : {}),
        // Only collect_only is offered today. Real verification needs the
        // adapter to hold the field and production credentials to test it, and
        // claiming a check that does not happen is worse than an honest one.
        verify: "collect_only",
      });
    }
    if (custom.length) out.custom = custom;
  }

  return Object.keys(out).length ? out : null;
}

function isUsableRegex(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

module.exports = { validateCapabilityConfig };
