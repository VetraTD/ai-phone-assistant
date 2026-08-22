#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Seed a single synthetic business into a STAGING database, so a test call
// reaches the receptionist instead of the unrouted-voicemail path.
//
//   gcloud run jobs execute vetra-migrate-us-staging --args=scripts/seed-staging.js
//
// WHY THIS EXISTS AS A FILE
//
// The staging database had schema and no rows, so `/twilio/voice` looked the
// number up, found nothing, and correctly refused to impersonate a generic
// office — the caller got voicemail and the media stream never opened, which
// means speech-to-text was never exercised at all.
//
// It is a committed script rather than a shell one-liner because four attempts
// to smuggle equivalent code through `gcloud run jobs execute --args` failed on
// the transport rather than the logic: gcloud splits args on commas, then on
// whatever custom delimiter you choose if it appears in the payload (`|` broke
// on `||`, `@` broke on an email address), and a long payload is truncated
// besides. Fighting the delimiter was the wrong shape of fix.
//
// WHY IT CANNOT JUST INSERT
//
// Migration 029 puts FORCE row-level security on `businesses`, and its WITH
// CHECK is `id = app_current_business_id()`. A brand-new business is by
// definition not the current tenant, and there is no tenant set — creating one
// is what establishes the scope. That is what migration 031's
// `app_create_business_for_user` SECURITY DEFINER function is for, so this uses
// it rather than trying to defeat the policy.
// ---------------------------------------------------------------------------

import pg from "pg";
import { cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";

const PHONE = process.env.SEED_PHONE_NUMBER || "+18176326969";
const NAME = process.env.SEED_BUSINESS_NAME || "Vetra Staging Test Clinic";
// A reserved TLD. It can never receive mail, which is the point: nothing here
// should be able to notify a real person.
const EMAIL = process.env.SEED_USER_EMAIL || "staging-test@vetratd.invalid";
const USER_ID = process.env.SEED_USER_ID || "7a1e9c40-5b2d-4e18-9f33-000000000001";

const database = process.env.CLOUD_SQL_DATABASE || "";
const instance = process.env.CLOUD_SQL_INSTANCE || "";

// ---------------------------------------------------------------------------
// The guard, and it is the only reason this script is safe to keep around.
//
// Seed data in a production database is indistinguishable from a real tenant
// once it is there, and it would answer a real phone number. Refusing on the
// name is cruder than a flag and much harder to get wrong in a hurry.
// ---------------------------------------------------------------------------
if (!/staging/i.test(database) || !/staging/i.test(instance)) {
  console.error(
    `Refusing to seed: this does not look like staging.\n` +
      `  CLOUD_SQL_DATABASE = ${JSON.stringify(database)}\n` +
      `  CLOUD_SQL_INSTANCE = ${JSON.stringify(instance)}\n` +
      "Both must contain 'staging'. A synthetic business in a production database " +
      "is a tenant that answers a real phone number."
  );
  process.exit(1);
}

const cfg = {
  instance,
  database,
  user: process.env.CLOUD_SQL_IAM_USER,
  password: process.env.CLOUD_SQL_PASSWORD,
  authType: process.env.CLOUD_SQL_PASSWORD ? "PASSWORD" : "IAM",
};

const { poolConfig, close } = await cloudSqlPoolConfig(cfg, { connectionTimeoutMillis: 10_000 });
const pool = new pg.Pool(poolConfig);
const client = await pool.connect();

// Real hours, not 24/7.
//
// This was open 00:00-23:59 every day, so the line would answer whenever
// somebody tested it. That worked, and it made the booking behaviour
// meaningless: the assistant offered a SUNDAY appointment, which looked like a
// scheduling bug and was actually the fixture saying Sunday was fine.
//
// A clinic's hours are load-bearing for the thing under test — after-hours
// routing, "we're closed", refusing a weekend slot. Mon-Fri 09:00-17:00 with
// the weekend closed matches the first real customer (Excel Cardiac Care,
// 8-5 M-F, closed weekends) closely enough to exercise the same branches.
//
// The line still ANSWERS out of hours — that is what after_hours_policy is
// for. It just stops pretending it can book you in on a Sunday.
const WEEKDAY = { open: "09:00", close: "17:00", closed: false };
const CLOSED = { open: null, close: null, closed: true };
const HOURS = JSON.stringify({
  mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY,
  sat: CLOSED, sun: CLOSED,
});

try {
  const found = await client.query("SELECT id FROM businesses WHERE phone_number = $1", [PHONE]);
  let id;

  if (found.rows.length) {
    // Idempotent, and it RE-APPLIES the configuration below rather than
    // stopping here — otherwise changing the hours means deleting the tenant
    // by hand first.
    id = found.rows[0].id;
    console.log(`exists: ${id}`);
  } else {
    const made = await client.query(
      "SELECT * FROM app_create_business_for_user($1,$2,$3,$4)",
      [USER_ID, EMAIL, NAME, "America/Chicago"]
    );
    id = made.rows[0].id;
    console.log(`created: ${id}`);
  }

  // Everything past creation is an ordinary tenant-scoped write, so it runs
  // inside the scope RLS expects. SET LOCAL, so it cannot outlive the
  // transaction and leak onto a pooled connection.
  await client.query("BEGIN");
  await client.query("SELECT set_config($1,$2,true)", ["app.business_id", id]);
  const updated = await client.query(
    `UPDATE businesses SET
       phone_number = $2, locale = $3, compliance_tier = $4, greeting = $5,
       business_hours = $6::jsonb, voice_provider = $7, languages_spoken = $8::jsonb,
       after_hours_policy = $9, transfer_policy = $10, notifications_enabled = false
     WHERE id = $1
     RETURNING id, name, phone_number, compliance_tier, voice_provider`,
    [
      id,
      PHONE,
      "en-US",
      // Explicit, though it changes nothing while DEPLOYMENT_MODE=hipaa forces
      // the tier anyway. Says out loud what this row is for.
      "hipaa",
      "Thanks for calling the Vetra staging test line. How can I help?",
      HOURS,
      // ElevenLabs is refused at client construction in hipaa mode. Naming
      // Google keeps the first turn of every call off that error path.
      "google",
      JSON.stringify(["en"]),
      "take_message",
      "always",
    ]
  );
  await client.query("COMMIT");

  console.log("configured:", JSON.stringify(updated.rows[0]));
  const total = await client.query("SELECT count(*)::int AS n FROM businesses");
  console.log(`businesses in ${database}: ${total.rows[0].n}`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("seed failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
  await close?.();
}
