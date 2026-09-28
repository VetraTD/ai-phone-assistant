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

/**
 * A true dotted acronym -- "A.I.", "A. I.", "a.i." -- with the dot AFTER the
 * I required. That trailing dot is what separates the acronym from two
 * separate words: "Plan A. I wanted to…" or "grade A. I'll…" must NOT read as
 * a disclosure (Task 14 fix round 3; the check fails open otherwise).
 */
const DOTTED_AI_RE = /\b[Aa]\.\s?[Ii]\./g;

/**
 * Fold dotted spellings of AI to "AI" before AI_DISCLOSURE_RE is applied to a
 * TRANSCRIPT (a template is typed, a transcript is transcribed). The one
 * normaliser for the Live session's first-turn check (firstSeconds.js) and the
 * clip verification (liveRender.js), so the two cannot disagree.
 * @param {string} text
 * @returns {string}
 */
export function foldDottedAI(text) {
  return String(text ?? "").replace(DOTTED_AI_RE, "AI");
}

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
  booking_length_min: 240,
  // O-24/a9 (post-2c): a calling-window entry shorter than this is refused at
  // save -- a window under half an hour is not a real dialling window, it is
  // a misconfiguration (a typo'd end time, or a copy-paste that never
  // finished).
  min_window_minutes: 30,
  // S3-6 (spec §19, S3-D4): the new goal-driven fields.
  why_allowed: 300,
  message_text: 300,
  details_fields: 10,
  // A single rendered "DETAILS: label: value" line's value half, at runtime
  // (lib/outbound/prompt.js) -- not a save-time field on its own, but the
  // budget a per-person detail value is held to, the same "refused, never
  // truncated" style as the opener/voicemail: an over-budget value is left
  // out of the prompt rather than cut.
  details_value: 200,
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
  // marketing_consented, audience "patient", and every template_key but
  // speed_to_lead are refused at save in Part 1 (see REFUSED_IN_PART1 below)
  // but stay in the enum: they are valid values the schema recognises, just
  // not ones Part 1 ships.
  compliance_class: Object.freeze(["solicited", "service", "marketing_consented"]),
  audience: Object.freeze(["business", "patient"]),
  capabilities: Object.freeze(["qualification", "appointments", "transfer", "callback", "opt_out", "outcome"]),
  question_type: Object.freeze(["text", "number", "yes_no"]),
  outside_window: Object.freeze(["queue", "queue_and_text"]),
  booking_adapter: Object.freeze(["internal"]),
  // S3-6 (spec §19, S3-D4): what the campaign is FOR. Each value's own
  // required capabilities live in GOAL_REQUIRED_CAPABILITIES below.
  goal: Object.freeze(["book", "qualify_then_book", "confirm_or_move", "get_review", "pass_message", "find_need"]),
  // The Live voice's pinned language (lib/voice/live/index.js
  // resolveLiveLanguage): optional, defaults to the tenant's own at runtime.
  language: Object.freeze(["en-GB", "en-US"]),
  // Only meaningful when template_key is "custom" (spec §19, S3-D4):
  // asked_to_be_contacted -> compliance_class solicited, existing_customer ->
  // service, selling -> refused (arrives in Part 3).
  custom_basis: Object.freeze(["asked_to_be_contacted", "existing_customer", "selling"]),
});

/**
 * The capabilities each goal REQUIRES (spec §19, S3-D4): a goal saved
 * without its capability is refused at save, naming the missing one(s).
 * Goals absent from this map (get_review, pass_message, find_need) need no
 * particular capability.
 */
export const GOAL_REQUIRED_CAPABILITIES = Object.freeze({
  book: Object.freeze(["appointments"]),
  qualify_then_book: Object.freeze(["qualification", "appointments"]),
  confirm_or_move: Object.freeze(["appointments"]),
});

/**
 * Values the schema recognises but Part 1 refuses at save (spec §7 / plan
 * §0.1). This is the single source both `validateCampaign` and
 * `buildCampaignSchemaExport` read, so the dashboard's greyed-out options can
 * never drift from what save actually enforces.
 *
 * template_key: the spec says "Part 1 ships speed_to_lead only" -- every other
 * key is refused, not just left unvalidated. Without this, `reactivation`
 * (whose consent purpose is "marketing") would dodge the marketing_consented
 * refusal entirely by picking a different template with the same intent.
 *
 * S3-6 (spec §19, S3-D4) allows `custom` too, for `asked_to_be_contacted`
 * (solicited) and `existing_customer` (service) -- `selling` stays refused,
 * by `custom_basis` rather than by this list (see validateCampaign).
 */
export const REFUSED_IN_PART1 = Object.freeze({
  compliance_class: Object.freeze(["marketing_consented"]),
  audience: Object.freeze(["patient"]),
  template_key: Object.freeze(CAMPAIGN_ENUMS.template_key.filter((k) => k !== "speed_to_lead" && k !== "custom")),
});

/** Placeholders `renderTemplate` (and the rendered-length checks) know about. */
export const TEMPLATE_PLACEHOLDERS = Object.freeze(["first_name", "persona_name", "business_name", "topic", "caller_id_spoken"]);

/** The 22 top-level keys spec §7 + S3-D4 allow. Anything else is refused, not dropped. */
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
  // S3-6 (spec §19, S3-D4).
  "goal",
  "details_fields",
  "language",
  "why_allowed",
  "review_url",
  "message_text",
  "custom_basis",
]);

const EARLIEST_MIN = 8 * 60; // 08:00
const LATEST_MIN = 21 * 60; // 21:00

const minutesToHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The local-time bounds every calling window must fall inside (spec §7 / plan §0.1), as "HH:MM" strings. */
export const WINDOW_BOUNDS = Object.freeze({ earliest: minutesToHHMM(EARLIEST_MIN), latest: minutesToHHMM(LATEST_MIN) });

const E164 = /^\+[1-9]\d{6,14}$/;
const QUESTION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TRANSFER_WHEN_RE = /^(Mon-Fri|Mon-Sat|Daily) \d\d:\d\d-\d\d:\d\d$/;
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
// S3-6 (spec §19, S3-D4): a details_fields entry's key, snake_case, <= 32 chars.
const DETAILS_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const HTTPS_URL_RE = /^https:\/\/\S+$/i;

// The allowed keys of each nested object (spec §7). Strict, like the 15
// top-level keys: an unknown nested key -- a typo ("mon-fri"), a made-up one
// ("sunday", "max_attempts"), or an extra field on a question -- is refused,
// not silently accepted.
const ALLOWED_CALLING_WINDOW_KEYS = new Set(["mon_fri", "sat", "sun", "outside_window"]);
const ALLOWED_RETRIES_KEYS = new Set(["schedule", "voicemail_on", "text_after_missed", "give_up_after_days"]);
const ALLOWED_BOOKING_KEYS = new Set(["adapter", "length_min"]);
const ALLOWED_QUESTION_KEYS = new Set(["key", "ask", "required", "type"]);
const ALLOWED_DETAILS_FIELD_KEYS = new Set(["key", "label"]);

/** A whole number in [min, max]; "is required" when absent (never confused with "at most N"). */
function validateBoundedInt(path, value, max, push, { min = 1 } = {}) {
  if (value === undefined) {
    push(path, "is required");
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    push(path, `must be a whole number from ${min} to ${max}`);
  }
}

/** A required meta field, checked against an enum and the Part 1 refusal list, in that order. */
function validateMetaEnumField(path, value, enumValues, refused, push) {
  if (value === undefined || value === null || value === "") {
    push(path, "is required");
    return;
  }
  if (!enumValues.includes(value)) {
    push(path, `must be one of ${enumValues.join(", ")}`);
    return;
  }
  if (refused.includes(value)) {
    push(path, `"${value}" is refused in Part 1; it arrives in Part 3.`);
  }
}

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
 * Title abbreviations whose full stop does NOT end a sentence (fix round 3):
 * "this is Dr. Lee's line" and "Hello Mr. {first_name}." are one sentence
 * each. Matched as whole words, case-insensitively.
 */
export const TITLE_ABBREVIATIONS = Object.freeze(["Dr", "Mr", "Mrs", "Ms", "Mx", "Prof", "St"]);

/**
 * Where a template splits into sentences for the no-first-name rule: after a
 * sentence-ending `.`, `?` or `!` that is followed by whitespace -- except
 * the full stop of a TITLE_ABBREVIATIONS word. Applied to the TEMPLATE, never
 * the rendered text, so a value that contains a full stop ("Dr. Patel
 * Clinic") cannot split a sentence.
 */
export const SENTENCE_SPLIT_RE = new RegExp(
  `(?<=[.?!])(?<!\\b(?:${TITLE_ABBREVIATIONS.join("|")})\\.)\\s+`,
  "i"
);

/**
 * THE one renderer for the lines Ava speaks from a campaign template -- the
 * opener (the backstop clip and its seed) and the voicemail. Dispatch renders
 * the clip text with it and the Live session re-renders the seed with it, so
 * the two can never disagree (Task 14 fix round 2, owner decision O-9).
 *
 * - A first name present: every placeholder filled from the current values.
 * - NO first name (null, undefined, empty or blank): the template's sentences
 *   that use `{first_name}` are dropped (SENTENCE_SPLIT_RE), and the remainder
 *   is used ONLY if it still carries the business name AND the §7 AI
 *   disclosure. Otherwise there is no line -- the opener takes the prompt
 *   path, the voicemail is not left.
 * - Never the literal "null", "undefined" or an unfilled "{key}": a
 *   placeholder with no value makes the whole line null.
 *
 * Length budgets are the caller's (dispatch and the session each check
 * theirs); this function never truncates.
 *
 * @param {string} template
 * @param {{firstName?: string|null, businessName?: string|null, config?: object}} values
 * @returns {string|null}
 */
export function renderCampaignLine(template, { firstName, businessName, config } = {}) {
  if (typeof template !== "string" || !template.trim()) return null;
  const firstNameValue = typeof firstName === "string" ? firstName.trim() : "";

  const vars = {};
  const put = (key, value) => {
    if (typeof value === "string" && value.trim()) vars[key] = value;
  };
  put("first_name", firstNameValue);
  put("business_name", businessName);
  put("persona_name", config?.persona_name);
  put("topic", config?.topic);
  put("caller_id_spoken", spokenNumber(config?.caller_id));

  let tpl = template;
  if (!firstNameValue) {
    tpl = template
      .split(SENTENCE_SPLIT_RE)
      .filter((sentence) => !sentence.includes("{first_name}"))
      .join(" ");
    if (!tpl.trim()) return null;
  }
  for (const [, key] of tpl.matchAll(PLACEHOLDER_RE)) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return null;
  }

  const text = renderTemplate(tpl, vars).trim();
  if (!firstNameValue) {
    const business = vars.business_name;
    if (!business || !text.includes(business) || !AI_DISCLOSURE_RE.test(text)) return null;
  }
  return text;
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
    // O-24/a8: 02x numbers -- 020 (London) and also 023/024/028/029, which
    // share the shape -- are spoken 3+4+4 ("020 7123 4567"), never the
    // generic 5+3+3 grouping below, which reads as "02071 234 567" and is
    // not how anyone says a London number. Every other UK shape (07x
    // mobile, 01x) is unaffected and keeps the 5+3+3 grouping.
    if (national.length === 11 && national.startsWith("02")) {
      return `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7, 11)}`;
    }
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
  // Test the LITERAL text with every placeholder collapsed to a single word
  // character, not the raw template. A placeholder's braces are non-word
  // characters, so checking the raw template lets "{persona_name}AI" or
  // "AI{business_name}" read as a boundary-delimited "AI" -- but the rendered
  // value glues onto those letters with no boundary at all ("AvaAI"). Collapsing
  // to one word character reproduces that gluing before the regex ever runs, so
  // only a disclosure word bounded by literal text (never a placeholder) counts.
  if (!AI_DISCLOSURE_RE.test(tpl.replace(PLACEHOLDER_RE, "x"))) {
    push(path, "must include an AI disclosure (AI, artificial intelligence, automated assistant, or virtual assistant) bounded by literal text, not merely adjacent to a placeholder");
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
  for (const key of Object.keys(cw)) {
    if (!ALLOWED_CALLING_WINDOW_KEYS.has(key)) push(`calling_window.${key}`, `unknown key "${key}"`);
  }
  let anyOpen = false;
  for (const day of ["mon_fri", "sat", "sun"]) {
    const raw = cw[day];
    if (raw === null || raw === undefined) continue;
    try {
      const w = parseWindow(raw);
      anyOpen = true;
      if (w.start < EARLIEST_MIN || w.end > LATEST_MIN) {
        push(`calling_window.${day}`, `must fall inside ${WINDOW_BOUNDS.earliest}-${WINDOW_BOUNDS.latest} local time`);
      }
      // O-24/a9: a window under CAMPAIGN_LIMITS.min_window_minutes is refused
      // -- named by its entry, e.g. "20:59-21:00" (1 minute) is not a real
      // dialling window.
      if (w.end - w.start < CAMPAIGN_LIMITS.min_window_minutes) {
        push(`calling_window.${day}`, `entry "${raw}" must be at least ${CAMPAIGN_LIMITS.min_window_minutes} minutes long`);
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
    for (const key of Object.keys(q)) {
      if (!ALLOWED_QUESTION_KEYS.has(key)) push(`${p}.${key}`, `unknown key "${key}"`);
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

/**
 * S3-6 (spec §19, S3-D4): the goal needs its capabilities -- a missing one is
 * refused at save, naming it (named risk 2). Called only once `goal` itself
 * is a known enum value; a goal with no entry in GOAL_REQUIRED_CAPABILITIES
 * (get_review, pass_message, find_need) needs nothing extra.
 */
function validateGoalCapabilities(goal, capabilities, push) {
  const required = GOAL_REQUIRED_CAPABILITIES[goal];
  if (!required) return;
  const caps = Array.isArray(capabilities) ? capabilities : [];
  const missing = required.filter((c) => !caps.includes(c));
  if (missing.length) {
    const label = missing.length > 1 ? "capabilities" : "capability";
    push("capabilities", `goal "${goal}" requires the ${missing.join(", ")} ${label}`);
  }
}

/** S3-6 (spec §19, S3-D4): <= 10 entries of {key, label}, strict like every other nested list here. */
function validateDetailsFields(fields, push) {
  if (!Array.isArray(fields)) {
    push("details_fields", "must be an array");
    return;
  }
  if (fields.length > CAMPAIGN_LIMITS.details_fields) {
    push("details_fields", `at most ${CAMPAIGN_LIMITS.details_fields} entries`);
  }
  const seen = new Set();
  fields.forEach((f, i) => {
    const p = `details_fields[${i}]`;
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      push(p, "must be an object");
      return;
    }
    for (const key of Object.keys(f)) {
      if (!ALLOWED_DETAILS_FIELD_KEYS.has(key)) push(`${p}.${key}`, `unknown key "${key}"`);
    }
    if (typeof f.key !== "string" || !DETAILS_KEY_RE.test(f.key)) {
      push(`${p}.key`, "must be snake_case, starting with a lowercase letter, at most 32 characters");
    } else if (seen.has(f.key)) {
      push(`${p}.key`, `duplicate details_fields key "${f.key}"`);
    } else {
      seen.add(f.key);
    }
    if (typeof f.label !== "string" || !f.label.trim() || f.label.length > 40) {
      push(`${p}.label`, "must be a non-empty string of at most 40 characters");
    }
  });
}

function validateBooking(booking, push) {
  if (booking === null || typeof booking !== "object" || Array.isArray(booking)) {
    push("booking", "must be an object");
    return;
  }
  for (const key of Object.keys(booking)) {
    if (!ALLOWED_BOOKING_KEYS.has(key)) push(`booking.${key}`, `unknown key "${key}"`);
  }
  if (!CAMPAIGN_ENUMS.booking_adapter.includes(booking.adapter)) {
    push("booking.adapter", `must be one of ${CAMPAIGN_ENUMS.booking_adapter.join(", ")}`);
  }
  validateBoundedInt("booking.length_min", booking.length_min, CAMPAIGN_LIMITS.booking_length_min, push);
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
  for (const key of Object.keys(retries)) {
    if (!ALLOWED_RETRIES_KEYS.has(key)) push(`retries.${key}`, `unknown key "${key}"`);
  }
  let scheduleLen = 0;
  if (!Array.isArray(retries.schedule)) {
    push("retries.schedule", "must be an array");
  } else {
    scheduleLen = retries.schedule.length;
    if (scheduleLen < 1) {
      push("retries.schedule", "must have at least 1 entry");
    } else if (scheduleLen > CAMPAIGN_LIMITS.retries) {
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

  validateBoundedInt("retries.give_up_after_days", retries.give_up_after_days, CAMPAIGN_LIMITS.give_up_after_days, push);
}

/**
 * Validate a campaign's meta (name/template_key/compliance_class/audience)
 * and its config (the 15 keys of spec §7) together, because two of the
 * refusals -- marketing_consented and audience "patient" -- live on the
 * meta row, not the config.
 *
 * Never mutates `meta` or `config`, and never injects defaults: on success,
 * `value` is the same `config` the caller passed in.
 *
 * `opts` is null-safe: an omitted or `null` third argument never throws, and
 * is instead reported as a missing `business_name` (a length check against an
 * absent business name would otherwise silently measure the literal string
 * "undefined").
 */
export function validateCampaign(meta, config, opts) {
  const { businessName } = opts || {};
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (typeof businessName !== "string" || !businessName.trim()) {
    push("business_name", "must be a non-empty business name");
  }

  const m = meta || {};
  if (typeof m.name !== "string" || !m.name.trim()) {
    push("name", "is required");
  }
  validateMetaEnumField("template_key", m.template_key, CAMPAIGN_ENUMS.template_key, REFUSED_IN_PART1.template_key, push);
  validateMetaEnumField("compliance_class", m.compliance_class, CAMPAIGN_ENUMS.compliance_class, REFUSED_IN_PART1.compliance_class, push);
  validateMetaEnumField("audience", m.audience, CAMPAIGN_ENUMS.audience, REFUSED_IN_PART1.audience, push);

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
  } else if (foldDottedAI(config.persona_name).trim().toUpperCase() === "AI") {
    // O-24/a7: "AI", "Ai", "A.I.", "a. i." (after the SAME dotted-AI fold the
    // transcript-side disclosure check uses) all read, once spoken, as the
    // disclosure itself -- "It's AI, an AI assistant from..." tells the
    // caller nothing a real name would. "Aiden"/"Aisha"/"Kai" fold to
    // themselves (no dot after each letter) and are unaffected.
    push("persona_name", 'must not be only the AI disclosure itself (e.g. "AI", "A.I."); the persona name must not double as the AI disclosure');
  }

  // S3-6 (spec §19, S3-D4): caller_id is now OPTIONAL -- it defaults to the
  // business's own number at dispatch (lib/outbound/dispatch.js), still run
  // through the same ownership check there (named risk 6). Only checked here
  // when the key is PRESENT: an absent key is fine, but a present one (even
  // "", the shipped speed_to_lead template's own placeholder) must still be a
  // real E.164 number -- unchanged from before this task.
  if (config.caller_id !== undefined && (typeof config.caller_id !== "string" || !E164.test(config.caller_id))) {
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

  validateBoundedInt("consent_window_days", config.consent_window_days, CAMPAIGN_LIMITS.consent_window_days, push);
  validateBoundedInt("max_call_minutes", config.max_call_minutes, CAMPAIGN_LIMITS.max_call_minutes, push);

  // ---------------------------------------------------------------------
  // S3-6 (spec §19, S3-D4): goal-driven campaign fields + the `custom`
  // template.
  // ---------------------------------------------------------------------

  // `goal` is required (named risk 5's counterpart at save time -- a NEW
  // campaign can never be saved without one; only a version saved before
  // this task shipped can lack it, and dispatch.js refuses to dial that).
  if (config.goal === undefined || config.goal === null || config.goal === "") {
    push("goal", "is required");
  } else if (!CAMPAIGN_ENUMS.goal.includes(config.goal)) {
    push("goal", `must be one of ${CAMPAIGN_ENUMS.goal.join(", ")}`);
  } else {
    validateGoalCapabilities(config.goal, config.capabilities, push);
  }

  // `why_allowed` is required, shown to reviewers, never spoken -- so it gets
  // no AI-disclosure/placeholder treatment, just presence and a length cap.
  if (typeof config.why_allowed !== "string" || !config.why_allowed.trim()) {
    push("why_allowed", "is required");
  } else if (config.why_allowed.length > CAMPAIGN_LIMITS.why_allowed) {
    push("why_allowed", `at most ${CAMPAIGN_LIMITS.why_allowed} characters`);
  }

  // `language`: optional; when present, one of the Live voice's languages.
  if (config.language !== undefined && !CAMPAIGN_ENUMS.language.includes(config.language)) {
    push("language", `must be one of ${CAMPAIGN_ENUMS.language.join(", ")}`);
  }

  // `details_fields`: optional; validated (strict) only when present.
  if (config.details_fields !== undefined) {
    validateDetailsFields(config.details_fields, push);
  }

  // `review_url`: https only, required iff goal is get_review.
  if (config.goal === "get_review" && (typeof config.review_url !== "string" || !config.review_url.trim())) {
    push("review_url", "is required when goal is get_review");
  } else if (config.review_url !== undefined && (typeof config.review_url !== "string" || !HTTPS_URL_RE.test(config.review_url))) {
    push("review_url", "must be an https URL");
  }

  // `message_text`: <= 300 characters, required iff goal is pass_message.
  if (config.goal === "pass_message" && (typeof config.message_text !== "string" || !config.message_text.trim())) {
    push("message_text", "is required when goal is pass_message");
  } else if (config.message_text !== undefined) {
    if (typeof config.message_text !== "string" || config.message_text.length > CAMPAIGN_LIMITS.message_text) {
      push("message_text", `must be a string of at most ${CAMPAIGN_LIMITS.message_text} characters`);
    }
  }

  // `custom_basis`: required iff template_key is custom. `selling` is
  // refused outright (arrives in Part 3, named-risk-1 sabotage target); the
  // other two basis values pin the ONLY compliance_class custom may save
  // under for that basis (asked_to_be_contacted -> solicited,
  // existing_customer -> service) -- this is the "class is resolved at save"
  // mapping (controller ruling), enforced as a coherence check rather than an
  // override, because validateCampaign never rewrites what the caller passed.
  if (m.template_key === "custom") {
    if (config.custom_basis === undefined || config.custom_basis === null || config.custom_basis === "") {
      push("custom_basis", "is required when template_key is custom");
    } else if (!CAMPAIGN_ENUMS.custom_basis.includes(config.custom_basis)) {
      push("custom_basis", `must be one of ${CAMPAIGN_ENUMS.custom_basis.join(", ")}`);
    } else if (config.custom_basis === "selling") {
      push("custom_basis", '"selling" is refused; it arrives in Part 3.');
    } else {
      const requiredClass = config.custom_basis === "asked_to_be_contacted" ? "solicited" : "service";
      if (m.compliance_class !== requiredClass) {
        push("compliance_class", `custom + ${config.custom_basis} must be compliance_class "${requiredClass}"`);
      }
    }
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
    // The pattern is matched case-insensitively (AI_DISCLOSURE_RE.flags is
    // "i") -- exporting only .source silently dropped that.
    aiDisclosureFlags: AI_DISCLOSURE_RE.flags,
    windowBounds: WINDOW_BOUNDS,
    // Values the schema recognises but Part 1 refuses at save: the same
    // REFUSED_IN_PART1 the validator reads, so the dashboard's greyed-out
    // options cannot drift from what save actually enforces.
    refusedInPart1: {
      compliance_class: [...REFUSED_IN_PART1.compliance_class],
      audience: [...REFUSED_IN_PART1.audience],
      template_key: [...REFUSED_IN_PART1.template_key],
    },
  };
}
