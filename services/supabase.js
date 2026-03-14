import { createClient } from "@supabase/supabase-js";
import { captureException } from "../lib/sentry.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
  console.warn("SUPABASE_URL or SUPABASE_SERVICE_KEY not set — DB persistence disabled");
}

/** @returns {boolean} Whether the Supabase client is configured */
export function isEnabled() {
  return supabase !== null;
}

// ---------------------------------------------------------------------------
// Per-business config
// ---------------------------------------------------------------------------

const DEFAULT_GREETING = "Hi, how can I help you today?";

/** All task keys the app supports. DB allowed_tasks are filtered to this set. */
export const SUPPORTED_TASKS = [
  "appointments",
  "book_appointment",
  "general_question",
  "take_message",
  "callback_request",
  "check_appointment",
  "cancel_reschedule",
  "quote_request",
  "directions_location",
  "form_document_request",
];

const DEFAULT_ALLOWED_TASKS = ["book_appointment", "general_question"];

/** When "appointments" is present, it expands to book, check, cancel_reschedule for internal use. */
const APPOINTMENTS_EXPAND = ["book_appointment", "check_appointment", "cancel_reschedule"];

function normalizeAllowedTasks(raw) {
  if (!Array.isArray(raw)) return DEFAULT_ALLOWED_TASKS;
  const filtered = raw.filter((t) => typeof t === "string" && SUPPORTED_TASKS.includes(t));
  if (filtered.length === 0) return DEFAULT_ALLOWED_TASKS;
  const expanded = filtered.includes("appointments")
    ? [...filtered.filter((t) => t !== "appointments"), ...APPOINTMENTS_EXPAND]
    : filtered;
  return [...new Set(expanded)];
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
export function loadConfig(business) {
  if (!business) {
    return {
      businessName: "our office",
      greeting: DEFAULT_GREETING,
      _hasCustomGreeting: false,
      timezone: process.env.TIMEZONE || "America/Chicago",
      businessHours: null,
      transferPhoneNumber: null,
      allowedTasks: DEFAULT_ALLOWED_TASKS,
      voiceStyle: null,
      mainPhone: null,
      generalInfo: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      stateRegion: null,
      postalCode: null,
      country: null,
      businessSummary: null,
      recordingDisclosureEnabled: false,
      recordingDisclosureText: null,
      offLimitsTopics: [],
      afterHoursPolicy: "take_message",
      escalationMessage: null,
      bookingPolicy: null,
      transferPolicy: "always",
      staffNames: [],
      serviceArea: null,
      services: [],
      languagesSpoken: ["en"],
      bookingUrl: null,
      callerDataPolicy: null,
      ttsVoice: "Polly.Joanna",
    bargeIn: false,
    };
  }

  const afterHoursPolicy = AFTER_HOURS_POLICIES.includes(business.after_hours_policy)
    ? business.after_hours_policy
    : "take_message";
  const transferPolicy = TRANSFER_POLICIES.includes(business.transfer_policy)
    ? business.transfer_policy
    : "always";

  return {
    businessName: business.name || "our office",
    greeting: business.greeting || DEFAULT_GREETING,
    _hasCustomGreeting: !!business.greeting,
    timezone: business.timezone || process.env.TIMEZONE || "America/Chicago",
    businessHours: business.business_hours || null,
    transferPhoneNumber: business.transfer_phone_number || null,
    allowedTasks: normalizeAllowedTasks(business.allowed_tasks),
    voiceStyle: business.voice_style || null,
    mainPhone: business.main_phone || null,
    generalInfo: business.general_info || null,
    addressLine1: business.address_line1 || null,
    addressLine2: business.address_line2 || null,
    city: business.city || null,
    stateRegion: business.state_region || null,
    postalCode: business.postal_code || null,
    country: business.country || null,
    businessSummary: business.business_summary || null,
    recordingDisclosureEnabled: !!business.recording_disclosure_enabled,
    recordingDisclosureText: business.recording_disclosure_text || null,
    offLimitsTopics: Array.isArray(business.off_limits_topics) ? business.off_limits_topics : [],
    afterHoursPolicy,
    escalationMessage: business.escalation_message || null,
    bookingPolicy: business.booking_policy || null,
    transferPolicy,
    staffNames: Array.isArray(business.staff_names) ? business.staff_names : [],
    serviceArea: business.service_area || null,
    services: Array.isArray(business.services) ? business.services : [],
    languagesSpoken: Array.isArray(business.languages_spoken) ? business.languages_spoken : ["en"],
    bookingUrl: business.booking_url || null,
    callerDataPolicy: business.caller_data_policy || null,
    ttsVoice: business.tts_voice || "Polly.Joanna",
    bargeIn: !!business.barge_in,
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
    console.error("fetchBusinessById error:", error.message);
    return null;
  }
  return data;
}

/**
 * Look up a business by its Twilio phone number.
 * @param {string} twilioNumber - The "To" number from Twilio
 * @returns {Promise<object|null>} The business row or null
 */
export async function lookupBusinessByPhone(twilioNumber) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("phone_number", twilioNumber)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("lookupBusinessByPhone error:", error.message);
    return null;
  }
  return data;
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
    console.error("createCall error:", error.message);
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
    console.error("addTranscriptEntry error:", error.message);
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
  const updates = {
    status,
    ended_at: new Date().toISOString(),
  };
  if (durationSeconds != null) {
    updates.duration_seconds = Number(durationSeconds);
  }
  const { error } = await supabase
    .from("calls")
    .update(updates)
    .eq("twilio_call_sid", callSid);
  if (error) {
    console.error("completeCall error:", error.message);
    captureException(new Error(error.message), { table: "calls", op: "update_complete" });
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
    console.error("fetchCallTranscript error:", error.message);
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
    console.error("updateBusinessNotificationSettings error:", error.message);
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
  const { error } = await supabase
    .from("businesses")
    .update({ phone_number: phoneNumber || null })
    .eq("id", businessId);
  if (error) {
    console.error("updateBusinessPhoneNumber error:", error.message);
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
    console.error("updateCallSummary error:", error.message);
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
    console.error("createAppointment error:", error.message);
    captureException(new Error(error.message), { table: "appointments", op: "insert" });
    return null;
  }
  return data.id;
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
    console.error("listAppointmentsByCaller error:", error.message);
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
 * Update an appointment's status (e.g. cancel).
 * @param {string} appointmentId
 * @param {string} status - e.g. 'cancelled'
 * @param {string} [businessId] - If provided, restricts update to this business
 * @returns {Promise<boolean>}
 */
export async function updateAppointmentStatus(appointmentId, status, businessId) {
  if (!supabase || !appointmentId) return false;
  let q = supabase.from("appointments").update({ status }).eq("id", appointmentId);
  if (businessId) q = q.eq("business_id", businessId);
  const { data, error } = await q.select("id").maybeSingle();
  if (error) {
    console.error("updateAppointmentStatus error:", error.message);
    return false;
  }
  return data != null;
}

/**
 * Update an appointment (e.g. reschedule).
 * @param {string} appointmentId
 * @param {object} updates - e.g. { scheduled_at: "2026-04-15T10:00:00" }
 * @param {string} [businessId] - If provided, restricts update to this business
 * @returns {Promise<boolean>}
 */
export async function updateAppointment(appointmentId, updates, businessId) {
  if (!supabase || !appointmentId || !updates || typeof updates !== "object") return false;
  let q = supabase.from("appointments").update(updates).eq("id", appointmentId);
  if (businessId) q = q.eq("business_id", businessId);
  const { data, error } = await q.select("id").maybeSingle();
  if (error) {
    console.error("updateAppointment error:", error.message);
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
    console.error("createCustomerRequest error:", error.message);
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
    console.error("fetchBusinessKnowledge error:", error.message);
    return [];
  }
  return data || [];
}

// ---------------------------------------------------------------------------
// Integrations (per-business: webhooks, athenahealth, mcp)
// ---------------------------------------------------------------------------

/** Built-in tool names — integration names must not collide with these. */
export const BUILTIN_TOOL_NAMES = [
  "set_call_intent",
  "end_call",
  "book_appointment",
  "record_customer_request",
];

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
    console.error("listIntegrationsForBusiness error:", error.message);
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
    console.error("getIntegrationByName error:", error.message);
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
    console.error("createOrUpdateIntegration: name cannot be a built-in tool:", name);
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
    console.error("createOrUpdateIntegration error:", error.message);
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
      console.error("deleteIntegration softDisable error:", error.message);
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
    console.error("deleteIntegration error:", error.message);
    return false;
  }
  return true;
}
