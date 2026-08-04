// Validation for PUT /api/business/:id/settings. Each validator takes the
// raw value for its field and returns either { value } (normalized value to
// persist) or { error } (a human-readable message). Field keys here ARE the
// businesses table column names — the settings route uses this 1:1 mapping
// to build a parameterized dynamic UPDATE (see routes/settings.js /
// server.js), so this object's key set doubles as the write whitelist.
// Never add a key here that isn't a real column — the SET clause is built
// directly from these keys.

const { sanitizeString, isValidEmail } = require("./utils");
const {
  MODULE_TASKS,
  ALLOWED_LANGUAGES,
  AFTER_HOURS_POLICIES,
  TRANSFER_POLICIES,
  VOICE_PROVIDERS,
  ELEVENLABS_VOICE_IDS,
  SMS_TEMPLATE_KINDS,
  SMS_TEMPLATE_MAX_LENGTH,
  DAY_KEYS,
  ALLOWED_TIMEZONES,
} = require("./constants");
const { normalizePhoneNumber, stripPhoneFormatting } = require("./phone");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Loose E.164-ish check: optional leading +, 7-20 digits/spaces/()/-/.
const PHONE_RE = /^\+?[0-9()\-.\s]{7,20}$/;

function validateName(value) {
  if (typeof value !== "string") return { error: "must be a string" };
  const s = sanitizeString(value, 200);
  if (!s) return { error: "must be 1-200 characters" };
  return { value: s };
}

function validateTimezone(value) {
  if (typeof value !== "string" || !ALLOWED_TIMEZONES.includes(value)) {
    return { error: `must be one of: ${ALLOWED_TIMEZONES.join(", ")}` };
  }
  return { value };
}

function validateBoundedString(maxLength) {
  return (value) => {
    if (value === null) return { value: "" };
    if (typeof value !== "string") return { error: "must be a string" };
    if (value.length > maxLength) return { error: `must be ${maxLength} characters or fewer` };
    return { value };
  };
}

// For numbers that are SPOKEN to a caller, not dialled by Twilio (main_phone).
// Formatting is stripped so the stored value matches what the engine expects
// (lib/voice/session.js runs it through toSpeakable to read out digit groups),
// but a country code is not required.
function validatePhone(value) {
  if (value === null || value === "") return { value: "" };
  if (typeof value !== "string") return { error: "must be a string" };
  const trimmed = value.trim();
  if (!PHONE_RE.test(trimmed)) return { error: "is not a valid phone number" };
  return { value: stripPhoneFormatting(trimmed) };
}

// For numbers Twilio must DIAL or TEXT (phone_number, transfer_phone_number,
// notification_phone). Twilio requires E.164, so anything else fails silently
// at call time — a transfer that never connects, an SMS that never arrives.
// Reject it here, where the operator can see the error, and never guess a
// country code: guessing is how a UK number silently becomes a US one.
function validateE164Phone(value) {
  if (value === null || value === "") return { value: "" };
  if (typeof value !== "string") return { error: "must be a string" };
  const normalized = normalizePhoneNumber(value);
  if (!normalized) {
    return {
      error:
        "must be in international format, including the country code — for example +442079460958 or +18176011171",
    };
  }
  return { value: normalized };
}

function validateEnum(list) {
  return (value) => {
    if (typeof value !== "string" || !list.includes(value)) {
      return { error: `must be one of: ${list.join(", ")}` };
    }
    return { value };
  };
}

function validateBoolean(value) {
  if (typeof value !== "boolean") return { error: "must be a boolean" };
  return { value };
}

// A day with closed !== true MUST carry valid open/close times — the AI
// (services/gemini.js isBusinessOpen / buildDynamicTail) gates after-hours
// behavior on this field, so a day silently treated as "open all day" (no
// hours) would have the AI telling callers the business is open with no
// actual window. Reject rather than default.
//
// KNOWN LIMITATION (pre-existing, out of scope here): this does not check
// close > open, so an overnight window like {open:"22:00", close:"02:00"}
// validates successfully but isBusinessOpen() reads it as always-closed
// (same-day-window comparison only — see its docstring in
// services/gemini.js). Overnight businesses need dedicated handling that
// doesn't exist yet.
function validateBusinessHours(value) {
  if (value === null) return { value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "must be an object keyed by day (mon..sun)" };
  }
  const unknownKeys = Object.keys(value).filter((k) => !DAY_KEYS.includes(k));
  if (unknownKeys.length) {
    return { error: `has unknown day keys: ${unknownKeys.join(", ")}` };
  }
  const out = {};
  for (const day of DAY_KEYS) {
    const dayVal = value[day];
    if (dayVal === undefined) continue;
    if (typeof dayVal !== "object" || dayVal === null || Array.isArray(dayVal)) {
      return { error: `.${day} must be an object` };
    }
    const closed = dayVal.closed === true;
    if (closed) {
      out[day] = { open: null, close: null, closed: true };
      continue;
    }
    if (!TIME_RE.test(dayVal.open) || !TIME_RE.test(dayVal.close)) {
      return { error: `.${day} requires open and close in HH:MM format unless closed is true` };
    }
    out[day] = { open: dayVal.open, close: dayVal.close, closed: false };
  }
  return { value: out };
}

function validateAllowedTasks(value) {
  if (!Array.isArray(value)) return { error: "must be an array" };
  const invalid = value.filter((t) => !MODULE_TASKS.includes(t));
  if (invalid.length) {
    return {
      error: `contains invalid entries: ${invalid.join(", ")}. Valid module tasks: ${MODULE_TASKS.join(", ")}`,
    };
  }
  return { value: [...new Set(value)] };
}

function validateLanguagesSpoken(value) {
  if (!Array.isArray(value) || !value.length) {
    return { error: "must be a non-empty array" };
  }
  const invalid = value.filter((l) => !ALLOWED_LANGUAGES.includes(l));
  if (invalid.length) {
    return { error: `contains unsupported entries: ${invalid.join(", ")}. Valid: ${ALLOWED_LANGUAGES.join(", ")}` };
  }
  return { value: [...new Set(value)] };
}

function validateVoiceId(value) {
  if (value === null || value === "") return { value: null };
  if (typeof value !== "string" || !ELEVENLABS_VOICE_IDS.includes(value)) {
    return { error: `must be one of: ${ELEVENLABS_VOICE_IDS.join(", ")}` };
  }
  return { value };
}

function validateEmail(value) {
  if (value === null || value === "") return { value: "" };
  if (typeof value !== "string" || !isValidEmail(value)) {
    return { error: "must be a valid email address" };
  }
  return { value: sanitizeString(value, 254) };
}

// Per-business overrides for the caller-facing SMS follow-up copy
// (root repo services/notifications.js sendCallerSms). Only the known
// template kinds are accepted — any other key would be silently ignored by
// the voice server, so it's rejected here rather than stored as dead data.
// A blank override is dropped rather than persisted: sendCallerSms already
// falls back to its built-in default for an empty string.
function validateSmsTemplates(value) {
  if (value === null) return { value: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: `must be an object keyed by template kind (${SMS_TEMPLATE_KINDS.join(", ")})` };
  }
  const unknownKeys = Object.keys(value).filter((k) => !SMS_TEMPLATE_KINDS.includes(k));
  if (unknownKeys.length) {
    return {
      error: `has unknown template kinds: ${unknownKeys.join(", ")}. Valid: ${SMS_TEMPLATE_KINDS.join(", ")}`,
    };
  }
  const out = {};
  for (const kind of SMS_TEMPLATE_KINDS) {
    const tpl = value[kind];
    if (tpl === undefined || tpl === null) continue;
    if (typeof tpl !== "string") return { error: `.${kind} must be a string` };
    if (tpl.length > SMS_TEMPLATE_MAX_LENGTH) {
      return { error: `.${kind} must be ${SMS_TEMPLATE_MAX_LENGTH} characters or fewer` };
    }
    const trimmed = tpl.trim();
    if (trimmed) out[kind] = trimmed;
  }
  return { value: out };
}

// Key set = businesses table column names = the write whitelist for
// PUT /api/business/:id/settings. Keep 1:1 with the columns.
const SETTINGS_FIELD_VALIDATORS = {
  name: validateName,
  timezone: validateTimezone,
  // DELIBERATELY ABSENT: phone_number.
  //
  // It is the tenant-routing key — whoever holds a number receives its calls.
  // This endpoint authenticates the user against their own business but there
  // is no admin role, so a writable phone_number would let any tenant claim
  // another business's Twilio number and take its calls. Migration 024's unique
  // index blocks the duplicate, but an UNCLAIMED number could still be taken.
  //
  // Attaching an externally-owned number stays an operator action in Supabase,
  // which migration 024's BEFORE trigger now makes safe (it normalizes the
  // paste damage that made every hand-entered row invisible to the lookup).
  // A self-serve field needs authenticated Twilio-ownership verification first
  // — see the note on /api/businesses/:id/phone-numbers/* in server.js.
  greeting: validateBoundedString(500),
  custom_instructions: validateBoundedString(2000),
  general_info: validateBoundedString(2000),
  main_phone: validatePhone,
  business_hours: validateBusinessHours,
  after_hours_policy: validateEnum(AFTER_HOURS_POLICIES),
  transfer_policy: validateEnum(TRANSFER_POLICIES),
  transfer_phone_number: validateE164Phone,
  allowed_tasks: validateAllowedTasks,
  languages_spoken: validateLanguagesSpoken,
  recording_disclosure_enabled: validateBoolean,
  recording_disclosure_text: validateBoundedString(500),
  voice_provider: validateEnum(VOICE_PROVIDERS),
  voice_id: validateVoiceId,
  notification_email: validateEmail,
  notification_phone: validateE164Phone,
  notifications_enabled: validateBoolean,
  sms_followup_enabled: validateBoolean,
  sms_templates: validateSmsTemplates,
};

module.exports = { SETTINGS_FIELD_VALIDATORS };
