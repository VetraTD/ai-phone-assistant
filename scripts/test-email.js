/**
 * One-off test: send an email via SMTP (Gmail) to verify config.
 * Run: node scripts/test-email.js
 * Requires .env with SMTP_USER, SMTP_PASS (and optionally SMTP_FROM_EMAIL).
 */
import "dotenv/config";
import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER;
const TEST_TO = "nithinjd06@gmail.com";

if (!SMTP_USER || !SMTP_PASS) {
  console.error("Missing SMTP_USER or SMTP_PASS in .env");
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

async function main() {
  console.log("Sending test email to", TEST_TO, "from", SMTP_FROM_EMAIL);
  const info = await transport.sendMail({
    from: SMTP_FROM_EMAIL,
    to: TEST_TO,
    subject: "AI Phone Assistant — test email",
    text: "If you see this, SMTP is configured correctly and email sending works.",
    html: "<p>If you see this, SMTP is configured correctly and email sending works.</p>",
  });
  console.log("Sent successfully. Message ID:", info.messageId);
}

main().catch((err) => {
  console.error("Send failed:", err.message);
  process.exit(1);
});
