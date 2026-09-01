#!/usr/bin/env node
/**
 * Give an imported tenant its first dashboard user (ledger P25).
 *
 *   node scripts/attach-tenant-user.js --business <uuid> --email <addr> --auth-uid <uid> [--confirm]
 *   node scripts/attach-tenant-user.js --phone +441372656055 --email <addr> --auth-uid <uid> [--confirm]
 *
 * DRY RUN unless --confirm.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * scripts/import-tenant.js creates a business and deliberately no dashboard
 * user. Both DSR routes sit behind requireBusinessAccess, which needs an
 * Identity Platform session, and migration 036 keys the tenant lookup on
 * auth_uid. So an imported clinic has no user, therefore no session, therefore
 * no way to exercise Art. 15 or Art. 17 — which is why Phase 5's DSR gate
 * could not be run against the tenant Phase 5 itself imported.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER MATTERS, AND THE OBVIOUS ORDER IS WRONG.
 *
 * Do NOT have the customer sign up through the dashboard first. Onboarding
 * calls app_create_business_for_user (AI-phone-dashboard/backend/src/routes/
 * onboarding.js), which creates a NEW business and attaches them to it. They
 * would then own an empty tenant, and this script would refuse them with
 * "already belongs to a business" — correctly, because repointing an account
 * at a different tenant is how you strand the first one.
 *
 * The working order is:
 *
 *   1. Create the Identity Platform account WITHOUT completing onboarding —
 *      the Identity Platform console, or accounts:batchCreate the way
 *      scripts/import-users.js does it. Keep the localId; that is the auth_uid.
 *   2. Run this script to attach that account to the imported business.
 *   3. They sign in. requireBusinessAccess resolves the tenant from auth_uid
 *      and they land on the imported clinic rather than an onboarding wizard.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NEEDS AN ADMIN CONNECTION
 *
 * app_attach_user_to_business is granted to NOBODY, deliberately. It takes a
 * business id as an argument, so on a request path it would be a tenant-hopping
 * primitive: sign up, call it with somebody else's business id, inherit their
 * clinic. It runs as the migrate job or an operator, never as vetra_app. If a
 * self-serve version is ever wanted, it needs an invitation token checked
 * INSIDE the function — not a GRANT.
 * ---------------------------------------------------------------------------
 */

import "dotenv/config";
import pg from "pg";
import { cloudSqlConfig, cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(
    "\nusage: node scripts/attach-tenant-user.js --email <addr> --auth-uid <uid>\n" +
      "                                          (--business <uuid> | --phone <e164>) [--confirm]\n\n" +
      "  --business   the imported tenant's id\n" +
      "  --phone      resolve the tenant by a dialled number instead\n" +
      "  --email      the address on the Identity Platform account\n" +
      "  --auth-uid   that account's localId — NOT an email, NOT a uuid\n" +
      "  --confirm    actually write. Without it this is a dry run.\n"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--business") out.business = next();
    else if (a === "--phone") out.phone = next();
    else if (a === "--email") out.email = next();
    else if (a === "--auth-uid") out.authUid = next();
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--help" || a === "-h") usage();
    else usage(`unexpected argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.email) usage("--email is required.");
if (!args.authUid) usage("--auth-uid is required.");
if (!args.business && !args.phone) usage("one of --business or --phone is required.");
if (args.business && args.phone) usage("--business and --phone are mutually exclusive.");

// TWO WAYS IN, AND THE SECOND ONE IS THE ONLY ONE THAT WORKS IN PRODUCTION.
//
// This originally read DATABASE_URL and nothing else, which made it unrunnable
// against the estate it was written for: Cloud SQL is private-IP only, so the
// only place this can execute is the migrate job inside the VPC, and that job
// connects through the Cloud SQL connector with CLOUD_SQL_INSTANCE and a
// password — it has no DATABASE_URL at all. So P25 shipped a migration, then a
// script that could not reach the database, and read as closed twice.
//
// Same shape as scripts/migrate.js: prefer the connector when its config is
// present, fall back to a plain URL for the local Docker database.
const sqlCfg = cloudSqlConfig();
let closeConnector = () => {};
let client;

if (sqlCfg) {
  const { poolConfig, close } = await cloudSqlPoolConfig(sqlCfg);
  closeConnector = close;
  client = new pg.Client(poolConfig);
  await client.connect();
  console.log(
    `connected: ${sqlCfg.instance} db=${sqlCfg.database} as ${sqlCfg.user} ` +
      `(${sqlCfg.authType === "PASSWORD" ? "password" : "IAM"})`
  );
} else {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "Neither CLOUD_SQL_INSTANCE nor DATABASE_URL is set. This script needs an ADMIN connection — vetra_app cannot run it."
    );
    process.exit(1);
  }
  client = new pg.Client({ connectionString: url });
  await client.connect();
  console.log(`connected: ${new URL(url).hostname}`);
}

// Never leave a half-attached tenant behind: one transaction, committed only on
// --confirm, rolled back otherwise. That also makes the dry run exercise the
// REAL function rather than a description of it, so "it would work" is measured
// and not asserted.
await client.query("BEGIN");

try {
  let businessId = args.business;

  if (args.phone) {
    // The routing directory is the only lookup that works without already
    // knowing the tenant, which is the whole reason it has no RLS.
    const { rows } = await client.query("SELECT business_id FROM business_directory WHERE phone_number = $1", [
      args.phone,
    ]);
    if (!rows.length) throw new Error(`no tenant routes from ${args.phone}`);
    businessId = rows[0].business_id;
    console.log(`resolved ${args.phone} -> ${businessId}`);
  }

  const { rows } = await client.query("SELECT * FROM app_attach_user_to_business($1, $2, $3)", [
    args.authUid,
    args.email,
    businessId,
  ]);

  const u = rows[0];
  console.log(`\nattached:`);
  console.log(`  user id     ${u.id}`);
  console.log(`  email       ${u.email}`);
  console.log(`  auth_uid    ${u.auth_uid}`);
  console.log(`  business_id ${u.business_id}`);

  // Prove the thing the caller actually cares about, inside the same
  // transaction: that a session for this account will resolve the tenant.
  const check = await client.query("SELECT business_id FROM app_lookup_user_by_auth_uid($1)", [args.authUid]);
  if (check.rows[0]?.business_id !== u.business_id) {
    throw new Error("attached, but app_lookup_user_by_auth_uid does not resolve it — refusing to commit");
  }
  console.log(`  lookup      app_lookup_user_by_auth_uid resolves this tenant`);

  if (args.confirm) {
    await client.query("COMMIT");
    console.log("\nCOMMITTED.");
  } else {
    await client.query("ROLLBACK");
    console.log("\nDRY RUN — rolled back. Everything above actually ran; re-run with --confirm to keep it.");
  }
} catch (err) {
  await client.query("ROLLBACK");
  console.error(`\nFAILED: ${err.message}`);
  if (/already belongs to a business/i.test(err.message)) {
    console.error(
      "  This account already has a tenant. If they signed up through the dashboard first,\n" +
        "  they own an empty business — see the header: create the auth account WITHOUT\n" +
        "  completing onboarding, then attach."
    );
  }
  process.exitCode = 1;
} finally {
  await client.end();
  closeConnector();
}
