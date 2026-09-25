/**
 * Strict save-time schema for the outbound campaign config (spec §7).
 *
 * Unlike the lenient, engine-side capability config validation, this is
 * strict: an unknown top-level key is refused, not dropped, because a typo in
 * a campaign a dashboard user built should not silently do nothing.
 *
 * `validateCampaign` never mutates its inputs and never injects defaults --
 * the caller's config comes back byte-for-byte (deep-equal) as `value` on
 * success, and `TEMPLATES` entries (lib/outbound/templates.js) are frozen, so
 * a test may pass one straight in without cloning it first.
 *
 * Reuses `parseScheduleEntry` / `parseWindow` from ./schedule.js rather than
 * re-implementing the retry-schedule and calling-window grammars.
 */
import { parseScheduleEntry, parseWindow } from "./schedule.js";

/** The spec's disclosure regex, verbatim. Matched against the template TEXT (not the rendered string --
 *  the disclosure words are literal, never behind a placeholder), case-insensitively. */
export const AI_DISCLOSURE_RE = /\b(AI|artificial intelligence|automated assistant|virtual assistant)\b/i;

export const CAMPAIGN_LIMITS = Object.freeze({
  persona_name: 30,
  topic: 80,
  objective: 500,
  notes: 2000,
  // The opener is the short backstop line (spec §9.3): a person who says
  // nothing must not sit through a speech. Revised down from 300 after spike A.
  rendered_opener: 120,
  rendered_voicemail: 300,
  question_ask: 200,
  questions: 10,
  retries: 6,
  give_up_after_days: 30,
  consent_window_days: 90,
  max_call_minutes: 30,
  first_name_worst_case: 30,
});

export const CAMPAIGN_ENUMS = Object.freeze({
  template_key: Object.freeze([
    "speed_to_lead",
    "missed_call_callback",
    "reminder",
    "no_show",
    "aftercare",
    "review_request",
    "reactivation",
    "custom",
  ]),
  // marketing_consented and audience "patient" are refused at save in Part 1
  // (see refusedInPart1 in buildCampaignSchemaExport) but stay in the enum:
  // they are valid values the schema recognises, just not ones Part 1 ships.
  compliance_class: Object.freeze(["solicited", "service", "marketing_consented"]),
  audience: Object.freeze(["business", "patient"]),
  capabilities: Object.freeze(["qualification", "appointments", "transfer", "callback", "opt_out", "outcome"]),
  question_type: Object.freeze(["text", "number", "yes_no"]),
  outside_window: Object.freeze(["queue", "queue_and_text"]),
  booking_adapter: Object.freeze(["internal"]),
});

/** Placeholders `renderTemplate` (and the rendered-length checks) know about. */
export const TEMPLATE_PLACEHOLDERS = Object.freeze(["first_name", "persona_name", "business_name", "topic", "caller_id_spoken"]);

/** The 15 top-level keys spec §7 allows. Anything else is refused, not dropped. */
export const ALLOWED_KEYS = new Set([
  "persona_name",
  "caller_id",
  "calling_window",
  "opener",
  "topic",
  "objective",
  "notes",
  "questions",
  "capabilities",
  "booking",
  "transfer",
  "retries",
  "voicemail",
  "consent_window_days",
  "max_call_minutes",
]);

const EARLIEST_MIN = 8 * 60; // 08:00
const LATEST_MIN = 21 * 60; // 21:00

const E164 = /^\+[1-9]\d{6,14}$/;
const QUESTION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TRANSFER_WHEN_RE = /^(Mon-Fri|Mon-Sat|Daily) \d\d:\d\d-\d\d:\d\d$/;
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Fill `{key}` placeholders from `vars`; anything not in `vars` is left
 * exactly as written. It never throws -- validation checks for unknown
 * placeholders separately, so a template with one can still be rendered to
 * measure its length rather than blowing up the whole validation pass.
 */
export function renderTemplate(tpl, vars) {
  return String(tpl).replace(PLACEHOLDER_RE, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars || {}, key) ? String(vars[key]) : whole
  );
}

/**
 * UK (+44) national form, grouped for speech: leading 0, then the area-code
 * group and the rest in threes -- e.g. +441372656055 -> "01372 656 055".
 * US/Canada (+1): NPA NXX XXXX, e.g. +18176011171 -> "817 601 1171".
 * Anything else: the digits grouped in threes, which is not a real national
 * dialling format but never throws -- an invalid caller_id is refused
 * elsewhere by the E.164 check, and this function must stay safe to call
 * during a rendered-length check on config that has not been validated yet.
 */
export function spokenNumber(e164) {
  const s = typeof e164 === "string" ? e164.trim() : "";

  const uk = s.match(/^\+44(\d{9,10})$/);
  if (uk) {
    const national = "0" + uk[1];
    const groups = [national.slice(0, 5)];
    for (let i = 5; i < national.length; i += 3) groups.push(national.slice(i, i + 3));
    return groups.join(" ");
  }

  const us = s.match(/^\+1(\d{10})$/);
  if (us) {
    const n = us[1];
    return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }

  const digits = s.replace(/^\+/, "");
  if (!digits) return "";
  const groups = [];
  for (let i = 0; i < digits.length; i += 3) groups.push(digits.slice(i, i + 3));
  return groups.join(" ");
}

/** The vars used for the worst-case rendered-length check: a 30-char first name plus the real business/persona/topic/caller ID. */
export function WORST_CASE_VARS(meta, config, businessName) {
  return {
    first_name: "x".repeat(CAMPAIGN_LIMITS.first_name_worst_case),
    business_name: businessName,
    persona_name: config && typeof config.persona_name === "string" ? config.persona_name : "",
    topic: config && typeof config.topic === "string" ? config.topic : "",
    caller_id_spoken: spokenNumber(config && config.caller_id),
  };
}

function validateMessageField(path, tpl, limit, vars, push) {
  if (typeof tpl !== "string" || !tpl) {
    push(path, "must be a non-empty string");
    return;
  }
  if (!tpl.includes("{business_name}")) {
    push(path, "must mention {business_name}");
  }
  if (!AI_DISCLOSURE_RE.test(tpl)) {
    push(path, "must include an AI disclosure (AI, artificial intelligence, automated assistant, or virtual assistant)");
  }
  const used = new Set();
  for (const m of tpl.matchAll(PLACEHOLDER_RE)) used.add(m[1]);
  const unknown = [...used].filter((p) => !TEMPLATE_PLACEHOLDERS.includes(p));
  if (unknown.length) {
    push(path, `unknown placeholder(s): ${unknown.join(", ")}`);
  }
  const rendered = renderTemplate(tpl, vars);
  if (rendered.length > limit) {
    push(path, `renders to ${rendered.length} characters with a worst-case name, over the ${limit}-character budget; refused, never truncated`);
  }
}

function validateCallingWindow(cw, push) {
  if (cw === null || typeof cw !== "object" || Array.isArray(cw)) {
    push("calling_window", "must be an object");
    return;
  }
  let anyOpen = false;
  for (const day of ["mon_fri", "sat", "sun"]) {
    const raw = cw[day];
    if (raw === null || raw === undefined) continue;
    try {
      const w = parseWindow(raw);
      anyOpen = true;
      if (w.start < EARLIEST_MIN || w.end > LATEST_MIN) {
        push(`calling_window.${day}`, "must fall inside 08:00-21:00 local time");
      }
    } catch (e) {
      push(`calling_window.${day}`, e.message);
    }
  }
  if (!anyOpen) {
    push("calling_window", "must be open at least one day");
  }
  if (!CAMPAIGN_ENUMS.outside_window.includes(cw.outside_window)) {
    push("calling_window.outside_window", `must be one of ${CAMPAIGN_ENUMS.outside_window.join(", ")}`);
  }
}

function validateQuestions(questions, push) {
  if (!Array.isArray(questions)) {
    push("questions", "must be an array");
    return;
  }
  if (questions.length > CAMPAIGN_LIMITS.questions) {
    push("questions", `at most ${CAMPAIGN_LIMITS.questions} entries`);
  }
  const seen = new Set();
  questions.forEach((q, i) => {
    const p = `questions[${i}]`;
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      push(p, "must be an object");
      return;
    }
    if (typeof q.key !== "string" || !QUESTION_KEY_RE.test(q.key)) {
      push(`${p}.key`, "must be snake_case, starting with a lowercase letter");
    } else if (seen.has(q.key)) {
      push(`${p}.key`, `duplicate question key "${q.key}"`);
    } else {
      seen.add(q.key);
    }
    if (typeof q.ask !== "string" || !q.ask || q.ask.length > CAMPAIGN_LIMITS.question_ask) {
      push(`${p}.ask`, `must be a non-empty string of at most ${CAMPAIGN_LIMITS.question_ask} characters`);
    }
    if (typeof q.required !== "boolean") {
      push(`${p}.required`, "must be a boolean");
    }
    if (!CAMPAIGN_ENUMS.question_type.includes(q.type)) {
      push(`${p}.type`, `must be one of ${CAMPAIGN_ENUMS.question_type.join(", ")}`);
    }
  });
}

function validateCapabilities(capabilities, push) {
  if (!Array.isArray(capabilities)) {
    push("capabilities", "must be an array");
    return;
  }
  const unknown = capabilities.filter((c) => !CAMPAIGN_ENUMS.capabilities.includes(c));
  if (unknown.length) {
    push("capabilities", `unknown capability: ${unknown.join(", ")}`);
  }
  if (!capabilities.includes("opt_out")) {
    push("capabilities", "opt_out cannot be switched off: a stop request must always work");
  }
}

function validateBooking(booking, push) {
  if (booking === null || typeof booking !== "object" || Array.isArray(booking)) {
    push("booking", "must be an object");
    return;
  }
  if (!CAMPAIGN_ENUMS.booking_adapter.includes(booking.adapter)) {
    push("booking.adapter", `must be one of ${CAMPAIGN_ENUMS.booking_adapter.join(", ")}`);
  }
  if (typeof booking.length_min !== "number" || !Number.isFinite(booking.length_min) || booking.length_min <= 0) {
    push("booking.length_min", "must be a positive number of minutes");
  }
}

function validateTransfer(transfer, push) {
  if (transfer === null) return;
  if (transfer === undefined || typeof transfer !== "object" || Array.isArray(transfer)) {
    push("transfer", "must be null or {to, when, whisper}");
    return;
  }
  const extra = Object.keys(transfer).filter((k) => !["to", "when", "whisper"].includes(k));
  if (extra.length) push("transfer", `unknown key(s): ${extra.join(", ")}`);
  if (typeof transfer.to !== "string" || !E164.test(transfer.to)) push("transfer.to", "must be an E.164 number");
  if (typeof transfer.when !== "string" || !TRANSFER_WHEN_RE.test(transfer.when)) {
    push("transfer.when", 'must match "(Mon-Fri|Mon-Sat|Daily) HH:MM-HH:MM"');
  }
  if (typeof transfer.whisper !== "boolean") push("transfer.whisper", "must be a boolean");
}

function validateRetries(retries, push) {
  if (retries === null || typeof retries !== "object" || Array.isArray(retries)) {
    push("retries", "must be an object");
    return;
  }
  let scheduleLen = 0;
  if (!Array.isArray(retries.schedule)) {
    push("retries.schedule", "must be an array");
  } else {
    scheduleLen = retries.schedule.length;
    if (scheduleLen > CAMPAIGN_LIMITS.retries) {
      push("retries.schedule", `at most ${CAMPAIGN_LIMITS.retries} entries`);
    }
    retries.schedule.forEach((entry, i) => {
      try {
        parseScheduleEntry(entry);
      } catch (e) {
        push(`retries.schedule[${i}]`, e.message);
      }
    });
  }

  const attemptRefs = (arr, path) => {
    if (!Array.isArray(arr)) {
      push(path, "must be an array");
      return;
    }
    const bad = arr.some((n) => !Number.isInteger(n) || n < 1 || n > scheduleLen);
    if (bad) push(path, `must name an attempt number the schedule has (1-${scheduleLen})`);
  };
  attemptRefs(retries.voicemail_on, "retries.voicemail_on");
  attemptRefs(retries.text_after_missed, "retries.text_after_missed");

  if (
    typeof retries.give_up_after_days !== "number" ||
    !Number.isFinite(retries.give_up_after_days) ||
    retries.give_up_after_days < 1 ||
    retries.give_up_after_days > CAMPAIGN_LIMITS.give_up_after_days
  ) {
    push("retries.give_up_after_days", `at most ${CAMPAIGN_LIMITS.give_up_after_days} days`);
  }
}

/**
 * Validate a campaign's meta (name/template_key/compliance_class/audience)
 * and its config (the 15 keys of spec §7) together, because two of the
 * refusals -- marketing_consented and audience "patient" -- live on the
 * meta row, not the config.
 *
 * Never mutates `meta` or `config`, and never injects defaults: on success,
 * `value` is the same `config` the caller passed in.
 */
export function validateCampaign(meta, config, { businessName } = {}) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  const m = meta || {};
  if (m.compliance_class === "marketing_consented") {
    push("compliance_class", "marketing_consented campaigns are refused in Part 1; they arrive in Part 3.");
  } else if (m.compliance_class !== undefined && !CAMPAIGN_ENUMS.compliance_class.includes(m.compliance_class)) {
    push("compliance_class", `must be one of ${CAMPAIGN_ENUMS.compliance_class.join(", ")}`);
  }
  if (m.audience === "patient") {
    push("audience", "patient audience campaigns are refused in Part 1; they arrive in Part 3.");
  } else if (m.audience !== undefined && !CAMPAIGN_ENUMS.audience.includes(m.audience)) {
    push("audience", `must be one of ${CAMPAIGN_ENUMS.audience.join(", ")}`);
  }

  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    push("config", "must be an object");
    return { ok: false, errors };
  }

  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) push(key, `unknown key "${key}"`);
  }

  if (typeof config.persona_name !== "string" || !config.persona_name) {
    push("persona_name", "must be a non-empty string");
  } else if (config.persona_name.length > CAMPAIGN_LIMITS.persona_name) {
    push("persona_name", `at most ${CAMPAIGN_LIMITS.persona_name} characters`);
  }

  if (typeof config.caller_id !== "string" || !E164.test(config.caller_id)) {
    push("caller_id", "must be an E.164 number on the service's Twilio account");
  }

  validateCallingWindow(config.calling_window, push);

  const vars = WORST_CASE_VARS(m, config, businessName);
  validateMessageField("opener", config.opener, CAMPAIGN_LIMITS.rendered_opener, vars, push);
  validateMessageField("voicemail", config.voicemail, CAMPAIGN_LIMITS.rendered_voicemail, vars, push);

  if (typeof config.topic !== "string" || config.topic.length > CAMPAIGN_LIMITS.topic) {
    push("topic", `must be a string of at most ${CAMPAIGN_LIMITS.topic} characters`);
  }
  if (typeof config.objective !== "string" || config.objective.length > CAMPAIGN_LIMITS.objective) {
    push("objective", `must be a string of at most ${CAMPAIGN_LIMITS.objective} characters`);
  }
  if (typeof config.notes !== "string" || config.notes.length > CAMPAIGN_LIMITS.notes) {
    push("notes", `must be a string of at most ${CAMPAIGN_LIMITS.notes} characters, never truncated`);
  }

  validateQuestions(config.questions, push);
  validateCapabilities(config.capabilities, push);
  validateBooking(config.booking, push);
  validateTransfer(config.transfer, push);
  validateRetries(config.retries, push);

  if (
    typeof config.consent_window_days !== "number" ||
    !Number.isFinite(config.consent_window_days) ||
    config.consent_window_days < 1 ||
    config.consent_window_days > CAMPAIGN_LIMITS.consent_window_days
  ) {
    push("consent_window_days", `at most ${CAMPAIGN_LIMITS.consent_window_days} days`);
  }
  if (
    typeof config.max_call_minutes !== "number" ||
    !Number.isFinite(config.max_call_minutes) ||
    config.max_call_minutes < 1 ||
    config.max_call_minutes > CAMPAIGN_LIMITS.max_call_minutes
  ) {
    push("max_call_minutes", `at most ${CAMPAIGN_LIMITS.max_call_minutes} minutes`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: config };
}

/** The dashboard's copy of the schema (scripts/export-campaign-schema.js writes this to generated/campaignSchema.json). */
export function buildCampaignSchemaExport() {
  return {
    version: 1,
    limits: CAMPAIGN_LIMITS,
    enums: CAMPAIGN_ENUMS,
    placeholders: TEMPLATE_PLACEHOLDERS,
    aiDisclosurePattern: AI_DISCLOSURE_RE.source,
    windowBounds: { earliest: "08:00", latest: "21:00" },
    // Values the schema recognises but Part 1 refuses at save (spec §7 / plan
    // §0.1): the dashboard uses this to grey the options out rather than
    // hard-coding a second copy of the same two refusals.
    refusedInPart1: { compliance_class: ["marketing_consented"], audience: ["patient"] },
  };
}
