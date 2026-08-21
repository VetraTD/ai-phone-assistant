const nodemailer = require("nodemailer");

// ---------------------------------------------------------------------------
// Outbound email for the dashboard backend.
//
// Replaces Brevo. Two things used it — the marketing site's contact form and
// the appointments digest — and neither carries PHI since A1.3 made every
// notification link-only, so the vendor choice stopped being a compliance
// question and became an operational one.
//
// Three reasons it went:
//
//   1. IT WAS PROBABLY LANDING IN JUNK. vetratd.com publishes
//      `v=spf1 include:spf.protection.outlook.com -all` — Microsoft only, hard
//      fail — with no Brevo DKIM selector, under `p=quarantine`. Mail sent as
//      @vetratd.com through Brevo failed SPF and DKIM alignment and its own
//      domain's DMARC policy told receivers to quarantine it. SMTP through
//      Microsoft 365 passes the SPF record that already exists.
//
//   2. BREVO_API_KEY was already flagged compromised (D2, leaked by an axios
//      error-logging bug). Deleting the vendor removes a rotation task instead
//      of performing one.
//
//   3. There were already TWO email systems. The root repo's
//      services/notifications.js has sent owner notifications over SMTP all
//      along. One path is better than two, and Google Cloud has no first-party
//      transactional email service to migrate to anyway.
//
// The env vars are deliberately THE SAME NAMES the root repo uses, so both
// services read one set of mail credentials rather than each having its own
// spelling — exactly the drift D1 exists to reconcile.
// ---------------------------------------------------------------------------

const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER;

/** Whether outbound email is configured at all. */
function isConfigured() {
  return !!(SMTP_USER && SMTP_PASS);
}

let transport = null;

function getTransport() {
  if (!transport && isConfigured()) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false" },
    });
  }
  return transport;
}

/**
 * Send one message.
 *
 * Throws on failure rather than swallowing it, because both callers are HTTP
 * handlers that need to answer 500 rather than tell the user their message was
 * sent when it was not. That is the opposite of the root repo's sendEmail,
 * which never throws — there the caller is a background notification and
 * failing loudly would take down a call.
 *
 * @param {{to: string, subject: string, text: string, replyTo?: string, fromName?: string}} opts
 */
async function sendMail({ to, subject, text, replyTo, fromName }) {
  const t = getTransport();
  if (!t) {
    // Named the same as the root repo's event, so one log query answers "did
    // any part of this system fail to send mail" across both services.
    const err = new Error("smtp_not_configured");
    err.code = "SMTP_NOT_CONFIGURED";
    throw err;
  }
  await t.sendMail({
    from: fromName ? `"${fromName}" <${SMTP_FROM_EMAIL}>` : SMTP_FROM_EMAIL,
    to,
    subject,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
}

module.exports = { sendMail, isConfigured };
