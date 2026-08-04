import nodemailer from "nodemailer";
import twilio from "twilio";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import { isValidE164 } from "../lib/validate.js";
import { formatLocalDateTime } from "../lib/capabilities/datetime.js";
import * as db from "./supabase.js";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM;

const HAS_EMAIL_CREDS = !!(SMTP_USER && SMTP_PASS);
// Exported (read-only) so callers can cheaply short-circuit before doing
// any DB work for an SMS-only feature when Twilio SMS isn't configured at
// all (e.g. server.js's missed-call text-back — no point looking up the
// business by phone if sendCallerSms is guaranteed to no-op afterward).
export const HAS_SMS_CREDS = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_SMS_FROM);

// Notifications are ON BY DEFAULT as soon as either delivery channel (SMTP
// email or Twilio SMS) is configured — no opt-in env var required anymore.
// Set NOTIFICATIONS_ENABLED=false to force notifications off regardless of
// configured credentials (e.g. for local dev). Per-business
// businesses.notifications_enabled (see loadBusinessNotificationConfig)
// still gates delivery per tenant on top of this global switch. Exported
// (read-only) so tests can assert the computed gate value directly across
// env-var combinations without needing to observe side effects.
export const NOTIFICATIONS_ENABLED =
  process.env.NOTIFICATIONS_ENABLED !== "false" && (HAS_EMAIL_CREDS || HAS_SMS_CREDS);

const RATE_LIMIT_PER_MINUTE = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** @type {import("nodemailer").Transporter | null} */
let mailTransport = null;
/** @type {ReturnType<typeof twilio> | null} */
let twilioClient = null;

if (HAS_EMAIL_CREDS) {
  mailTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false" },
  });
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
    // Carried so owner-facing notifications can state the appointment time in
    // the BUSINESS's clock. Without it the formatters fell through to
    // toLocaleString() with no zone, which renders in whatever timezone the
    // Node process happens to run in — so an owner in London could be emailed
    // a time in the server's zone and have no way to tell.
    timezone: business.timezone || null,
  };
}

/**
 * Send an email via SMTP (e.g. Gmail). Logs errors; never throws.
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 */
async function sendEmail({ to, subject, text, html }) {
  if (!mailTransport) return;
  try {
    await mailTransport.sendMail({
      from: SMTP_FROM_EMAIL,
      to,
      subject,
      text,
      html: html || text.replace(/\n/g, "<br>\n"),
    });
  } catch (err) {
    log.error("notification_email", { message: err?.message });
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
    log.error("notification_sms", { message: err?.message });
    captureException(err, { to });
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Owner-facing appointment time, in the business's own timezone.
 *
 * These formatters used bare toLocaleString(), which takes the PROCESS zone.
 * The stored value is a UTC instant, so a UK clinic on a US-hosted server was
 * emailed times hours away from the ones its assistant had spoken to the
 * caller — the same class of defect as the read-back bug, pointed at the owner
 * instead of the caller.
 * @param {string|null|undefined} scheduledAt
 * @param {string|null|undefined} timezone
 * @returns {string}
 */
function ownerDateTime(scheduledAt, timezone) {
  if (!scheduledAt) return "—";
  return formatLocalDateTime(scheduledAt, timezone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAppointmentEmail(appointment, call, businessName, timezone) {
  const d = ownerDateTime(appointment.scheduled_at, timezone);
  const client = appointment.client_name || appointment.client_phone || "—";
  const notes = appointment.notes ? `\nNotes: ${appointment.notes}` : "";
  return (
    `${businessName}\n\nNew appointment booked.\n\n` +
    `Scheduled: ${d}\n` +
    `Client: ${client}\n` +
    `Phone: ${call?.callerNumber || "—"}${notes}`
  );
}

function formatAppointmentSms(appointment, call, timezone) {
  const d = ownerDateTime(appointment.scheduled_at, timezone);
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
    const subject = `New appointment: ${ownerDateTime(appointment.scheduled_at, config.timezone)} — ${appointment.client_name || appointment.client_phone || "caller"}`;
    const body = formatAppointmentEmail(appointment, call, config.businessName, config.timezone);
    if (config.email) await sendEmail({ to: config.email, subject, text: body });
    if (config.phone)
      await sendSms({ to: config.phone, body: formatAppointmentSms(appointment, call, config.timezone) });
  } catch (err) {
    log.error("notify_appointment", { message: err?.message });
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
    log.error("notify_customer_request", { message: err?.message });
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
    log.error("notify_call_missed", { message: err?.message });
    captureException(err, { businessId });
  }
}

// ---------------------------------------------------------------------------
// Caller-facing SMS follow-ups (Part 2) — distinct from the owner-facing
// notifyXxx() functions above: these text the CALLER back, gated per
// business on config.smsFollowupEnabled (see loadConfig in
// services/supabase.js). Off by default.
// ---------------------------------------------------------------------------

// Generic "someone will get back to you {sla}" text for the message_received
// caller text-back. Single source of truth — session.js, mediaStream.js,
// and server.js's degraded-mode voicemail webhook all import this instead
// of each declaring/duplicating their own copy of the literal.
export const MESSAGE_SLA_TEXT = "as soon as possible";

/** Default caller SMS templates, keyed by kind. Overridable per business via
 * businesses.sms_templates (loadConfig's config.smsTemplates). */
export const DEFAULT_SMS_TEMPLATES = {
  appointment_confirmation:
    "Hi {name}, your appointment with {business} is confirmed for {datetime}. Reply to this number if you need to change it.",
  message_received:
    "Hi{name_part}, we got your message at {business} — someone will get back to you {sla}. Thanks for calling!",
  missed_call:
    "Sorry we missed your call at {business}! Reply here or call back anytime and we'll help you right away.",
};

/** Replace {key} placeholders in a template with vars[key] (blank if missing). */
function interpolateTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const val = vars?.[key];
    return val != null ? String(val) : "";
  });
}

/**
 * Text the CALLER (not the business owner) a follow-up SMS. Gated on
 * businessConfig.smsFollowupEnabled and a valid, non-anonymous caller
 * number — Twilio reports withheld/blocked caller IDs as non-E.164 strings
 * (e.g. "anonymous"), which isValidE164 already rejects. Never throws.
 *
 * @param {object} businessConfig - loadConfig() output for the business
 * @param {string} toNumber - caller's number (state.callerNumber / req.body.From)
 * @param {"appointment_confirmation"|"message_received"|"missed_call"} kind
 * @param {Record<string, string>} [vars] - template placeholder values
 */
export async function sendCallerSms(businessConfig, toNumber, kind, vars = {}) {
  if (!businessConfig?.smsFollowupEnabled) return;
  if (!isValidE164(toNumber)) return;
  const template = DEFAULT_SMS_TEMPLATES[kind];
  if (!template) {
    log.error("sms_followup_unknown_kind", { message: `sendCallerSms: unknown kind "${kind}"` });
    return;
  }
  try {
    const overrides = businessConfig.smsTemplates || {};
    const chosen = typeof overrides[kind] === "string" && overrides[kind].trim() ? overrides[kind] : template;
    await sendSms({ to: toNumber, body: interpolateTemplate(chosen, vars) });
  } catch (err) {
    log.error("sms_followup_failed", { message: err?.message, kind });
    captureException(err, { toNumber, kind });
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
    log.error("notify_call_completed", { message: err?.message });
    captureException(err, { businessId });
  }
}
