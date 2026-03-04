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

const DEFAULT_GREETING = "Hi, this is your AI receptionist. How can I help you today?";

/** All task keys the app supports. DB allowed_tasks are filtered to this set. */
export const SUPPORTED_TASKS = [
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

function normalizeAllowedTasks(raw) {
  if (!Array.isArray(raw)) return DEFAULT_ALLOWED_TASKS;
  const filtered = raw.filter((t) => typeof t === "string" && SUPPORTED_TASKS.includes(t));
  return filtered.length > 0 ? filtered : DEFAULT_ALLOWED_TASKS;
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
