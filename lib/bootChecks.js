import { isValidE164 } from "./validate.js";

/**
 * Boot-time configuration checks.
 *
 * The standing rule these implement: a subsystem disabled by missing config
 * must announce itself loudly at boot. The reason it is a rule is that two
 * live features looked like they were working and were not — a notification
 * that is dropped because there is no mail transport is indistinguishable, from
 * the outside, from a notification that was never triggered.
 *
 * ---------------------------------------------------------------------------
 * Where the fatal line is drawn, and why it is not "anything unconfigured"
 * ---------------------------------------------------------------------------
 *
 * FATAL is reserved for configuration that CANNOT be what anyone intended:
 * half a credential pair, a from-number with no client behind it, a from-number
 * that no carrier will accept, an explicit request for notifications with
 * nothing to deliver them on. None of those has a reading in which the operator
 * got what they asked for.
 *
 * ANNOUNCE covers configuration that is merely absent. Absent is a choice, and
 * the check cannot tell a deliberate choice from an oversight.
 *
 * The case that forces the distinction is `TWILIO_ACCOUNT_SID` +
 * `TWILIO_AUTH_TOKEN` with no `TWILIO_SMS_FROM`. Those two are ALSO the voice
 * credentials, so a deployment that uses Twilio for calls and never for texts
 * is a perfectly ordinary configuration. Refusing to boot on it would take the
 * receptionist off the air in order to protect a notification, which inverts
 * the priority: a silently dropped owner email is a defect, and a phone that
 * does not answer is an outage.
 *
 * What still catches that case is the announcement. It is loud, it names the
 * subsystem, and it is emitted on every boot — which is the actual requirement.
 */

export const FATAL = "fatal";
export const ANNOUNCE = "announce";

/** Present and not the empty/whitespace string. */
function set(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Inspect notification configuration.
 *
 * Pure: takes an env-shaped object and returns findings. It deliberately does
 * NOT import services/notifications.js — that module computes its constants at
 * import time and importing it here would make the checker's answer depend on
 * import order. The cost is a second reader of the same env, which is how a
 * check drifts away from the thing it checks; tests/bootChecks.test.js pins the
 * two together across the env combinations that matter.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ findings: Array<{ code: string, severity: string, detail: string }>,
 *             email: boolean, sms: boolean, notificationsEnabled: boolean }}
 */
export function checkNotificationConfig(env = process.env) {
  const findings = [];
  const add = (severity, code, detail) => findings.push({ code, severity, detail });

  const smtpUser = set(env.SMTP_USER);
  const smtpPass = set(env.SMTP_PASS);
  const twilioSid = set(env.TWILIO_ACCOUNT_SID);
  const twilioToken = set(env.TWILIO_AUTH_TOKEN);
  const smsFrom = set(env.TWILIO_SMS_FROM);

  // Mirrors services/notifications.js exactly. Any change there is a change here.
  const email = smtpUser && smtpPass;
  const sms = twilioSid && twilioToken && smsFrom;
  const disabledByEnv = env.NOTIFICATIONS_ENABLED === "false";
  const notificationsEnabled = !disabledByEnv && (email || sms);

  if (smtpUser !== smtpPass) {
    add(
      FATAL,
      "smtp_half_configured",
      `SMTP_USER is ${smtpUser ? "set" : "unset"} and SMTP_PASS is ${smtpPass ? "set" : "unset"}. ` +
        "Nobody sets half a credential pair on purpose; email notifications would be dropped silently."
    );
  }

  if (smsFrom && !(twilioSid && twilioToken)) {
    add(
      FATAL,
      "sms_from_without_client",
      "TWILIO_SMS_FROM is set but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are not. " +
        "There is no client to send from that number, so every SMS would be dropped silently."
    );
  }

  if (smsFrom && !isValidE164(env.TWILIO_SMS_FROM)) {
    add(
      FATAL,
      "sms_from_not_e164",
      `TWILIO_SMS_FROM=${JSON.stringify(env.TWILIO_SMS_FROM)} is not E.164 (+ and 1-15 digits). ` +
        "Twilio rejects every send, and the rejection is swallowed by the notification error handler."
    );
  }

  // Explicitly asked for, and undeliverable. Note the test for presence: an
  // UNSET variable is the default and means "on if a channel exists", which is
  // not a request and not an error.
  if (env.NOTIFICATIONS_ENABLED !== undefined && !disabledByEnv && !email && !sms) {
    add(
      FATAL,
      "notifications_forced_on_with_no_channel",
      `NOTIFICATIONS_ENABLED=${JSON.stringify(env.NOTIFICATIONS_ENABLED)} but neither SMTP nor Twilio SMS is ` +
        "configured. The setting evaluates to off, so the request silently did nothing."
    );
  }

  if (disabledByEnv) {
    // Turned off on purpose. The per-channel detail below would be noise: the
    // operator is not one variable away from working notifications, they asked
    // for none.
    add(ANNOUNCE, "notifications_disabled_by_env", "NOTIFICATIONS_ENABLED=false — no owner notifications will be sent.");
    return { findings, email, sms, notificationsEnabled };
  }

  // Per-channel first, and NOT as an else-branch of the summary below. The
  // whole value of the announcement is the specific fact — "Twilio is
  // configured and TWILIO_SMS_FROM is missing" tells an operator they are one
  // variable from working; "notifications are off" does not.
  if (!email) {
    add(
      ANNOUNCE,
      "email_channel_off",
      "SMTP is not configured — every business with notification_email set will silently receive no email."
    );
  }
  if (!sms) {
    add(
      ANNOUNCE,
      "sms_channel_off",
      "Twilio SMS is not configured" +
        (twilioSid && twilioToken && !smsFrom ? " (TWILIO_ACCOUNT_SID/TOKEN are set; TWILIO_SMS_FROM is not)" : "") +
        " — every business with notification_phone set will silently receive no text, " +
        "and caller SMS follow-ups will not send."
    );
  }
  if (!email && !sms) {
    add(
      ANNOUNCE,
      "notifications_off",
      "Neither channel is configured — owner notifications are off entirely."
    );
  }

  return { findings, email, sms, notificationsEnabled };
}

/**
 * Run every boot check, announce the results, and throw if any are fatal.
 *
 * Announces BEFORE throwing: a process that dies without saying why is the
 * silent failure this file exists to remove, one level up.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ log?: (...args: unknown[]) => void }} [opts]
 */
export function assertBootConfig(env = process.env, opts = {}) {
  const emit = opts.log || console.error;
  const { findings } = checkNotificationConfig(env);

  for (const f of findings) {
    emit(`[boot] ${f.severity === FATAL ? "FATAL" : "notice"} ${f.code}: ${f.detail}`);
  }

  const fatal = findings.filter((f) => f.severity === FATAL);
  if (fatal.length) {
    throw new Error(
      `Refusing to boot: ${fatal.length} fatal configuration problem(s) — ` +
        fatal.map((f) => f.code).join(", ") +
        ". Each one would have failed silently at runtime."
    );
  }
}
