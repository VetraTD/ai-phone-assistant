import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import request from "supertest";

// ---------------------------------------------------------------------------
// The stat tiles count the BUSINESS's day, against a real Postgres.
//
// This cannot be proved anywhere else. The dashboard's own suite injects a
// query mock and asserts on SQL text, which shows the query was written as
// intended and nothing about what Postgres does with it — and the entire
// defect was what Postgres does with it. `started_at::date = CURRENT_DATE`
// casts both sides in the SESSION timezone, which is UTC on Cloud SQL, so a
// call at 23:30 on a British summer evening was counted towards tomorrow and
// every Chicago call after 19:00 was too.
//
// The symptom was four tiles reading 0 beside a list of seventeen calls. The
// list defaults to a seven-day window; the tiles were asking about a different
// day; and nothing on the page said so.
//
// The test seeds one call at each end of the day IN THE TENANT'S TIMEZONE and
// asserts the tile agrees with the person who took the call. Skipped without
// DATABASE_URL, like every other test in this directory.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_UK = "eeee5555-eeee-4eee-8eee-eeeeeeee5555";
const STAFF_UK = "ffff6666-ffff-4fff-8fff-ffffffff6666";
const EMAIL_UK = "tz-uk@example.com";

const require = createRequire(import.meta.url);
const BACKEND = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "AI-phone-dashboard",
  "backend",
  "src"
);

let admin;
let app;
let authState;

function bootApp() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(BACKEND)) delete require.cache[key];
  }
  const state = { user: null };
  const authPath = require.resolve(path.join(BACKEND, "middleware", "authMiddleware.js"));
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: function fakeAuthenticate(req, res, next) {
      if (!state.user) return res.status(401).json({ error: "No authorization header" });
      req.authUser = state.user;
      next();
    },
  };
  return { app: require(path.join(BACKEND, "server.js")), state };
}

/**
 * A timestamptz for "today at HH:MM, in the tenant's own timezone".
 *
 * Built in SQL rather than in JavaScript on purpose: the machine running the
 * tests is on its own timezone, and computing the boundary here would make the
 * test agree with the bug on a UTC laptop and disagree on a British one.
 */
const localToday = (hhmm) =>
  `((now() AT TIME ZONE 'Europe/London')::date + time '${hhmm}') AT TIME ZONE 'Europe/London'`;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  const realUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = APP_URL;
  ({ app, state: authState } = bootApp());
  process.env.DATABASE_URL = realUrl;
}, 40000);

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT_UK]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT_UK]);
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, timezone) VALUES ($1, $2, $3, 'Europe/London')`,
    [TENANT_UK, "Timezone Tenant", "+441372650000"]
  );
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, $3, $4)`, [
    STAFF_UK,
    TENANT_UK,
    EMAIL_UK,
    STAFF_UK,
  ]);
  authState.user = { id: STAFF_UK, email: EMAIL_UK };
});

/** Seed one call at a wall-clock time in the tenant's timezone. */
async function seedCall(hhmm, { status = "completed", sid } = {}) {
  const { rows } = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, started_at)
     VALUES ($1, $2, '+447700900123', $3, ${localToday(hhmm)}) RETURNING id`,
    [TENANT_UK, sid || `CA-tz-${hhmm}-${Math.random().toString(16).slice(2, 8)}`, status]
  );
  return rows[0].id;
}

describeDb("the stat tiles count the business's day", () => {
  it("counts a call taken late in the local evening as today", async () => {
    // 23:30 London. Under British Summer Time that is 22:30 UTC and still
    // today either way; the case that broke was the cast, not the hour, so
    // both ends of the day are seeded and both must land.
    await seedCall("23:30");
    await seedCall("00:15");

    const res = await request(app)
      .get(`/api/analytics/${TENANT_UK}`)
      .set("Authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.calls_today).toBe(2);
  });

  it("does not count yesterday's calls as today", async () => {
    await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, started_at)
       VALUES ($1, 'CA-tz-yesterday', '+447700900123', 'completed',
               ${localToday("12:00")} - interval '1 day')`,
      [TENANT_UK]
    );
    await seedCall("09:00");

    const res = await request(app)
      .get(`/api/analytics/${TENANT_UK}`)
      .set("Authorization", "Bearer t");

    expect(res.body.calls_today).toBe(1);
  });

  it("counts transfers on the same local day as the calls tile", async () => {
    await seedCall("23:30", { status: "transferred" });
    await seedCall("10:00", { status: "completed" });

    const res = await request(app)
      .get(`/api/analytics/${TENANT_UK}`)
      .set("Authorization", "Bearer t");

    expect(res.body.calls_today).toBe(2);
    expect(res.body.transferred_today).toBe(1);
  });

  it("counts appointments booked late in the local evening", async () => {
    const callId = await seedCall("23:30");
    await admin.query(
      `INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at, created_at)
       VALUES ($1, $2, 'A Caller', '+447700900123', now() + interval '2 days', ${localToday("23:30")})`,
      [TENANT_UK, callId]
    );

    const res = await request(app)
      .get(`/api/analytics/${TENANT_UK}`)
      .set("Authorization", "Bearer t");

    expect(res.body.appointments_today).toBe(1);
  });

  it("counts a follow-up whose call row has been deleted", async () => {
    // call_id is ON DELETE SET NULL, so the request outlives its call — and
    // the old query reached customer_requests through a join to calls, which
    // dropped exactly those. A message still needs returning when the call it
    // came from has been erased.
    const callId = await seedCall("11:00");
    await admin.query(
      `INSERT INTO customer_requests (business_id, call_id, request_type, caller_name, created_at)
       VALUES ($1, $2, 'callback', 'A Caller', ${localToday("11:00")})`,
      [TENANT_UK, callId]
    );
    await admin.query(`DELETE FROM calls WHERE id = $1`, [callId]);

    const res = await request(app)
      .get(`/api/analytics/${TENANT_UK}`)
      .set("Authorization", "Bearer t");

    expect(res.body.followups_needed).toBe(1);
  });

  it("does not carry yesterday's follow-ups into today's count", async () => {
    const callId = await seedCall("11:00");
    await admin.query(
      `INSERT INTO customer_requests (business_id, call_id, request_type, caller_name, created_at)
       VALUES ($1, $2, 'callback', 'Old Caller', ${localToday("11:00")} - interval '1 day')`,
      [TENANT_UK, callId]
    );

    const res = await request(app)
      .get(`/api/analytics/${TENANT_UK}`)
      .set("Authorization", "Bearer t");

    expect(res.body.followups_needed).toBe(0);
  });
});
