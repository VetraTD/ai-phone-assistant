#!/usr/bin/env node
/**
 * Send one email, using exactly the transport configuration the application
 * uses, and say precisely what went wrong if it does not arrive.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Whether Microsoft 365 will accept SMTP AUTH from this account is a D2 unknown
 * with no good discovery moment. Finding out it is blocked DURING cutover —
 * Twilio webhooks already repointed, Railway already off — is the worst
 * possible timing, and the fallbacks (OAuth2, or going back to a transactional
 * provider) are not five-minute changes.
 *
 * So: one command, run months earlier, that answers it.
 *
 * It deliberately duplicates the transport options from
 * services/notifications.js and AI-phone-dashboard/backend/src/services/mailer.js
 * rather than importing either. Importing one would test that one; this has to
 * test the CONFIGURATION, which both share and neither owns.
 *
 * Usage:
 *   SMTP_HOST=smtp.office365.com SMTP_PORT=587 \
 *   SMTP_USER=you@vetratd.com SMTP_PASS='...' \
 *   SMTP_FROM_EMAIL=you@vetratd.com \
 *   node scripts/smtp-smoke.js recipient@example.com
 */
import "dotenv/config";
import nodemailer from "nodemailer";

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/smtp-smoke.js <recipient@example.com>");
  process.exit(1);
}

const HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SECURE = process.env.SMTP_SECURE === "true";
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const FROM = process.env.SMTP_FROM_EMAIL || USER;

if (!USER || !PASS) {
  console.error("SMTP_USER and SMTP_PASS are required.");
  process.exit(1);
}

console.log(`host    ${HOST}:${PORT} (secure=${SECURE})`);
console.log(`auth as ${USER}`);
console.log(`from    ${FROM}`);
console.log(`to      ${to}\n`);

// Port 587 is STARTTLS: it opens in the clear and upgrades. `secure: true`
// there means implicit TLS, which the server does not speak on that port, and
// the resulting error blames the certificate rather than the port. Worth one
// line to prevent a long afternoon.
if (PORT === 587 && SECURE) {
  console.warn("WARNING: port 587 with SMTP_SECURE=true is almost certainly wrong.");
  console.warn("587 is STARTTLS. Use SMTP_SECURE=false, or port 465 for implicit TLS.\n");
}

const transport = nodemailer.createTransport({
  host: HOST,
  port: PORT,
  secure: SECURE,
  auth: { user: USER, pass: PASS },
  tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false" },
});

try {
  // verify() authenticates without sending, so an auth failure is reported as
  // an auth failure rather than as a failed delivery.
  await transport.verify();
  console.log("connection + auth OK");

  const info = await transport.sendMail({
    from: FROM,
    to,
    subject: "Vetra SMTP smoke test",
    text:
      "If you are reading this, SMTP works with the settings the application uses.\n\n" +
      `host: ${HOST}:${PORT}\nauth: ${USER}\nfrom: ${FROM}\n`,
  });

  console.log(`sent    ${info.messageId}`);
  if (info.accepted?.length) console.log(`accepted ${info.accepted.join(", ")}`);
  if (info.rejected?.length) console.log(`REJECTED ${info.rejected.join(", ")}`);
  console.log("\nCheck the inbox AND the junk folder. Landing in junk is a");
  console.log("different problem from not sending, and it is an SPF/DKIM one.");
  process.exit(0);
} catch (err) {
  // Message and code only. A nodemailer transport error carries its connection
  // options — auth.pass included — as own enumerable properties, so printing
  // the object dumps the password. That is the same defect class that leaked
  // BREVO_API_KEY, and a diagnostic script is a stupid place to reintroduce it.
  console.error(`\nFAILED  ${err?.code || "no code"}: ${err?.message}`);

  const msg = String(err?.message || "").toLowerCase();
  if (msg.includes("basic authentication") || msg.includes("smtpclientauthentication")) {
    console.error("\nMicrosoft has SMTP AUTH disabled for this mailbox. Enable it:");
    console.error("  Admin centre -> Users -> Active users -> the user -> Mail");
    console.error("    -> Manage email apps -> tick Authenticated SMTP");
    console.error("  or: Set-CASMailbox -Identity you@vetratd.com -SmtpClientAuthenticationDisabled $false");
  } else if (msg.includes("invalid login") || err?.code === "EAUTH") {
    console.error("\nCredentials rejected. If the account has MFA, a normal password");
    console.error("will not work here — you need an app password, or OAuth2 (XOAUTH2).");
  } else if (err?.code === "ETIMEDOUT" || err?.code === "ECONNREFUSED") {
    console.error("\nCould not reach the server. Check host and port, and whether");
    console.error("outbound 587 is blocked on this network.");
  } else if (msg.includes("self-signed") || msg.includes("certificate")) {
    console.error("\nTLS interception, most likely Norton on this workstation — the same");
    console.error("root cause as the gcloud, Terraform and docker npm issues. This is a");
    console.error("LOCAL problem and says nothing about whether SMTP works from Cloud Run.");
  }
  process.exit(1);
}
