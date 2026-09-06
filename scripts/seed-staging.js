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

// ---------------------------------------------------------------------------
// Locale, timezone, greeting and tier — parameterised 2026-09-04
// ---------------------------------------------------------------------------
//
// These were literals, correct for the one tenant this script existed to make.
// The market is UK first now, and a UK demo tenant needs Europe/London and
// en-GB. The alternative was a second seed script, which is how two seeding
// paths drift until one of them is quietly wrong — this file already carries
// the reasoning about RLS, the bootstrap function and why the hours are what
// they are, and none of that should be duplicated.
//
// EVERY DEFAULT IS BYTE-IDENTICAL TO WHAT IT REPLACED, because the GCP
// `vetra-migrate-us-staging` Cloud Run job runs this with no new variables set
// and must keep producing exactly the row it produced yesterday.
//
// The locale matters more than it looks. lib/voice/live/index.js resolves the
// voice's language as: LIVE_LANGUAGE_CODE → this column → the country of the
// dialled number. A UK number gets en-GB either way, but leaving the column
// empty means the row does not say what it is, and an empty column on the
// deployment is exactly what made the accent fix look done and not be.
const TIMEZONE = process.env.SEED_TIMEZONE || "America/Chicago";
const LOCALE = process.env.SEED_LOCALE || "en-US";
const TIER = process.env.SEED_COMPLIANCE_TIER || "hipaa";

// The greeting is the FIRST THING A CALLER HEARS, so a renamed tenant must not
// keep announcing itself as the staging test line. Derived from the name when
// the name was overridden and no greeting was given; otherwise the original
// literal, unchanged.
const NAME_OVERRIDDEN = Boolean(process.env.SEED_BUSINESS_NAME);
const GREETING =
  process.env.SEED_GREETING ||
  (NAME_OVERRIDDEN
    ? `Thanks for calling ${NAME}. How can I help?`
    : "Thanks for calling the Vetra staging test line. How can I help?");

// Caller-facing SMS follow-ups, off unless asked for (migration 017's default,
// and O25's gate sits on top of it).
//
// Here because there is NO OTHER WAY IN. The staging Cloud SQL instance is
// private-IP only, so a workstation cannot reach it; every path runs through
// this job. Flipping one boolean by hand meant Cloud SQL Studio in a browser
// and remembering that `businesses` is under FORCE row-level security, where an
// unscoped UPDATE matches zero rows and reports success. That is a trap to walk
// into once, not every time somebody wants to test the consent gate.
//
//   gcloud run jobs execute vetra-migrate-us-staging --region=us-central1 \
//     --project=vetra-us-staging-c3a3bd \
//     --args=scripts/seed-staging.js --update-env-vars=SEED_SMS_FOLLOWUP=true
//
// ---------------------------------------------------------------------------
// Seeding the UK DEMO tenant (phase 1, roadmap.md)
// ---------------------------------------------------------------------------
//
// The number is +441372656055, which lives on Twilio ACCOUNT A. Seeding the row
// is only half of making that number work — the deployment answering it also
// needs TWILIO_AUTH_TOKEN_ALT set to account A's token, or every call 403s at
// the webhook. See docs/roadmap.md phase 1 and the twilio-account-topology note.
//
//   DATABASE_URL=... \
//   SEED_PHONE_NUMBER=+441372656055 \
//   SEED_BUSINESS_NAME="<the demo business>" \
//   SEED_TIMEZONE=Europe/London \
//   SEED_LOCALE=en-GB \
//   SEED_COMPLIANCE_TIER=standard \
//   SEED_USER_EMAIL=uk-demo@vetratd.invalid \
//   SEED_USER_ID=7a1e9c40-5b2d-4e18-9f33-000000000002 \
//     node scripts/seed-staging.js
//
// Then seed its knowledge rows with scripts/seed-knowledge.js --phone, or the
// assistant will correctly refuse every question a caller asks (LVX66/LVX67).
const SMS_FOLLOWUP = process.env.SEED_SMS_FOLLOWUP === "true";

const database = process.env.CLOUD_SQL_DATABASE || "";
const instance = process.env.CLOUD_SQL_INSTANCE || "";

// ---------------------------------------------------------------------------
// The guard, and it is the only reason this script is safe to keep around.
//
// Seed data in a production database is indistinguishable from a real tenant
// once it is there, and it would answer a real phone number. Refusing on the
// name is cruder than a flag and much harder to get wrong in a hurry.
//
// WIDENED 2026-09-04, because the original guard checked ONLY the Cloud SQL
// variables and this script now has to seed a UK demo tenant on databases that
// have neither: the local docker rig and Railway, both reached through a plain
// DATABASE_URL. The old check refused those outright — correctly by its own
// logic, and uselessly.
//
// So there are two routes in, and each one has to prove something:
//
//   Cloud SQL   — CLOUD_SQL_DATABASE and CLOUD_SQL_INSTANCE must both say
//                 "staging", exactly as before. Unchanged.
//   DATABASE_URL— allowed without ceremony when the host is obviously local;
//                 anything else needs --confirm.
//
// The --confirm posture is lifted from scripts/seed-knowledge.js rather than
// invented, so the two seeding scripts refuse the same way. The property being
// protected is unchanged: nobody creates a synthetic business in a production
// database by running a command they half-remembered.
// ---------------------------------------------------------------------------
const CONFIRMED = process.argv.slice(2).includes("--confirm");
const usingCloudSql = Boolean(instance);

/** A database URL that is obviously a developer's own machine. */
function looksLocal(url) {
  return /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(String(url));
}

if (usingCloudSql) {
  if (!/staging/i.test(database) || !/staging/i.test(instance)) {
    console.error(
      `Refusing to seed: this does not look like staging.\n` +
        `  CLOUD_SQL_DATABASE = ${JSON.stringify(database)}\n` +
        `  CLOUD_SQL_INSTANCE = ${JSON.stringify(instance)}\n` +
        `Both must contain 'staging'. A synthetic business in a production database ` +
        `is a tenant that answers a real phone number.`
    );
    process.exit(1);
  }
} else {
  const url = process.env.DATABASE_URL || "";
  if (!url) {
    console.error("Refusing to seed: neither CLOUD_SQL_INSTANCE nor DATABASE_URL is set.");
    process.exit(1);
  }
  if (!looksLocal(url) && !CONFIRMED) {
    console.error(
      `Refusing to seed: DATABASE_URL is not obviously a local database and --confirm was not passed.\n` +
        `A synthetic business in a production database is a tenant that answers a real phone number.\n` +
        `If this really is a staging or demo database, re-run with --confirm.`
    );
    process.exit(1);
  }
}

const cfg = {
  instance,
  database,
  user: process.env.CLOUD_SQL_IAM_USER,
  password: process.env.CLOUD_SQL_PASSWORD,
  authType: process.env.CLOUD_SQL_PASSWORD ? "PASSWORD" : "IAM",
};

// Two ways to reach a database, and the Cloud SQL connector is not one of them
// when no instance was named. cfg is built by hand above, so an empty
// `instance` used to be handed to the connector regardless and came back as
// ENOCONNECTIONNAME -- a failure that reads like a broken credential and is
// really "you did not ask for this path".
const { poolConfig, close } = usingCloudSql
  ? await cloudSqlPoolConfig(cfg, { connectionTimeoutMillis: 10_000 })
  : { poolConfig: { connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 }, close: null };
const pool = new pg.Pool(poolConfig);
const client = await pool.connect();

// What the clinic is allowed to DO.
//
// `allowed_tasks` defaults to ["book_appointment"] alone, so cancel_appointment
// and reschedule_appointment were never registered as tools. The model could
// not cancel anything, and "reschedule" became a second booking — which reads
// as the assistant ignoring the request and was really the assistant not having
// the tool.
//
// All four modules, so the whole appointment lifecycle is testable rather than
// just its first step.
const ALLOWED_TASKS = JSON.stringify([
  "book_appointment",
  "check_appointment",
  "cancel_reschedule",
  "quote_request",
]);

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
// Mon-Sat 08:00-20:00, Sunday closed.
//
// The first version was open 24/7, which made booking meaningless — it offered
// a SUNDAY slot. The second was Mon-Fri 09:00-17:00, which was realistic and
// promptly made the line untestable, because the next call happened on a
// Saturday: booking correctly refused and fell through to take-a-message, and
// that looked like a broken booking flow.
//
// This keeps BOTH properties testable. A weekday or Saturday call can book; a
// Sunday call, or any call after 20:00 local, exercises the closed path. The
// fixture should not be the reason a test cannot run, nor the reason a refusal
// looks like a bug.
const OPEN_DAY = { open: "08:00", close: "20:00", closed: false };
const CLOSED = { open: null, close: null, closed: true };
const HOURS = JSON.stringify({
  mon: OPEN_DAY, tue: OPEN_DAY, wed: OPEN_DAY, thu: OPEN_DAY, fri: OPEN_DAY,
  sat: OPEN_DAY, sun: CLOSED,
});

try {
  // Through the bootstrap function, NOT a direct SELECT.
  //
  // `SELECT id FROM businesses WHERE phone_number = $1` returns ZERO ROWS here,
  // however many rows exist: this runs unscoped, and FORCE row-level security
  // binds the migration role like everyone else. The empty result then looked
  // like "not seeded yet", so a re-run took the create branch and was refused
  // with "user already belongs to a business" — the failure landing two steps
  // from its cause.
  //
  // app_lookup_business_by_phone is the one read that works without a tenant,
  // which is the whole point of migration 033, and it is what the receptionist
  // itself uses. Same path, same answer.
  const found = await client.query("SELECT id FROM app_lookup_business_by_phone($1)", [PHONE]);
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
      [USER_ID, EMAIL, NAME, TIMEZONE]
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
       after_hours_policy = $9, transfer_policy = $10, allowed_tasks = $11::jsonb,
       notifications_enabled = false, sms_followup_enabled = $12
     WHERE id = $1
     RETURNING id, name, phone_number, compliance_tier, voice_provider, allowed_tasks, sms_followup_enabled`,
    [
      id,
      PHONE,
      LOCALE,
      // Explicit, though it changes nothing while DEPLOYMENT_MODE=hipaa forces
      // the tier anyway. Says out loud what this row is for.
      TIER,
      GREETING,
      HOURS,
      // ElevenLabs is refused at client construction in hipaa mode. Naming
      // Google keeps the first turn of every call off that error path.
      "google",
      JSON.stringify(["en"]),
      "take_message",
      "always",
      ALLOWED_TASKS,
      SMS_FOLLOWUP,
    ]
  );
  await client.query("COMMIT");

  console.log("configured:", JSON.stringify(updated.rows[0]));
  // Printed because these three decide what a caller HEARS, and none of them
  // appears in the RETURNING clause above.
  console.log(`timezone: ${TIMEZONE}  locale: ${LOCALE}  tier: ${TIER}`);
  console.log(`greeting: ${GREETING}`);
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
