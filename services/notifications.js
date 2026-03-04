import { Resend } from "resend";
import twilio from "twilio";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import * as db from "./supabase.js";

const NOTIFICATIONS_ENABLED = process.env.NOTIFICATIONS_ENABLED === "true";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "notifications@onboarding.resend.dev";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM;

const RATE_LIMIT_PER_MINUTE = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** @type {Resend | null} */
let resendClient = null;
/** @type {ReturnType<typeof twilio> | null} */
let twilioClient = null;

if (RESEND_API_KEY) {
  resendClient = new Resend(RESEND_API_KEY);
}
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateLimitByBusiness = new Map();

function checkRateLimit(businessId) {
  const now = Date.now();
  let entry = rateLimitByBusiness.get(businessId);
  if (!entry) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitByBusiness.set(businessId, entry);
  }
  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  if (entry.count >= RATE_LIMIT_PER_MINUTE) return false;
  entry.count += 1;
  return true;
}

/**
 * Load notification targets and enabled flag for a business.
 * @param {string} businessId
 * @returns {Promise<{ email: string | null, phone: string | null, businessName: string } | null>}
 */
export async function loadBusinessNotificationConfig(businessId) {
  if (!db.isEnabled() || !businessId) return null;
  const business = await db.fetchBusinessById(businessId);
  if (!business) return null;
  if (business.notifications_enabled === false) return null;
  const email = typeof business.notification_email === "string" && business.notification_email.trim()
    ? business.notification_email.trim()
    : null;
  const phone = typeof business.notification_phone === "string" && business.notification_phone.trim()
    ? business.notification_phone.trim()
    : null;
  if (!email && !phone) return null;
  return {
    email,
    phone,
    businessName: business.name || "Business",
  };
}

/**
 * Send an email. Logs errors; never throws.
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 */
async function sendEmail({ to, subject, text, html }) {
  if (!resendClient) return;
  try {
    const { error } = await resendClient.emails.send({
      from: RESEND_FROM_EMAIL,
      to,
      subject,
      html: html || text.replace(/\n/g, "<br>\n"),
    });
    if (error) {
      log("error", { message: "Resend send failed", code: "notification_email", error: error.message });
      captureException(new Error(`Resend: ${error.message}`), { to, subject });
    }
  } catch (err) {
    log("error", { message: err?.message, code: "notification_email" });
    captureException(err, { to, subject });
  }
}

/**
 * Send an SMS. Logs errors; never throws.
 * @param {{ to: string, body: string }} opts
 */
async function sendSms({ to, body }) {
  if (!twilioClient || !TWILIO_SMS_FROM) return;
  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_SMS_FROM,
      body,
    });
  } catch (err) {
    log("error", { message: err?.message, code: "notification_sms" });
    captureException(err, { to });
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatAppointmentEmail(appointment, call, businessName) {
  const d = appointment.scheduled_at ? new Date(appointment.scheduled_at).toLocaleString() : "—";
  const client = appointment.client_name || appointment.client_phone || "—";
  const notes = appointment.notes ? `\nNotes: ${appointment.notes}` : "";
  return (
    `${businessName}\n\nNew appointment booked.\n\n` +
    `Scheduled: ${d}\n` +
    `Client: ${client}\n` +
    `Phone: ${call?.callerNumber || "—"}${notes}`
  );
}

function formatAppointmentSms(appointment, call) {
  const d = appointment.scheduled_at ? new Date(appointment.scheduled_at).toLocaleString() : "—";
  const from = call?.callerNumber || "caller";
  return `New appointment ${d} from ${from}.`;
}

function formatCustomerRequestEmail(customerRequest, businessName) {
  const type = customerRequest.request_type || "message";
  const name = customerRequest.caller_name || "—";
  const number = customerRequest.callback_number || "—";
  const msg = customerRequest.message ? `\nMessage: ${customerRequest.message}` : "";
  const time = customerRequest.preferred_time ? `\nPreferred time: ${customerRequest.preferred_time}` : "";
  return (
    `${businessName}\n\nNew customer ${type}.\n\n` +
    `From: ${name}\n` +
    `Callback number: ${number}${msg}${time}`
  );
}

function formatCustomerRequestSms(customerRequest, call) {
  const type = customerRequest.request_type || "message";
  const from = call?.callerNumber || customerRequest.callback_number || "caller";
  const short = customerRequest.message ? customerRequest.message.slice(0, 60) + (customerRequest.message.length > 60 ? "…" : "") : "";
  return `New ${type} from ${from}${short ? ": " + short : "."}`;
}

function formatMissedCallEmail(call, status, businessName) {
  return (
    `${businessName}\n\nMissed call.\n\n` +
    `From: ${call?.callerNumber || "—"}\n` +
    `To: ${call?.twilioNumber || "—"}\n` +
    `Status: ${status}\n` +
    `Time: ${new Date().toISOString()}`
  );
}

function formatMissedCallSms(call, status) {
  const from = call?.callerNumber || "unknown";
  const to = call?.twilioNumber || "your number";
  return `Missed call from ${from} to ${to} (${status}).`;
}

function formatCallSummaryEmail(call, summary, sentiment, outcome, businessName) {
  return (
    `${businessName}\n\nCall summary.\n\n` +
    `Outcome: ${outcome || "—"}\n` +
    `Sentiment: ${sentiment || "—"}\n\n` +
    `Summary:\n${summary || "—"}\n\n` +
    `Caller: ${call?.callerNumber || "—"}\n` +
    `Time: ${call?.endedAt ? new Date(call.endedAt).toISOString() : "—"}`
  );
}

function formatCallSummarySms(outcome) {
  return `Call summary: ${outcome || "completed"}.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notify when an appointment is booked.
 * @param {{ businessId: string, appointment: { scheduled_at: string, client_name?: string, client_phone?: string, notes?: string }, call?: { callerNumber?: string, twilioNumber?: string } }} opts
 */
export async function notifyAppointmentBooked({ businessId, appointment, call }) {
  if (!NOTIFICATIONS_ENABLED || !appointment) return;
  try {
    if (!checkRateLimit(businessId)) return;
    const config = await loadBusinessNotificationConfig(businessId);
    if (!config) return;
    const subject = `New appointment: ${appointment.scheduled_at ? new Date(appointment.scheduled_at).toLocaleString() : "—"} — ${appointment.client_name || appointment.client_phone || "caller"}`;
    const body = formatAppointmentEmail(appointment, call, config.businessName);
    if (config.email) await sendEmail({ to: config.email, subject, text: body });
    if (config.phone) await sendSms({ to: config.phone, body: formatAppointmentSms(appointment, call) });
  } catch (err) {
    log("error", { message: err?.message, code: "notify_appointment" });
    captureException(err, { businessId });
  }
}

/**
 * Notify when a customer request (message/callback) is created.
 * @param {{ businessId: string, customerRequest: { request_type?: string, caller_name?: string, callback_number?: string, message?: string, preferred_time?: string }, call?: { callerNumber?: string } }} opts
 */
export async function notifyCustomerRequest({ businessId, customerRequest, call }) {
  if (!NOTIFICATIONS_ENABLED || !customerRequest) return;
  try {
    if (!checkRateLimit(businessId)) return;
    const config = await loadBusinessNotificationConfig(businessId);
    if (!config) return;
    const subject = "New customer message/callback request";
    const body = formatCustomerRequestEmail(customerRequest, config.businessName);
    if (config.email) await sendEmail({ to: config.email, subject, text: body });
    if (config.phone) await sendSms({ to: config.phone, body: formatCustomerRequestSms(customerRequest, call) });
  } catch (err) {
    log("error", { message: err?.message, code: "notify_customer_request" });
    captureException(err, { businessId });
  }
}

/**
 * Notify when a call is missed / failed / no-answer.
 * @param {{ businessId: string, call?: { callerNumber?: string, twilioNumber?: string }, status: string }} opts
 */
export async function notifyCallMissed({ businessId, call, status }) {
  if (!NOTIFICATIONS_ENABLED) return;
  try {
    if (!checkRateLimit(businessId)) return;
    const config = await loadBusinessNotificationConfig(businessId);
    if (!config) return;
    const subject = `Missed call from ${call?.callerNumber || "unknown"}`;
    const body = formatMissedCallEmail(call, status, config.businessName);
    if (config.email) await sendEmail({ to: config.email, subject, text: body });
    if (config.phone) await sendSms({ to: config.phone, body: formatMissedCallSms(call, status) });
  } catch (err) {
    log("error", { message: err?.message, code: "notify_call_missed" });
    captureException(err, { businessId });
  }
}

/**
 * Notify when a call completes and summary is ready.
 * @param {{ businessId: string, call?: { callerNumber?: string, endedAt?: string }, summary: string | null, sentiment: string | null, outcome: string | null }} opts
 */
export async function notifyCallCompleted({ businessId, call, summary, sentiment, outcome }) {
  if (!NOTIFICATIONS_ENABLED) return;
  try {
    if (!checkRateLimit(businessId)) return;
    const config = await loadBusinessNotificationConfig(businessId);
    if (!config) return;
    const subject = `Call summary: ${outcome || "completed"}`;
    const body = formatCallSummaryEmail(call, summary, sentiment, outcome, config.businessName);
    if (config.email) await sendEmail({ to: config.email, subject, text: body });
    if (config.phone) await sendSms({ to: config.phone, body: formatCallSummarySms(outcome) });
  } catch (err) {
    log("error", { message: err?.message, code: "notify_call_completed" });
    captureException(err, { businessId });
  }
}
