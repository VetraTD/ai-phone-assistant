#!/usr/bin/env node
// ---------------------------------------------------------------------------
// onboard-tenant.js — take a clinic from "we imported their config" to "they
// can sign in", in one command.
//
//   node scripts/onboard-tenant.js --phone +441372656055 --email owner@clinic.uk
//   node scripts/onboard-tenant.js --business <uuid> --email owner@clinic.uk --confirm
//
// DRY RUN unless --confirm. The dry run makes every read-only call for real and
// stops before the two writes, so "it would work" is measured rather than
// asserted.
//
// ---------------------------------------------------------------------------
// WHY THIS IS ONE COMMAND ACROSS TWO PLACES
// ---------------------------------------------------------------------------
//
// The work splits across a boundary that cannot be removed:
//
//   Identity Platform  reachable from anywhere with operator credentials
//   Cloud SQL          private IP only — reachable ONLY from inside the VPC
//
// So the database half runs as a Cloud Run job execution and the auth half runs
// here. The alternative — granting the voice runtime service account Identity
// Platform admin so one job could do both — would let the process that answers
// the phone mint login accounts. That is a much larger permission than this
// convenience is worth.
//
// Like scripts/restore-drill.js, this therefore drives `gcloud` rather than
// being a library call, and prints every command it runs.
//
// ---------------------------------------------------------------------------
// THE ORDER IS LOAD-BEARING AND THE OBVIOUS ORDER IS WRONG
// ---------------------------------------------------------------------------
//
// Do NOT let the customer sign up in the dashboard first. Onboarding calls
// app_create_business_for_user, which creates a NEW empty business and attaches
// them to it; the attach below then correctly refuses with "already belongs to
// a business", and unpicking it means deleting an account. Import their config,
// run this, then send them the link.
//
// ---------------------------------------------------------------------------
// WHY THE LINK IS PRINTED RATHER THAN EMAILED
// ---------------------------------------------------------------------------
//
// Identity Platform's own password-reset email was tried on 2026-09-01 and did
// not arrive, while the API reported success. For a clinic that is a dead end
// at the last step of onboarding, and nothing would tell you it happened.
//
// `returnOobLink` hands the link to the operator instead, to be sent through a
// channel that can be seen to have worked. It is a credential: single use,
// roughly an hour, and it sets a password on that account.
// ---------------------------------------------------------------------------

import { execFileSync } from "child_process";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const AUTH_PROJECT = process.env.VETRA_AUTH_PROJECT || "vetra-core-edc8ca";
const DB_PROJECT = process.env.VETRA_DB_PROJECT || "vetra-uk-edc8ca";
const DB_REGION = process.env.VETRA_DB_REGION || "europe-west2";
const MIGRATE_JOB = process.env.VETRA_MIGRATE_JOB || "vetra-migrate-uk-prod";
const DASHBOARD_URL = process.env.VETRA_DASHBOARD_URL || "https://vetra-core-edc8ca.web.app/app";

// ---------------------------------------------------------------------------
// Pure helpers, exported so they can be tested without touching gcloud.
// ---------------------------------------------------------------------------

/**
 * A stable, explicit account id for an address.
 *
 * scripts/import-users.js established why this must never be left to the
 * service: `accounts:batchCreate` ignores `allow_duplicate_emails`, so a second
 * run creates a SECOND account on the same address, silently, and
 * signInWithPassword then returns the last one. With the tenant lookup keyed on
 * auth_uid, that repoints a clinic's access on a retry and reports success.
 *
 * Deriving the id from the address makes a re-run an upsert instead.
 *
 * @param {string} email
 * @returns {string}
 */
export function localIdFor(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) throw new Error("email is required to derive a localId");
  return `tenant-${crypto.createHash("sha256").update(norm).digest("hex").slice(0, 24)}`;
}

/**
 * Reject anything that is not plausibly one E.164 number, because these values
 * are interpolated into a shell command below.
 * @param {string} phone
 */
export function assertE164(phone) {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new Error(`Not an E.164 phone number: ${phone}`);
  }
  return phone;
}

/** @param {string} id */
export function assertUuid(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Not a uuid: ${id}`);
  }
  return id;
}

/**
 * An address safe to interpolate into a shell command. Deliberately stricter
 * than RFC 5322 — this is an allow-list for a shell argument, not an attempt to
 * decide what a valid address is.
 * @param {string} email
 */
export function assertEmail(email) {
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
    throw new Error(`Not an address this script will pass to a shell: ${email}`);
  }
  return email;
}

/**
 * Build the `--args` value for the migrate job.
 *
 * ⚠ THE DELIMITER MUST NOT APPEAR IN ANY ARGUMENT. gcloud's default separator
 * is a comma and the documented override is `^X^`; using `^@^` here cost three
 * failed executions on 2026-09-01, because the `@` in an email address was read
 * as an argument separator and the failure message named none of that.
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function jobArgs(argv) {
  const DELIM = "#";
  for (const a of argv) {
    if (a.includes(DELIM)) throw new Error(`Argument contains the job-args delimiter ${DELIM}: ${a}`);
  }
  return `^${DELIM}^${argv.join(DELIM)}`;
}

// ---------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(
    "\nusage: node scripts/onboard-tenant.js --email <addr> (--business <uuid> | --phone <e164>) [--confirm]\n\n" +
      "  --email      the address the clinic will sign in with\n" +
      "  --business   the imported tenant's id\n" +
      "  --phone      resolve the tenant by its dialled number instead\n" +
      "  --confirm    actually write. Without it this is a dry run.\n\n" +
      "Run scripts/import-tenant.js FIRST — this attaches a user to a business\n" +
      "that already exists, and does not create one.\n"
  );
  process.exit(msg ? 1 : 0);
}

export function parseArgs(argv) {
  const out = { email: null, business: null, phone: null, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) usage(`${a} needs a value.`);
      return v;
    };
    if (a === "--email") out.email = next();
    else if (a === "--business") out.business = next();
    else if (a === "--phone") out.phone = next();
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--help" || a === "-h") usage();
    else usage(`Unknown argument: ${a}`);
  }
  return out;
}

// gcloud is a .cmd shim on Windows and Node refuses to exec one without a
// shell, so every call goes through one. Arguments are validated above rather
// than escaped, because an allow-list stays correct when someone adds a caller.
function gcloud(args, { quiet = false } = {}) {
  if (!quiet) console.log(`  $ gcloud ${args.join(" ")}`);
  return execFileSync("gcloud", args, { encoding: "utf8", shell: true, maxBuffer: 32 * 1024 * 1024 });
}

function idpFetch(path, body) {
  const token = gcloud(["auth", "print-access-token"], { quiet: true }).trim();

  // THE BODY GOES VIA A FILE, and that is not fastidiousness.
  //
  // Everything here runs through a shell (gcloud is a .cmd shim on Windows and
  // Node will not exec one without it), and cmd.exe does not understand single
  // quotes at all. A JSON body inlined as -d '{"...":"..."}' arrives with its
  // quotes mangled, and the API answers
  //   Invalid JSON payload received. Unknown name "": Root element must be a message.
  // which reads like a malformed request rather than a quoting fault. Measured
  // on 2026-09-01, and the same shape that broke scripts/call-report.js's
  // Logging filter an hour earlier.
  const tmp = join(tmpdir(), `vetra-idp-${crypto.randomBytes(8).toString("hex")}.json`);
  writeFileSync(tmp, JSON.stringify(body), "utf8");

  try {
    const res = execFileSync(
      "curl",
      [
        "-s", "-m", "30", "-X", "POST",
        "-H", `"Authorization: Bearer ${token}"`,
        // Without this the identitytoolkit API refuses user credentials with a
        // message about quota projects that reads like a permissions error.
        "-H", `"x-goog-user-project: ${AUTH_PROJECT}"`,
        "-H", '"Content-Type: application/json"',
        `"https://identitytoolkit.googleapis.com/v1/projects/${AUTH_PROJECT}/${path}"`,
        "-d", `"@${tmp}"`,
      ],
      { encoding: "utf8", shell: true, maxBuffer: 16 * 1024 * 1024 }
    );
    const parsed = JSON.parse(res);
    if (parsed.error) throw new Error(`Identity Platform: ${parsed.error.message}`);
    return parsed;
  } finally {
    // The create call's body carries a password. It is a throwaway nobody will
    // ever use, but leaving it in a temp directory is still leaving a
    // credential on disk.
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) usage("--email is required.");
  if (!args.business && !args.phone) usage("one of --business or --phone is required.");
  if (args.business && args.phone) usage("--business and --phone are mutually exclusive.");

  const email = assertEmail(args.email);
  if (args.business) assertUuid(args.business);
  if (args.phone) assertE164(args.phone);

  const localId = localIdFor(email);

  console.log(`\nonboard-tenant  ${args.confirm ? "CONFIRM" : "DRY RUN"}`);
  console.log(`  email      ${email}`);
  console.log(`  tenant     ${args.business || args.phone}`);
  console.log(`  auth uid   ${localId}`);
  console.log(`  auth proj  ${AUTH_PROJECT}`);
  console.log(`  db job     ${MIGRATE_JOB} (${DB_PROJECT}/${DB_REGION})\n`);

  // ---- 1. Refuse a duplicate before creating anything ---------------------
  console.log("1. checking Identity Platform for an existing account");
  const existing = idpFetch("accounts:lookup", { email: [email] });
  const found = (existing.users || [])[0];
  if (found && found.localId !== localId) {
    throw new Error(
      `An account already exists for ${email} with a DIFFERENT id (${found.localId}).\n` +
        `  Creating another would leave two accounts on one address, and sign-in would\n` +
        `  resolve the last one — silently repointing whichever tenant it is attached to.\n` +
        `  Attach the existing id instead:\n` +
        `    scripts/attach-tenant-user.js --email ${email} --auth-uid ${found.localId} ...`
    );
  }
  console.log(found ? `   exists already as ${found.localId} — will reuse\n` : "   no account yet\n");

  if (!args.confirm) {
    console.log("2. would create the Identity Platform account");
    console.log("3. would attach it to the tenant via the migrate job");
    console.log("4. would generate a password-reset link\n");
    console.log("DRY RUN — nothing written. Re-run with --confirm.\n");
    return;
  }

  // ---- 2. Create the account ---------------------------------------------
  if (!found) {
    console.log("2. creating the Identity Platform account");
    // A password is required by the API and is never printed, never stored and
    // never used: the operator hands over the reset link instead, so the only
    // password this account ever has is one the customer chooses.
    const throwaway = crypto.randomBytes(24).toString("base64url");
    idpFetch("accounts", { localId, email, password: throwaway, emailVerified: false });
    console.log(`   created ${localId}\n`);
  } else {
    console.log("2. account already exists — skipping creation\n");
  }

  // ---- 3. Attach, inside the VPC -----------------------------------------
  console.log("3. attaching the account to the tenant (migrate job, inside the VPC)");
  const attach = ["scripts/attach-tenant-user.js", "--email", email, "--auth-uid", localId];
  if (args.business) attach.push("--business", args.business);
  else attach.push("--phone", args.phone);
  attach.push("--confirm");

  gcloud([
    "run", "jobs", "execute", MIGRATE_JOB,
    "--project", DB_PROJECT,
    "--region", DB_REGION,
    "--wait",
    `--args="${jobArgs(attach)}"`,
  ]);
  console.log("   job completed — read its log to see the attach output\n");

  // ---- 4. The handover ----------------------------------------------------
  console.log("4. generating the password-reset link");
  const oob = idpFetch("accounts:sendOobCode", {
    requestType: "PASSWORD_RESET",
    email,
    returnOobLink: true,
    continueUrl: DASHBOARD_URL,
  });

  console.log(`\n${"=".repeat(72)}`);
  console.log("SEND THIS TO THE CUSTOMER. Single use, expires in about an hour.");
  console.log("It sets the password on their account — treat it as a credential.");
  console.log(`${"=".repeat(72)}\n`);
  console.log(oob.oobLink);
  console.log(`\nThey set a password and land on ${DASHBOARD_URL}\n`);
}

// Only when run directly. The pure helpers above are imported by
// tests/onboardTenant.test.js, and without this guard importing them executes
// the whole script — which surfaced in the test run as an unhandled
// "process.exit unexpectedly called with 1" attributed to the test file, which
// is a long way from naming the cause.
//
// The same accommodation server.js and the dashboard entry point already make,
// and for a second reason: cloudbuild.yaml's smoke step IMPORTS the entry point
// to prove the module tree loads.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}\n`);
    process.exit(1);
  });
}
