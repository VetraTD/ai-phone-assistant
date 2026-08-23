import nodemailer from "nodemailer";
import twilio from "twilio";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import { isValidE164 } from "../lib/validate.js";
import { normalizePhoneNumber } from "../lib/phone.js";
import { smsTemplateProblem } from "../lib/smsConsent.js";
import * as db from "./db.js";

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
    // Kept on the config even though A1.3's link-only bodies no longer print a
    // time. It was added to fix a real defect — the formatters used bare
    // toLocaleString(), which renders in the Node process's zone, so a UK clinic
    // on a US-hosted server was emailed times hours off the ones its assistant
    // had spoken aloud. Anything that renders a business-local time in future
    // needs this, and rediscovering that lesson is more expensive than a field.
    timezone: business.timezone || null,
  };
}

/**
 * Send an email via SMTP (e.g. Gmail). Logs errors; never throws.
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 */
async function sendEmail({ to, subject, text, html }) {
  if (!mailTransport) {
    // A caller reaching here has a business row asking for email. The boot
    // check cannot see that — it only knows the env — so the drop is reported
    // where it happens. Neither `to` nor `subject` is logged: both identify a
    // person, and reporting one PHI leak must not open a second.
    log.error("notification_dropped", { channel: "email", reason: "smtp_not_configured" });
    return;
  }
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
    // No `to` and no `subject`: a recipient address and a subject line that
    // named a patient and an appointment time. lib/sentry.js would drop them
    // now, but a leak the call site never produces cannot depend on that.
    captureException(err, { context: "notifications.sendEmail" });
  }
}

/**
 * Send an SMS. Logs errors; never throws.
 * @param {{ to: string, body: string }} opts
 */
async function sendSms({ to, body }) {
  if (!twilioClient || !TWILIO_SMS_FROM) {
    log.error("notification_dropped", {
      channel: "sms",
      reason: !twilioClient ? "twilio_sms_not_configured" : "twilio_sms_from_missing",
    });
    return;
  }
  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_SMS_FROM,
      body,
    });
  } catch (err) {
    log.error("notification_sms", { message: err?.message });
    captureException(err, { context: "notifications.sendSms" });
  }
}

// ---------------------------------------------------------------------------
// Formatters — link-only, by design
// ---------------------------------------------------------------------------
//
// These used to carry the patient's name, their phone number, the appointment
// time, free-text notes and the AI's summary of the call, in the body AND in
// the subject line. The subject is the worse of the two: it survives in
// notification previews on a lock screen, in mail-server logs, and in anything
// that indexes headers without touching bodies.
//
// Email and SMS are not covered channels. The relay, the inbox provider and the
// carrier are all third parties with no BAA. The choice is either to negotiate
// BAAs down a delivery path whose entire job is to say "something happened, go
// look", or to stop putting anything in it worth protecting. The second is
// cheaper, stronger, and removes email from HIPAA scope altogether.
//
// What is left is deliberately the minimum that makes the message worth opening:
// which business, what KIND of thing happened, and where to go. None of it
// identifies a person.
//   - the business name is the recipient's own name, not a disclosure;
//   - "an appointment was booked" identifies no individual;
//   - a Twilio call status ("no-answer", "busy") is carrier metadata.
// Anything finer-grained than that stays in the dashboard, behind auth.

// No default. A hardcoded fallback URL is how a notification quietly starts
// pointing somewhere wrong; if it is not configured, the message says to open
// the dashboard without pretending to know where that is. lib/bootChecks.js
// announces the absence at boot.
const DASHBOARD_URL = process.env.DASHBOARD_URL || null;

function ownerEmailBody(businessName, sentence) {
  const where = DASHBOARD_URL
    ? `Open your Vetra dashboard for the details:
${DASHBOARD_URL}`
    : "Open your Vetra dashboard for the details.";
  return (
    `${businessName}

${sentence}

${where}

` +
    "This message contains no caller or patient information by design — email is " +
    "not a private channel, so the details stay in Vetra."
  );
}

function ownerSmsBody(businessName, sentence) {
  const where = DASHBOARD_URL ? ` Details: ${DASHBOARD_URL}` : " Details in your Vetra dashboard.";
  return `Vetra — ${businessName}: ${sentence}${where}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notify when an appointment is booked.
 * @param {{ businessId: string, appointment: { scheduled_at: string, client_name?: string, client_phone?: string, notes?: string }, call?: { callerNumber?: string, twilioNumber?: string } }} opts
 */
export async function notifyAppointmentBooked({ businessId, appointment }) {
  if (!NOTIFICATIONS_ENABLED || !appointment) return;
  try {
    if (!checkRateLimit(businessId)) return;
    const config = await loadBusinessNotificationConfig(businessId);
    if (!config) return;
    const sentence = "A new appointment was booked.";
    const subject = `New appointment — ${config.businessName}`;
    if (config.email) await sendEmail({ to: config.email, subject, text: ownerEmailBody(config.businessName, sentence) });
    if (config.phone) await sendSms({ to: config.phone, body: ownerSmsBody(config.businessName, sentence) });
  } catch (err) {
    log.error("notify_appointment", { message: err?.message });
    captureException(err, { businessId });
  }
}

/**
 * Notify when a customer request (message/callback) is created.
 * @param {{ businessId: string, customerRequest: { request_type?: string, caller_name?: string, callback_number?: string, message?: string, preferred_time?: string }, call?: { callerNumber?: string } }} opts
 */
export async function notifyCustomerRequest({ businessId, customerRequest }) {
  if (!NOTIFICATIONS_ENABLED || !customerRequest) return;
  try {
    if (!checkRateLimit(businessId)) return;
    const config = await loadBusinessNotificationConfig(businessId);
    if (!config) return;
    const sentence = "A caller left a message or a callback request.";
    const subject = `New customer request — ${config.businessName}`;
    if (config.email) await sendEmail({ to: config.email, subject, text: ownerEmailBody(config.businessName, sentence) });
    if (config.phone) await sendSms({ to: config.phone, body: ownerSmsBody(config.businessName, sentence) });
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
    // `status` is a Twilio call disposition, not health information, and it is
    // the one thing that tells an owner whether to change something.
    const sentence = `A call was missed (${status}).`;
    const subject = `Missed call — ${config.businessName}`;
    if (config.email) await sendEmail({ to: config.email, subject, text: ownerEmailBody(config.businessName, sentence) });
    if (config.phone) await sendSms({ to: config.phone, body: ownerSmsBody(config.businessName, sentence) });
  } catch (err) {
    log.error("notify_call_missed", { message: err?.message });
    captureException(err, { businessId });
  }
}

// ---------------------------------------------------------------------------
// Caller-facing SMS follow-ups (Part 2) — distinct from the owner-facing
// notifyXxx() functions above: these text the CALLER back, gated per
// business on config.smsFollowupEnabled (see loadConfig in
// services/db.js). Off by default.
// ---------------------------------------------------------------------------

// Generic "someone will get back to you {sla}" text for the message_received
// caller text-back. Single source of truth — session.js, mediaStream.js,
// and server.js's degraded-mode voicemail webhook all import this instead
// of each declaring/duplicating their own copy of the literal.
export const MESSAGE_SLA_TEXT = "as soon as possible";

/** Default caller SMS templates, keyed by kind. Overridable per business via
 * businesses.sms_templates (loadConfig's config.smsTemplates).
 *
 * THEY NO LONGER PROMISE A REPLY, and that is a bug fix rather than a wording
 * preference. Two of the three used to say "Reply to this number" / "Reply
 * here", and NO INBOUND SMS ROUTE EXISTS ANYWHERE IN THIS REPO — a patient who
 * replied to change an appointment got silence, from a clinic, about their own
 * care. The promise was also wrong about the number: these are sent from the
 * single global TWILIO_SMS_FROM, not from the number the caller dialled, so
 * "this number" named a line nobody answers.
 *
 * Building the inbound route is the real fix and it is a feature, not a
 * sentence — see ledger O25. Until it exists, the honest text points the caller
 * at the phone line that IS answered. */
export const DEFAULT_SMS_TEMPLATES = {
  appointment_confirmation:
    "Hi {name}, your appointment with {business} is confirmed for {datetime}. Call us back if you need to change it.",
  message_received:
    "Hi{name_part}, we got your message at {business} — someone will get back to you {sla}. Thanks for calling!",
  missed_call:
    "Sorry we missed your call at {business}! Call us back anytime and we'll help you right away.",
};

/** Replace {key} placeholders in a template with vars[key] (blank if missing). */
function interpolateTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const val = vars?.[key];
    return val != null ? String(val) : "";
  });
}

// ---------------------------------------------------------------------------
// Held texts (ledger O25)
// ---------------------------------------------------------------------------
// The ordering problem, and why a buffer rather than a stricter prompt.
//
// The confirmation text is sent from the appointments pack's onEffect, the
// instant the booking succeeds. But the natural way a receptionist talks is
// "you're all set for Tuesday at three — would you like a text confirmation?",
// which puts the consent AFTER the send. With a gate and nothing else, the
// confirmation text would be refused for every caller, forever, and the feature
// would be dead while looking configured.
//
// Instructing the model to ask first is necessary and not sufficient: a prompt
// is a request, never a guarantee (capabilities/_contract.js), and the failure
// is silent. So a text refused for want of consent is HELD, and released if the
// answer arrives during the same call.
//
// In-process and short-lived on purpose. The hold and the release both happen
// inside one WebSocket session, which is pinned to one instance for the life of
// the call, so a process-local map is the correct scope rather than a
// compromise — the same reasoning lib/voice/metrics.js's ring buffer already
// runs on. The two paths that CANNOT be released this way (the missed-call
// text-back and the degraded voicemail webhook) are HTTP callbacks that may
// land on any instance, and neither has an in-call consent moment to wait for
// anyway.
//
// It holds a rendered message body, which for appointment_confirmation contains
// a name and a time. That is PHI in memory — already true of every turn of the
// call — bounded here by a five-minute expiry and a hard cap on entries.

const HELD_SMS_TTL_MS = 5 * 60_000;
const HELD_SMS_MAX_KEYS = 500;
const HELD_SMS_MAX_PER_KEY = 3;

/** @type {Map<string, Array<{ body: string, kind: string, expiresAt: number }>>} */
const heldCallerSms = new Map();

function heldKey(businessId, toNumber) {
  return `${businessId}|${normalizePhoneNumber(toNumber) || toNumber}`;
}

function holdCallerSms(businessId, toNumber, kind, body) {
  if (!businessId) return;
  const key = heldKey(businessId, toNumber);
  const now = Date.now();
  const queue = (heldCallerSms.get(key) || []).filter((h) => h.expiresAt > now);
  queue.push({ body, kind, expiresAt: now + HELD_SMS_TTL_MS });
  // Oldest first out, so a caller who books and then leaves a message keeps the
  // message rather than the stale booking text if both overflow.
  while (queue.length > HELD_SMS_MAX_PER_KEY) queue.shift();
  heldCallerSms.set(key, queue);
  // Map insertion order is oldest-first, so the first key is the coldest.
  while (heldCallerSms.size > HELD_SMS_MAX_KEYS) {
    const oldest = heldCallerSms.keys().next().value;
    heldCallerSms.delete(oldest);
  }
}

/**
 * Send the texts that were refused for want of consent, now that it exists.
 *
 * Called by capabilities/smsConsent.js after a grant is recorded. Takes the
 * tenant and the number rather than reading state, so it is callable from the
 * one place that knows consent just changed and from nowhere else.
 *
 * Deliberately re-checks nothing: the caller has just written the grant, and
 * re-reading it would race its own transaction. What it does check is the
 * expiry, so a grant arriving after the call has moved on releases nothing.
 *
 * @param {string} businessId
 * @param {string} toNumber
 * @returns {Promise<number>} how many were sent
 */
export async function releaseHeldCallerSms(businessId, toNumber) {
  if (!businessId || !isValidE164(toNumber)) return 0;
  const key = heldKey(businessId, toNumber);
  const queue = heldCallerSms.get(key);
  if (!queue?.length) return 0;
  heldCallerSms.delete(key);

  const now = Date.now();
  let sent = 0;
  for (const held of queue) {
    if (held.expiresAt <= now) continue;
    try {
      await sendSms({ to: toNumber, body: held.body });
      sent += 1;
    } catch (err) {
      log.error("sms_followup_failed", { message: err?.message, kind: held.kind });
      captureException(err, { context: "notifications.releaseHeldCallerSms", kind: held.kind });
    }
  }
  if (sent) log.info("sms_followup_released", { businessId, count: sent });
  return sent;
}

/** Test seam: forget every held text. Never called by the server. */
export function _clearHeldCallerSms() {
  heldCallerSms.clear();
}

/**
 * Text the CALLER (not the business owner) a follow-up SMS.
 *
 * FOUR GATES, in cost order, and the last one is the point of ledger O25.
 *
 *   1. businessConfig.smsFollowupEnabled — the tenant's own switch, off by
 *      default since migration 017.
 *   2. A valid, non-anonymous caller number. Twilio reports withheld caller IDs
 *      as non-E.164 strings ("anonymous"), which isValidE164 already rejects.
 *   3. A known template kind.
 *   4. RECORDED EXPRESS CONSENT from this caller, to this tenant, for this
 *      number. Without it the message is held rather than sent.
 *
 * Gate 4 closes two exposures with one question. `appointment_confirmation`
 * puts a patient name, a clinic name and an appointment time in an unencrypted
 * SMS: lawful because the individual asked for that channel (45 CFR 164.522(b)),
 * and unlawful — or at least undefended — without the asking. The same answer
 * is TCPA prior express consent, where the exposure is $500-$1,500 per message
 * with no cap. See database/037_sms_consent.sql.
 *
 * FAILS CLOSED IN EVERY DIRECTION. No tenant on the config, no database, a
 * failed lookup, an unscoped read that matched nothing under row-level
 * security: each returns a falsy consent and each blocks the send. The gate
 * cannot tell those apart and deliberately does not try — "we could not
 * establish consent" and "there is no consent" are the same decision.
 *
 * Never throws.
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
    // The override is re-validated HERE and not only in the dashboard, because
    // businesses.sms_templates can also be written by an operator with a SQL
    // client and the dashboard validator is not in that path. An override that
    // fails falls back to the built-in default rather than blocking the send:
    // the default is known-safe, and refusing to text at all would punish the
    // caller for the owner's typo.
    const overrides = businessConfig.smsTemplates || {};
    const override =
      typeof overrides[kind] === "string" && overrides[kind].trim() ? overrides[kind] : null;
    let chosen = template;
    if (override) {
      const problem = smsTemplateProblem(kind, override);
      if (problem) {
        log.error("sms_template_rejected", { kind, reason: problem, severity: "warn" });
      } else {
        chosen = override;
      }
    }
    const body = interpolateTemplate(chosen, vars);

    const businessId = businessConfig.businessId || null;
    const consent = businessId
      ? await db.withTenantSafe(businessId, () => db.latestSmsConsent(businessId, toNumber), {
          operation: "latestSmsConsent",
        })
      : null;
    if (!consent?.granted) {
      // Held, not dropped — see the note above holdCallerSms. The log line
      // carries no phone number: this is the path that exists to protect one.
      holdCallerSms(businessId, toNumber, kind, body);
      log.info("sms_followup_blocked_no_consent", {
        businessId,
        kind,
        reason: consent ? "declined" : "no_record",
      });
      return;
    }

    await sendSms({ to: toNumber, body });
  } catch (err) {
    log.error("sms_followup_failed", { message: err?.message, kind });
    captureException(err, { context: "notifications.sendCallerSms", kind });
  }
}

/**
 * Notify when a call completes and summary is ready.
 *
 * `call`, `summary`, `sentiment` and `outcome` are still accepted and are
 * deliberately NOT read: callers already have them at the call site, and the
 * signature staying stable is what keeps this a content change rather than a
 * change that ripples into session.js and server.js. The summary in particular
 * is a narrative account of what a caller said, and it does not leave the
 * system.
 *
 * @param {{ businessId: string, call?: { callerNumber?: string, endedAt?: string }, summary: string | null, sentiment: string | null, outcome: string | null }} opts
 */
export async function notifyCallCompleted({ businessId }) {
  if (!NOTIFICATIONS_ENABLED) return;
  try {
    if (!checkRateLimit(businessId)) return;
    const config = await loadBusinessNotificationConfig(businessId);
    if (!config) return;
    // The summary is a narrative account of what a caller said. It is the single
    // most sensitive field this module ever handled, and it does not leave.
    const sentence = "A call finished and its summary is ready.";
    const subject = `Call summary ready — ${config.businessName}`;
    if (config.email) await sendEmail({ to: config.email, subject, text: ownerEmailBody(config.businessName, sentence) });
    if (config.phone) await sendSms({ to: config.phone, body: ownerSmsBody(config.businessName, sentence) });
  } catch (err) {
    log.error("notify_call_completed", { message: err?.message });
    captureException(err, { businessId });
  }
}
