#!/usr/bin/env node
/**
 * Send one fixed test email through the Microsoft Graph path the application
 * uses for owner email (MAIL_TRANSPORT=graph), and print whether Microsoft
 * accepted it. SENDS A REAL EMAIL: run it by hand, after the Microsoft 365 setup,
 * never from a test or a deploy.
 *
 * It imports services/graphMail.js, the same token and sendMail code the
 * server runs, so a pass here is a pass for that code with these settings. It
 * reads the four MS_GRAPH_* variables (from .env or the shell). MAIL_TRANSPORT
 * does not need to be set to run it.
 *
 * What it prints: accepted or refused, a closed reason and the HTTP status.
 * Never the recipient, the secret, the token, or Microsoft's error text. The
 * email itself carries no caller data.
 *
 * Usage:
 *   node scripts/graph-mail-smoke.js you@example.com
 */
import "dotenv/config";
import { createGraphMailer, graphMailConfig, missingGraphMailVars, GRAPH_FETCH_TIMEOUT_MS } from "../services/graphMail.js";

const to = (process.argv[2] || "").trim();
if (!to || !to.includes("@")) {
  console.error("Usage: node scripts/graph-mail-smoke.js <recipient@example.com>");
  process.exit(1);
}

const missing = missingGraphMailVars(process.env);
if (missing.length) {
  console.error(`Missing or blank: ${missing.join(", ")}`);
  process.exit(1);
}

const mailer = createGraphMailer(graphMailConfig(process.env));
const result = await mailer.send({
  to,
  subject: "Vetra owner email test (Microsoft Graph)",
  contentType: "Text",
  content:
    "If you are reading this, owner email through Microsoft 365 works with the settings the application uses.\n\n" +
    "This is a test message. It contains no caller information.\n",
});

if (result.ok) {
  console.log(`accepted (HTTP ${result.status})`);
  console.log("\nCheck the inbox AND the junk folder. Landing in junk is a different problem");
  console.log("from not sending, and it is an SPF/DKIM one.");
  process.exit(0);
}

const status = result.status ? `HTTP ${result.status}` : "no HTTP status";
console.error(`refused: ${result.reason} (${status})`);

// Our own hints, keyed on the reason and status only.
if (result.reason === "graph_timeout") {
  console.error(`\nNo answer within ${GRAPH_FETCH_TIMEOUT_MS / 1000} s.`);
} else if (!result.status) {
  console.error("\nThe request did not complete. On this workstation the usual cause is Norton's TLS");
  console.error("interception: set NODE_EXTRA_CA_CERTS to its root certificate and run again.");
} else if (result.reason === "graph_token_failed") {
  console.error("\nThe token request was refused. Check the tenant ID, the client ID, and that the");
  console.error("client secret is the secret's VALUE and has not expired.");
} else if (result.status === 401 || result.status === 403) {
  console.error("\nA token was issued but sending was refused. Check that the app has the Mail.Send");
  console.error("application permission and that its Exchange Online scope includes this mailbox.");
} else if (result.status === 404) {
  console.error("\nThe sending mailbox was not found. Check MS_GRAPH_SENDER.");
}
process.exit(1);
