import { createClient } from "@supabase/supabase-js";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import { allCapabilityToolNames, getPack } from "../capabilities/index.js";
import { validateCapabilityConfig } from "../lib/capabilities/configSchema.js";
import { normalizePhoneNumber } from "../lib/phone.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;

/**
 * Every Supabase request gets a deadline.
 *
 * The client was previously constructed bare, and undici imposes no request
 * deadline of its own, so a hung query hung for the life of the call. The
 * JS-side race in services/tools.js releases the CALLER, but it cannot cancel
 * anything — only this can, and cancelling is what stops a reschedule landing
 * in the database minutes after the caller was told it had failed.
 *
 * Sized below TOOL_TIMEOUT_MS so the transport gives up first and the tool
 * layer reports a real error rather than its own generic timeout.
 */
const SUPABASE_TIMEOUT_MS = (() => {
  const v = Number.parseInt(process.env.SUPABASE_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 1_000 && v <= 30_000 ? v : 6_000;
})();

function fetchWithTimeout(input, init = {}) {
  // Respect a caller-supplied signal if one ever appears; otherwise impose ours.
  if (init.signal) return fetch(input, init);
  return fetch(input, { ...init, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
}

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    global: { fetch: fetchWithTimeout },
  });
} else {
  log.error("supabase_not_configured", { reason: "missing_url_or_key", severity: "warn" });
}

/** @returns {boolean} Whether the Supabase client is configured */
export function isEnabled() {
  return supabase !== null;
}

// ---------------------------------------------------------------------------
// Per-business config
// ---------------------------------------------------------------------------

const DEFAULT_GREETING = "Hi, how can I help you today?";

/**
 * Task model: CORE tasks are always available on every call, regardless of
 * per-business configuration — general Q&A, message-taking, callback
 * requests, and transferring to a human are baseline receptionist behavior,
 * not opt-in features. MODULE tasks are the opt-in capabilities a business
 * can turn on (e.g. appointment booking).
 */
export const CORE_TASKS = ["general_question", "take_message", "callback_request", "transfer_human"];
export const MODULE_TASKS = [
  "book_appointment",
  "check_appointment",
  "cancel_reschedule",
  "quote_request",
];

/** Default modules for a business with no allowed_tasks configured. */
const DEFAULT_MODULE_TASKS = ["book_appointment"];

/** Legacy bundle: "appointments" expands to the three appointment modules. */
const APPOINTMENTS_EXPAND = ["book_appointment", "check_appointment", "cancel_reschedule"];

/**
 * Normalize a business's raw `allowed_tasks` DB value into the full
 * effective task list: CORE tasks (always present) + whichever MODULE tasks
 * the business opted into. Legacy `"appointments"` expands to the three
 * appointment modules; legacy core entries (general_question, take_message,
 * callback_request) present in old DB rows are dropped silently — they're
 * no longer module-gated.
 * @param {Array<string>|null|undefined} raw - business.allowed_tasks from the DB
 * @returns {Array<string>}
 */
export function normalizeAllowedTasks(raw) {
  // UNSET (null/undefined) means "never configured" -> sensible default.
  // An EMPTY ARRAY means "explicitly no modules", which used to be
  // indistinguishable from unset: both fell through to ["book_appointment"],
  // so there was no way to express a business that does not do appointments at
  // all. Every non-appointment business was literally unrepresentable.
  if (raw === null || raw === undefined) {
    return [...CORE_TASKS, ...DEFAULT_MODULE_TASKS];
  }
  if (!Array.isArray(raw)) {
    return [...CORE_TASKS, ...DEFAULT_MODULE_TASKS];
  }
  if (raw.length === 0) {
    return [...CORE_TASKS];
  }
  const expanded = raw.includes("appointments")
    ? [...raw.filter((t) => t !== "appointments"), ...APPOINTMENTS_EXPAND]
    : raw;
  const modules = expanded.filter((t) => typeof t === "string" && MODULE_TASKS.includes(t));
  return [...CORE_TASKS, ...new Set(modules)];
}

/** Valid after-hours policy values. */
const AFTER_HOURS_POLICIES = ["take_message", "offer_callback", "book_later", "transfer_if_possible"];

/** Valid transfer policy values. */
const TRANSFER_POLICIES = ["always", "business_hours_only", "never"];

/**
 * Build a normalised config object from a business row.
 * If `business` is null (no business found / DB disabled), returns safe defaults.
 *
 * @param {object|null} business - Row from the businesses table (via select("*"))
 * @returns {object} Normalised config with all fields defaulted
 */
/**
 * Which module tasks each capability owns. Used to switch a capability off
 * wholesale when its business_capabilities row says enabled = false.
 */
const CAPABILITY_MODULE_TASKS = {
  appointments: ["book_appointment", "check_appointment", "cancel_reschedule"],
  quotes: ["quote_request"],
};

/**
 * Fetch a business's capability rows.
 *
 * Returns [] when the table is missing or the business has none, which is what
 * makes the dual-read safe: no rows means fall back to allowed_tasks, so new
 * code against an un-migrated database still works rather than silently
 * disabling every capability mid-call.
 *
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
export async function fetchBusinessCapabilities(businessId) {
  if (!supabase || !businessId) return [];
  const { data, error } = await supabase
    .from("business_capabilities")
    .select("*")
    .eq("business_id", businessId);
  if (error) {
    log.error("db_error", { operation: "fetchBusinessCapabilities", error: error.message });
    return [];
  }
  return data || [];
}

/**
 * Build the per-capability config map, and apply any explicit disables.
 *
 * @param {Array<object>} rows - business_capabilities rows
 * @param {string[]} allowedTasks - module tasks from the legacy column
 * @param {string} businessId
 * @returns {{capabilities: object, allowedTasks: string[]}}
 */
function applyCapabilityRows(rows, allowedTasks, businessId) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { capabilities: {}, allowedTasks };
  }

  const capabilities = {};
  let tasks = [...allowedTasks];

  for (const row of rows) {
    const pack = getPack(row.capability_id);
    if (!pack) {
      // A row for a capability this build does not have. Expected during a
      // rollback; ignore it rather than failing the call.
      log.error("capability_row_unknown", {
        businessId,
        capability: row.capability_id,
        severity: "warn",
      });
      continue;
    }

    const owned = CAPABILITY_MODULE_TASKS[row.capability_id] || [];

    if (row.enabled === false) {
      // The explicit "off" that allowed_tasks could never express.
      tasks = tasks.filter((t) => !owned.includes(t));
      continue;
    }

    // Enabling has to ADD the capability's module tasks, or switching one on in
    // the dashboard would store enabled=true and still register no tools —
    // a setting that appears to work and does nothing.
    //
    // Only when the business has none of them already. A business that opted
    // into booking but not cancelling has expressed a real preference at a
    // finer grain than a single capability row can, and enabling must not
    // silently widen it.
    if (owned.length > 0 && !owned.some((t) => tasks.includes(t))) {
      tasks = [...tasks, ...owned];
    }

    capabilities[row.capability_id] = {
      enabled: true,
      ...(row.adapter ? { adapter: row.adapter } : {}),
      ...(row.adapter_config && typeof row.adapter_config === "object"
        ? { adapterConfig: row.adapter_config }
        : {}),
      ...validateCapabilityConfig(row.config, pack, businessId),
    };
  }

  return { capabilities, allowedTasks: tasks };
}

/**
 * @param {object|null} business - row from the businesses table
 * @param {Array<object>} [capabilityRows] - rows from business_capabilities.
 *   Optional: a caller without them gets today's behavior (no requirements
 *   configured), which is what keeps the dual-read honest.
 */
export function loadConfig(business, capabilityRows = null) {
  if (!business) {
    return {
      businessName: "our office",
      greeting: DEFAULT_GREETING,
      _hasCustomGreeting: false,
      timezone: process.env.TIMEZONE || "America/Chicago",
      businessHours: null,
      transferPhoneNumber: null,
      allowedTasks: normalizeAllowedTasks(null),
      capabilities: {},
      mainPhone: null,
      generalInfo: null,
      recordingDisclosureEnabled: false,
      recordingDisclosureText: null,
      afterHoursPolicy: "take_message",
      transferPolicy: "always",
      languagesSpoken: ["en"],
      customInstructions: null,
      voiceProvider: "elevenlabs",
      voiceId: null,
      smsFollowupEnabled: false,
      smsTemplates: {},
    };
  }

  const afterHoursPolicy = AFTER_HOURS_POLICIES.includes(business.after_hours_policy)
    ? business.after_hours_policy
    : "take_message";
  const transferPolicy = TRANSFER_POLICIES.includes(business.transfer_policy)
    ? business.transfer_policy
    : "always";

  const baseTasks = normalizeAllowedTasks(business.allowed_tasks);
  // Rows arrive embedded on the business row (see lookupBusinessByPhone); an
  // explicit argument overrides, which is what the tests and the dashboard use.
  const rows = capabilityRows ?? business.business_capabilities ?? [];
  const { capabilities, allowedTasks } = applyCapabilityRows(rows, baseTasks, business.id);

  return {
    businessName: business.name || "our office",
    greeting: business.greeting || DEFAULT_GREETING,
    _hasCustomGreeting: !!business.greeting,
    timezone: business.timezone || process.env.TIMEZONE || "America/Chicago",
    // Explicit locale override (database/025_business_locale.sql). null means
    // "derive" — see lib/voice/voiceLocale.js. An operator setting this beats
    // every heuristic, which is the point: the heuristics exist only because
    // there usually is not one.
    locale: business.locale || null,
    businessHours: business.business_hours || null,
    transferPhoneNumber: business.transfer_phone_number || null,
    allowedTasks,
    capabilities,
    mainPhone: business.main_phone || null,
    generalInfo: business.general_info || null,
    recordingDisclosureEnabled: !!business.recording_disclosure_enabled,
    recordingDisclosureText: business.recording_disclosure_text || null,
    afterHoursPolicy,
    transferPolicy,
    languagesSpoken: Array.isArray(business.languages_spoken) ? business.languages_spoken : ["en"],
    customInstructions: business.custom_instructions || null,
    voiceProvider: business.voice_provider || "elevenlabs",
    voiceId: business.voice_id || null,
    smsFollowupEnabled: !!business.sms_followup_enabled,
    smsTemplates: (business.sms_templates && typeof business.sms_templates === "object") ? business.sms_templates : {},
  };
}

/**
 * Fetch a business by ID (for notifications and dashboard).
 * @param {string} businessId - UUID of the business
 * @returns {Promise<object|null>} The business row or null
 */
export async function fetchBusinessById(businessId) {
  if (!supabase || !businessId) return null;
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .limit(1)
    .maybeSingle();
  if (error) {
    log.error("db_error", { operation: "fetchBusinessById", error: error.message });
    return null;
  }
  return data;
}

/**
 * One exact-equality lookup on businesses.phone_number.
 * @param {string} value - the number to match, verbatim
 * @returns {Promise<object|null>} The business row or null
 */
async function selectBusinessByExactPhone(value) {
  // Capability rows come back embedded in the SAME round trip. They are needed
  // before the first turn, because they decide which tools exist and which
  // requirements are enforced — fetching them in the background alongside
  // knowledge and integrations would leave a caller who speaks immediately
  // running turn one with no requirements applied, which for an identity check
  // is not an acceptable race. Embedding avoids paying a second round trip on
  // the pickup path, which is latency-critical.
  const { data, error } = await supabase
    .from("businesses")
    .select("*, business_capabilities(*)")
    .eq("phone_number", value)
    .limit(1)
    .maybeSingle();

  if (error) {
    // An un-migrated database has no business_capabilities table, and the
    // embed makes the whole query fail rather than returning the business
    // without it. Falling back to the plain select keeps calls answerable
    // during a partial deploy — the dual-read then uses allowed_tasks.
    log.error("db_error", { operation: "lookupBusinessByPhone", error: error.message });
    const plain = await supabase
      .from("businesses")
      .select("*")
      .eq("phone_number", value)
      .limit(1)
      .maybeSingle();
    if (plain.error) {
      log.error("db_error", { operation: "lookupBusinessByPhone_fallback", error: plain.error.message });
      return null;
    }
    return plain.data;
  }
  return data;
}

/**
 * Recover a business whose stored phone_number is damaged (whitespace or
 * formatting characters) and therefore cannot match the clean E.164 value
 * Twilio sends.
 *
 * This is the case that took every business except one offline: rows entered by
 * hand in the Supabase table editor were stored as "\n+442079460958". Migration
 * 024 cleans them and installs a trigger so it cannot recur — this is the
 * safety net for a database where that has not run, or where the trigger has
 * been dropped.
 *
 * The LIKE pattern only narrows the candidate set; the match is then confirmed
 * in JS with normalizePhoneNumber, so a number that merely contains the same
 * digits in order can never be returned as a false positive.
 *
 * @param {string} normalized - E.164 number Twilio dialed
 * @returns {Promise<object|null>}
 */
async function recoverBusinessByDamagedPhone(normalized) {
  const pattern = `%${normalized.replace(/^\+/, "").split("").join("%")}%`;
  const { data, error } = await supabase
    .from("businesses")
    .select("*, business_capabilities(*)")
    .like("phone_number", pattern)
    .limit(5);

  if (error) {
    log.error("db_error", { operation: "lookupBusinessByPhone_recover", error: error.message });
    return null;
  }

  const matches = (data || []).filter((b) => normalizePhoneNumber(b.phone_number) === normalized);
  if (matches.length !== 1) {
    if (matches.length > 1) {
      log.error("business_phone_ambiguous", {
        operation: "lookupBusinessByPhone",
        phone: normalized,
        count: matches.length,
        severity: "warn",
      });
    }
    return null;
  }
  return matches[0];
}

/**
 * Look up a business by its Twilio phone number.
 * @param {string} twilioNumber - The "To" number from Twilio
 * @returns {Promise<object|null>} The business row or null
 */
export async function lookupBusinessByPhone(twilioNumber) {
  if (!supabase) return null;

  const normalized = normalizePhoneNumber(twilioNumber);
  const primary = normalized ?? (typeof twilioNumber === "string" ? twilioNumber : null);
  if (!primary) return null;

  const row = await selectBusinessByExactPhone(primary);
  if (row) return row;

  // A miss is already a broken call (the caller would hear the "our office"
  // default), so the extra round trip below costs nothing that was working.
  if (!normalized) return null;

  const recovered = await recoverBusinessByDamagedPhone(normalized);
  if (recovered) {
    log.error("business_phone_unnormalized", {
      operation: "lookupBusinessByPhone",
      businessId: recovered.id,
      phone: normalized,
      stored: JSON.stringify(recovered.phone_number),
      severity: "warn",
    });
  }
  return recovered;
}

/**
 * Insert a new call row.
 * @param {string} businessId
 * @param {string} callSid - Twilio Call SID
 * @param {string} callerNumber - From number
 * @param {string} twilioNumber - To number
 * @returns {Promise<string|null>} The new call's UUID or null on failure
 */
export async function createCall(businessId, callSid, callerNumber, twilioNumber) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("calls")
    .insert({
      business_id: businessId,
      twilio_call_sid: callSid,
      caller_number: callerNumber,
      twilio_number: twilioNumber,
    })
    .select("id")
    .single();
  if (error) {
    log.error("db_error", { callSid, operation: "createCall", error: error.message });
    captureException(new Error(error.message), { table: "calls", op: "insert" });
    return null;
  }
  return data.id;
}

/**
 * Insert a transcript entry.
 * @param {string} callId - DB call UUID
 * @param {string} speaker - 'caller' or 'ai'
 * @param {string} message - The transcript text
 * @param {number} sequence - Turn order number
 */
export async function addTranscriptEntry(callId, speaker, message, sequence) {
  if (!supabase) return;
  const { error } = await supabase
    .from("call_transcripts")
    .insert({ call_id: callId, speaker, message, sequence });
  if (error) {
    // callId (the DB call UUID) — NOT callSid: this function never receives a
    // Twilio Call SID, and referencing one here threw a ReferenceError that
    // replaced the real DB error before every call site's .catch() swallowed it.
    log.error("db_error", { callId, operation: "addTranscriptEntry", error: error.message });
  }
}

/**
 * Mark a call as completed (or other terminal status).
 * @param {string} callSid - Twilio Call SID
 * @param {string} status - Terminal status string
 * @param {number|null} durationSeconds - Call duration from Twilio
 */
export async function completeCall(callSid, status, durationSeconds) {
  if (!supabase) return;

  // ended_at/duration_seconds are written unconditionally — a transferred
  // call still ends and has a real duration, regardless of what happens to
  // the `status` column below.
  const timingUpdates = { ended_at: new Date().toISOString() };
  if (durationSeconds != null) {
    timingUpdates.duration_seconds = Number(durationSeconds);
  }
  const { error: timingError } = await supabase
    .from("calls")
    .update(timingUpdates)
    .eq("twilio_call_sid", callSid);
  if (timingError) {
    log.error("db_error", { callSid, operation: "completeCall_timing", error: timingError.message });
    captureException(new Error(timingError.message), { table: "calls", op: "update_complete_timing" });
  }

  // `status`: a single atomic UPDATE ... WHERE status <> 'transferred' —
  // NOT a separate SELECT-then-UPDATE (the prior implementation). That
  // read-then-write had a race window: a markCallTransferred() landing
  // between the SELECT and the UPDATE would get silently clobbered back to
  // `status` here — the exact bug this guard exists to prevent. A single
  // WHERE-guarded statement can't have that gap: Postgres serializes
  // concurrent UPDATEs to the same row, so whichever of this and
  // markCallTransferred() commits second always sees the other's already-
  // committed value, not a stale snapshot read earlier. Also saves a
  // round-trip on every terminal status callback.
  const { error: statusError } = await supabase
    .from("calls")
    .update({ status })
    .eq("twilio_call_sid", callSid)
    .neq("status", "transferred");
  if (statusError) {
    log.error("db_error", { callSid, operation: "completeCall_status", error: statusError.message });
    captureException(new Error(statusError.message), { table: "calls", op: "update_complete_status" });
  }
}

/**
 * Mark a call as transferred to a human. Kept distinct from completeCall so
 * a later Twilio "completed" status callback doesn't overwrite this — see
 * the transferred-status guard in completeCall above.
 * @param {string} callSid - Twilio Call SID
 */
export async function markCallTransferred(callSid) {
  if (!supabase) return;
  const { error } = await supabase
    .from("calls")
    .update({ status: "transferred" })
    .eq("twilio_call_sid", callSid);
  if (error) {
    log.error("db_error", { callSid, operation: "markCallTransferred", error: error.message });
    captureException(new Error(error.message), { table: "calls", op: "update_transferred" });
  }
}

/**
 * Fetch all transcript entries for a call, ordered by sequence.
 * @param {string} callId - DB call UUID
 * @returns {Promise<Array<{speaker: string, message: string, sequence: number}>>}
 */
export async function fetchCallTranscript(callId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("call_transcripts")
    .select("speaker, message, sequence")
    .eq("call_id", callId)
    .order("sequence", { ascending: true });
  if (error) {
    log.error("db_error", { operation: "fetchCallTranscript", error: error.message });
    return [];
  }
  return data || [];
}

/**
 * Update per-business notification settings (for dashboard API).
 * @param {string} businessId
 * @param {{ notification_email?: string | null, notification_phone?: string | null, notifications_enabled?: boolean }} payload
 * @returns {Promise<boolean>} true if update succeeded
 */
export async function updateBusinessNotificationSettings(businessId, payload) {
  if (!supabase || !businessId) return false;
  const updates = {};
  if (payload.notification_email !== undefined) updates.notification_email = payload.notification_email || null;
  if (payload.notification_phone !== undefined) updates.notification_phone = payload.notification_phone || null;
  if (payload.notifications_enabled !== undefined) updates.notifications_enabled = !!payload.notifications_enabled;
  if (Object.keys(updates).length === 0) return true;
  const { error } = await supabase
    .from("businesses")
    .update(updates)
    .eq("id", businessId);
  if (error) {
    log.error("db_error", { operation: "updateBusinessNotificationSettings", error: error.message });
    return false;
  }
  return true;
}

/**
 * Update a business's Twilio phone number (for buy-number API).
 * @param {string} businessId
 * @param {string} phoneNumber - E.164 phone number
 * @returns {Promise<boolean>} true if update succeeded
 */
export async function updateBusinessPhoneNumber(businessId, phoneNumber) {
  if (!supabase || !businessId) return false;
  // Normalize on write as well as in the DB trigger (migration 024): the
  // trigger is the backstop for hand-edits, this keeps the value the
  // application believes it stored identical to the value it will later match
  // against Twilio's `To`.
  const normalized = normalizePhoneNumber(phoneNumber);
  if (phoneNumber && !normalized) {
    log.error("business_phone_rejected", {
      operation: "updateBusinessPhoneNumber",
      businessId,
      reason: "not_e164",
      severity: "warn",
    });
    return false;
  }
  const { error } = await supabase
    .from("businesses")
    .update({ phone_number: normalized })
    .eq("id", businessId);
  if (error) {
    log.error("db_error", { operation: "updateBusinessPhoneNumber", error: error.message });
    return false;
  }
  return true;
}

/**
 * Update a call's summary, sentiment, and outcome after generation.
 * @param {string} callSid - Twilio Call SID
 * @param {string|null} summary
 * @param {string|null} sentiment
 * @param {string|null} outcome - One of CALL_OUTCOMES (e.g. general_inquiry, appointment, unknown)
 */
export async function updateCallSummary(callSid, summary, sentiment, outcome) {
  if (!supabase) return;
  const { error } = await supabase
    .from("calls")
    .update({ summary, sentiment, outcome: outcome ?? null })
    .eq("twilio_call_sid", callSid);
  if (error) {
    log.error("db_error", { callSid, operation: "updateCallSummary", error: error.message });
  }
}

/**
 * Write the per-call turn-latency rollup (computed from the in-process
 * metrics ring buffer — see lib/voice/metrics.js's getCallStats()).
 * @param {string} callSid
 * @param {number} avgMs
 * @param {number} p95Ms
 */
export async function updateCallLatency(callSid, avgMs, p95Ms) {
  if (!supabase) return;
  const { error } = await supabase
    .from("calls")
    .update({ avg_turn_latency_ms: avgMs, p95_turn_latency_ms: p95Ms })
    .eq("twilio_call_sid", callSid);
  if (error) {
    log.error("db_error", { callSid, operation: "updateCallLatency", error: error.message });
  }
}

/**
 * Create an appointment.
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} [params.callId]
 * @param {string} [params.serviceId]
 * @param {string} [params.clientName]
 * @param {string} [params.clientPhone]
 * @param {string} params.scheduledAt - ISO 8601 datetime
 * @param {string} [params.notes]
 * @returns {Promise<string|null>} The new appointment UUID or null
 */
export async function createAppointment({ businessId, callId, serviceId, clientName, clientPhone, scheduledAt, notes }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("appointments")
    .insert({
      business_id: businessId,
      call_id: callId || null,
      service_id: serviceId || null,
      client_name: clientName || null,
      client_phone: clientPhone || null,
      scheduled_at: scheduledAt,
      notes: notes || null,
    })
    .select("id")
    .single();
  if (error) {
    log.error("db_error", { operation: "createAppointment", error: error.message, code: error.code });
    captureException(new Error(error.message), { table: "appointments", op: "insert" });
    // Surface the failure (with the Postgres code) so the tool layer can
    // distinguish "slot already taken" (23505 unique violation) from a
    // generic write error. A silent null made both look identical.
    const e = new Error(error.message);
    e.code = error.code;
    throw e;
  }
  return data.id;
}

/**
 * Count SCHEDULED appointments overlapping the window a booking of `startISO`
 * would occupy. All slots share the business's configured length L, so two
 * bookings overlap iff their starts are less than L apart — i.e. existing
 * `scheduled_at ∈ (start - L, start + L)`. Used to decide whether a slot still
 * has capacity.
 *
 * Fails OPEN (returns 0) on a DB error: a read failure must not falsely block a
 * legitimate booking. The atomic RPC (createAppointmentIfAvailable) is the real
 * race-safe guarantee; this is for the pre-collection check and the caller tool.
 *
 * @param {string} businessId
 * @param {string} startISO - ISO 8601 instant
 * @param {number} lengthMinutes
 * @returns {Promise<number>}
 */
export async function countScheduledOverlapping(businessId, startISO, lengthMinutes) {
  if (!supabase || !businessId) return 0;
  const startMs = Date.parse(startISO);
  if (!Number.isFinite(startMs)) return 0;
  const L = (Number.isFinite(lengthMinutes) ? lengthMinutes : 30) * 60_000;
  const lo = new Date(startMs - L + 1).toISOString();
  const hi = new Date(startMs + L - 1).toISOString();
  const { count, error } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "scheduled")
    .gte("scheduled_at", lo)
    .lte("scheduled_at", hi);
  if (error) {
    log.error("db_error", { operation: "countScheduledOverlapping", error: error.message });
    return 0;
  }
  return count || 0;
}

/**
 * The start times of SCHEDULED appointments in [startISO, endISO) for a business
 * — used to enumerate a day and offer free alternatives without a query per
 * candidate slot.
 * @returns {Promise<Array<{scheduled_at: string}>>}
 */
export async function listScheduledBetween(businessId, startISO, endISO) {
  if (!supabase || !businessId) return [];
  const { data, error } = await supabase
    .from("appointments")
    .select("scheduled_at")
    .eq("business_id", businessId)
    .eq("status", "scheduled")
    .gte("scheduled_at", startISO)
    .lt("scheduled_at", endISO)
    .order("scheduled_at", { ascending: true });
  if (error) {
    log.error("db_error", { operation: "listScheduledBetween", error: error.message });
    return [];
  }
  return data || [];
}

/**
 * Atomically book only if the slot still has capacity. Delegates to the
 * `create_appointment_if_available` plpgsql function (migration 022), which
 * takes a per-(business, slot) advisory lock, re-counts overlaps under the lock,
 * and inserts only when `count < capacity`. This is what makes the check
 * race-safe: the app-level check can go stale between reading and writing; the
 * RPC cannot.
 *
 * @returns {Promise<{id: string}|{full: true}|null>} id on success, {full:true}
 *   when the slot filled, null on a hard error (caller falls back to a message).
 */
export async function createAppointmentIfAvailable(params) {
  if (!supabase) return null;
  const { businessId, callId, clientName, clientPhone, scheduledAt, notes, lengthMinutes, capacity } = params;
  const { data, error } = await supabase.rpc("create_appointment_if_available", {
    p_business_id: businessId,
    p_scheduled_at: scheduledAt,
    p_length_min: Number.isFinite(lengthMinutes) ? lengthMinutes : 30,
    p_capacity: Number.isFinite(capacity) ? capacity : 1,
    p_call_id: callId || null,
    p_client_name: clientName || null,
    p_client_phone: clientPhone || null,
    p_notes: notes || null,
  });
  if (error) {
    log.error("db_error", { operation: "createAppointmentIfAvailable", error: error.message, code: error.code });
    captureException(new Error(error.message), { table: "appointments", op: "rpc_book" });
    const e = new Error(error.message);
    e.code = error.code;
    throw e;
  }
  // The function returns the new uuid, or NULL when the slot is full.
  return data ? { id: data } : { full: true };
}

/**
 * List scheduled appointments for a caller by business, optional phone and name.
 * @param {string} businessId
 * @param {object} [opts]
 * @param {string} [opts.clientPhone] - Caller phone (matched after normalizing to digits)
 * @param {string} [opts.clientName] - Caller name (case-insensitive partial match)
 * @returns {Promise<Array<{id: string, client_name: string|null, client_phone: string|null, scheduled_at: string, status: string, notes: string|null}>>}
 */
export async function listAppointmentsByCaller(businessId, opts = {}) {
  if (!supabase || !businessId) return [];
  let q = supabase
    .from("appointments")
    .select("id, client_name, client_phone, scheduled_at, status, notes")
    .eq("business_id", businessId)
    .eq("status", "scheduled")
    .order("scheduled_at", { ascending: true });
  const phone = typeof opts.clientPhone === "string" ? opts.clientPhone.replace(/\D/g, "").trim() : "";
  const name = typeof opts.clientName === "string" ? opts.clientName.trim() : "";
  if (name) {
    q = q.ilike("client_name", `%${name.replace(/%/g, "\\%")}%`);
  }
  const { data: rows, error } = await q;
  if (error) {
    log.error("db_error", { operation: "listAppointmentsByCaller", error: error.message });
    return [];
  }
  const list = rows || [];
  if (phone) {
    return list.filter((r) => {
      const p = (r.client_phone || "").replace(/\D/g, "").trim();
      return p && p.slice(-10) === phone.slice(-10);
    });
  }
  return list;
}

/**
 * Fetch a single appointment by id (for the caller-identity guard before
 * cancel/reschedule — verifies the appointment actually belongs to the
 * caller before mutating it).
 * @param {string} appointmentId
 * @param {string} businessId - REQUIRED. The tenant filter is unconditional:
 *   an appointment UUID is not a secret, so a lookup without a business scope
 *   would read across every tenant in the table. Missing => no query at all.
 * @returns {Promise<{id: string, client_name: string|null, client_phone: string|null, scheduled_at: string, status: string, notes: string|null}|null>}
 */
export async function getAppointmentById(appointmentId, businessId) {
  if (!supabase || !appointmentId) return null;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "getAppointmentById", appointmentId });
    return null;
  }
  const q = supabase
    .from("appointments")
    .select("id, client_name, client_phone, scheduled_at, status, notes")
    .eq("id", appointmentId)
    .eq("business_id", businessId);
  const { data, error } = await q.maybeSingle();
  if (error) {
    log.error("db_error", { operation: "getAppointmentById", error: error.message });
    return null;
  }
  return data;
}

/**
 * Update an appointment's status (e.g. cancel).
 * @param {string} appointmentId
 * @param {string} status - e.g. 'cancelled'
 * @param {string} businessId - REQUIRED; the tenant filter is unconditional
 *   (see getAppointmentById). Missing => no query at all.
 * @returns {Promise<boolean>}
 */
export async function updateAppointmentStatus(appointmentId, status, businessId) {
  if (!supabase || !appointmentId) return false;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "updateAppointmentStatus", appointmentId });
    return false;
  }
  const q = supabase
    .from("appointments")
    .update({ status })
    .eq("id", appointmentId)
    .eq("business_id", businessId);
  const { data, error } = await q.select("id").maybeSingle();
  if (error) {
    log.error("db_error", { operation: "updateAppointmentStatus", error: error.message });
    return false;
  }
  return data != null;
}

/**
 * Update an appointment (e.g. reschedule).
 * @param {string} appointmentId
 * @param {object} updates - e.g. { scheduled_at: "2026-04-15T10:00:00" }
 * @param {string} businessId - REQUIRED; the tenant filter is unconditional
 *   (see getAppointmentById). Missing => no query at all.
 * @returns {Promise<boolean>}
 */
export async function updateAppointment(appointmentId, updates, businessId) {
  if (!supabase || !appointmentId || !updates || typeof updates !== "object") return false;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "updateAppointment", appointmentId });
    return false;
  }
  const q = supabase
    .from("appointments")
    .update(updates)
    .eq("id", appointmentId)
    .eq("business_id", businessId);
  const { data, error } = await q.select("id").maybeSingle();
  if (error) {
    log.error("db_error", { operation: "updateAppointment", error: error.message });
    return false;
  }
  return data != null;
}

/**
 * Create a customer request (message or callback) from the record_customer_request tool.
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} [params.callId]
 * @param {string} params.requestType - e.g. "message" or "callback"
 * @param {string} [params.callerName]
 * @param {string} [params.callbackNumber]
 * @param {string} [params.message]
 * @param {string} [params.preferredTime]
 * @param {string} [params.notes]
 * @returns {Promise<string|null>} The new customer_requests row id or null
 */
export async function createCustomerRequest({
  businessId,
  callId,
  requestType,
  callerName,
  callbackNumber,
  message,
  preferredTime,
  notes,
}) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("customer_requests")
    .insert({
      business_id: businessId,
      call_id: callId || null,
      request_type: requestType || "message",
      caller_name: callerName || null,
      callback_number: callbackNumber || null,
      message: message || null,
      preferred_time: preferredTime || null,
      notes: notes || null,
    })
    .select("id")
    .single();
  if (error) {
    log.error("db_error", { operation: "createCustomerRequest", error: error.message });
    captureException(new Error(error.message), { table: "customer_requests", op: "insert" });
    return null;
  }
  return data.id;
}

/**
 * Fetch caller context for personalization — recent call history and upcoming appointments.
 * Used to inject "returning caller" context into the AI prompt and to power
 * the dashboard caller profile view.
 * @param {string} businessId
 * @param {string} callerNumber - Caller's phone number (E.164)
 * @returns {Promise<{ callCount: number, lastCallSummary: string|null, upcomingAppointments: Array }>}
 */
export async function fetchCallerContext(businessId, callerNumber) {
  const empty = { callCount: 0, lastCallSummary: null, upcomingAppointments: [] };
  if (!supabase || !businessId || !callerNumber) return empty;

  // Run both queries in parallel
  const [callsResult, appointmentsResult] = await Promise.all([
    supabase
      .from("calls")
      .select("id, started_at, summary")
      .eq("business_id", businessId)
      .eq("caller_number", callerNumber)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(5),
    supabase
      .from("appointments")
      .select("id, client_name, scheduled_at, notes")
      .eq("business_id", businessId)
      .eq("client_phone", callerNumber)
      .eq("status", "scheduled")
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(5),
  ]);

  const calls = callsResult.data || [];
  const upcomingAppointments = appointmentsResult.data || [];
  const lastCallSummary = calls[0]?.summary || null;

  return { callCount: calls.length, lastCallSummary, upcomingAppointments };
}

/**
 * Fetch enabled business_knowledge entries for a business, ordered by priority DESC.
 * @param {string} businessId
 * @param {number} [limit=15] - Max entries to return
 * @returns {Promise<Array<{question: string, answer: string, category: string|null}>>}
 */
export async function fetchBusinessKnowledge(businessId, limit = 15) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("business_knowledge")
    .select("question, answer, category")
    .eq("business_id", businessId)
    .eq("enabled", true)
    .order("priority", { ascending: false })
    .limit(limit);
  if (error) {
    log.error("db_error", { operation: "fetchBusinessKnowledge", error: error.message });
    return [];
  }
  return data || [];
}

// ---------------------------------------------------------------------------
// Integrations (per-business: webhooks, athenahealth, mcp)
// ---------------------------------------------------------------------------

/**
 * Tool names an integration may not claim.
 *
 * Derived from the capability registry rather than hand-listed. The hand-listed
 * version reserved four names while capability packs declared twelve, so a
 * business could create a webhook called request_transfer, cancel_appointment_db
 * or get_caller_appointments and have it silently shadowed: the declaration
 * reached Gemini twice and services/tools.js dispatched the builtin, so the
 * operator's webhook never ran and never errored.
 *
 * Deriving it means the reservation list can no longer drift behind the packs —
 * a new capability's tools are protected the moment the pack is registered.
 *
 * set_call_intent and end_call are engine-owned (they drive the step machine
 * itself, not any capability) so they are named explicitly.
 */
export const BUILTIN_TOOL_NAMES = ["set_call_intent", "end_call", ...allCapabilityToolNames()];

/**
 * List all integrations for a business.
 * @param {string} businessId
 * @param {{ enabledOnly?: boolean }} [opts]
 * @returns {Promise<Array<{ id: string, business_id: string, provider: string, name: string, enabled: boolean, config: object, created_at: string, updated_at: string }>>}
 */
export async function listIntegrationsForBusiness(businessId, opts = {}) {
  if (!supabase || !businessId) return [];
  let query = supabase
    .from("integrations")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });
  if (opts.enabledOnly) {
    query = query.eq("enabled", true);
  }
  const { data, error } = await query;
  if (error) {
    log.error("db_error", { operation: "listIntegrationsForBusiness", error: error.message });
    return [];
  }
  return data || [];
}

/**
 * Get a single integration by business and tool name.
 * @param {string} businessId
 * @param {string} name - Tool name
 * @returns {Promise<{ id: string, business_id: string, provider: string, name: string, enabled: boolean, config: object } | null>}
 */
export async function getIntegrationByName(businessId, name) {
  if (!supabase || !businessId || !name) return null;
  const { data, error } = await supabase
    .from("integrations")
    .select("*")
    .eq("business_id", businessId)
    .eq("name", name)
    .maybeSingle();
  if (error) {
    log.error("db_error", { operation: "getIntegrationByName", error: error.message });
    return null;
  }
  return data;
}

/**
 * Create or update an integration (upsert by business_id + name).
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.provider - webhook | athenahealth | mcp
 * @param {string} params.name - Tool name (must not be a built-in tool name)
 * @param {object} params.config
 * @param {boolean} [params.enabled=true]
 * @returns {Promise<{ id: string } | null>}
 */
export async function createOrUpdateIntegration({
  businessId,
  provider,
  name,
  config,
  enabled = true,
}) {
  if (!supabase || !businessId || !provider || !name) return null;
  if (BUILTIN_TOOL_NAMES.includes(name)) {
    log.error("integration_invalid_name", { name, reason: "built_in_tool" });
    return null;
  }
  const now = new Date().toISOString();
  const payload = {
    business_id: businessId,
    provider,
    name,
    config: config || {},
    enabled: !!enabled,
    updated_at: now,
  };
  const { data, error } = await supabase
    .from("integrations")
    .upsert(payload, {
      onConflict: "business_id,name",
      ignoreDuplicates: false,
    })
    .select("id")
    .single();
  if (error) {
    log.error("db_error", { operation: "createOrUpdateIntegration", error: error.message });
    return null;
  }
  return data;
}

/**
 * Delete or soft-disable an integration.
 * @param {string} businessId
 * @param {string} integrationId
 * @param {{ softDisable?: boolean }} [opts] - If true, set enabled=false instead of delete
 * @returns {Promise<boolean>}
 */
export async function deleteIntegration(businessId, integrationId, opts = {}) {
  if (!supabase || !businessId || !integrationId) return false;
  if (opts.softDisable) {
    const { error } = await supabase
      .from("integrations")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("id", integrationId)
      .eq("business_id", businessId);
    if (error) {
      log.error("db_error", { operation: "deleteIntegration_softDisable", error: error.message });
      return false;
    }
    return true;
  }
  const { error } = await supabase
    .from("integrations")
    .delete()
    .eq("id", integrationId)
    .eq("business_id", businessId);
  if (error) {
    log.error("db_error", { operation: "deleteIntegration", error: error.message });
    return false;
  }
  return true;
}
