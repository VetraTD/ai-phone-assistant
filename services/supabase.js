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
 * Update a call's summary and sentiment after generation.
 * @param {string} callSid - Twilio Call SID
 * @param {string|null} summary
 * @param {string|null} sentiment
 */
export async function updateCallSummary(callSid, summary, sentiment) {
  if (!supabase) return;
  const { error } = await supabase
    .from("calls")
    .update({ summary, sentiment })
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
