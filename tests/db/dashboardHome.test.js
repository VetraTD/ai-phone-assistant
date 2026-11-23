// tests/db/dashboardHome.test.js
/**
 * GET /api/home against real Postgres, as vetra_app under FORCE row-level
 * security, with a business in America/Chicago.
 *
 * "Today" is the business's day, not the database's and not the viewer's: a
 * call one second before local midnight belongs to yesterday whatever clock the
 * server or the browser runs on (Review Focus 1). And one tenant never sees
 * another's open items.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import request from "supertest";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_A = "a7a7a7a7-1111-4111-8111-a7a7a7a7a7a7";
const TENANT_B = "b7b7b7b7-2222-4222-8222-b7b7b7b7b7b7";
const STAFF_A = "c7c7c7c7-3333-4333-8333-c7c7c7c7c7c7";
// Not America/Chicago: that is also the fallback timezone, so a silent
// fallback would pass a Chicago test.
const TZ = "Europe/London";

const require = createRequire(import.meta.url);
const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "AI-phone-dashboard", "backend", "src");

let admin;
let app;
let authState;
let localMidnight; // today's 00:00 in Chicago, as a Date

function bootApp() {
  for (const key of Object.keys(require.cache)) if (key.startsWith(BACKEND)) delete require.cache[key];
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

async function call(tenant, sid, startedAt, { request: withRequest = false, handledBy = null, handledAt = null, status = "completed" } = {}) {
  const r = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, started_at, summary, handled_at, handled_by)
     VALUES ($1, $2, '+15550170000', $6, $3, 'Synthetic call.', $4, $5) RETURNING id`,
    [tenant, sid, startedAt, handledAt, handledBy, status]
  );
  const id = r.rows[0].id;
  if (withRequest) {
    // Left during the call, so before anyone could mark it done.
    await admin.query(
      `INSERT INTO customer_requests (business_id, call_id, request_type, caller_name, message, created_at)
       VALUES ($1, $2, 'callback', 'Sample Caller', 'Please ring back', $3)`,
      [tenant, id, startedAt]
    );
  }
  return id;
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  const realUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = APP_URL;
  ({ app, state: authState } = bootApp());
  process.env.DATABASE_URL = realUrl;
  const m = await admin.query(`SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS t`, [TZ]);
  localMidnight = new Date(m.rows[0].t);
}, 40000);

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.query(`DELETE FROM phi_access_log WHERE business_id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  for (const [id, name, phone] of [
    [TENANT_A, "Home Probe A", "+15550170001"],
    [TENANT_B, "Home Probe B", "+15550170002"],
  ]) {
    await admin.query(`INSERT INTO businesses (id, name, phone_number, timezone) VALUES ($1, $2, $3, $4)`, [id, name, phone, TZ]);
  }
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, 'home-a@example.com', $3)`, [STAFF_A, TENANT_A, STAFF_A]);
  authState.user = { id: STAFF_A, email: "home-a@example.com" };
});

describeDb("GET /api/home in the business's timezone", () => {
  it("a call one second before local midnight is yesterday; one second after is today", async () => {
    await call(TENANT_A, "CA_home_before", new Date(localMidnight.getTime() - 1000));
    await call(TENANT_A, "CA_home_after", new Date(localMidnight.getTime() + 1000));
    const res = await request(app).get("/api/home");
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe(TZ);
    expect(res.body.today.answered).toBe(1);
    expect(res.body.doneToday.map((d) => d.startedAt)).toEqual([new Date(localMidnight.getTime() + 1000).toISOString()]);
  });

  it("never shows another tenant's open items", async () => {
    const own = await call(TENANT_A, "CA_home_own", new Date(), { request: true });
    await call(TENANT_B, "CA_home_theirs", new Date(), { request: true });
    const res = await request(app).get("/api/home");
    expect(res.body.openItems.map((i) => i.callId)).toEqual([own]);
    expect(res.body.openItems[0].request).toMatchObject({ type: "callback", callerName: "Sample Caller", message: "Please ring back" });
  });

  it("a call still in progress is not listed as done", async () => {
    await call(TENANT_A, "CA_home_live", new Date(), { status: "in-progress" });
    const res = await request(app).get("/api/home");
    expect(res.body.doneToday).toEqual([]);
  });

  it("a request written after Done opens the item again, and it is not also 'done today'", async () => {
    const id = await call(TENANT_A, "CA_home_late", new Date(Date.now() - 60 * 60 * 1000), {
      request: true, handledBy: STAFF_A, handledAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    // The original request predates Done; a later one (e.g. the post-call check) does not.
    await admin.query(`UPDATE customer_requests SET created_at = now() - interval '50 minutes' WHERE call_id = $1`, [id]);
    await admin.query(
      `INSERT INTO customer_requests (business_id, call_id, request_type, notes) VALUES ($1, $2, 'unconfirmed_claim', 'Follow-up needed: please call them back to confirm.')`,
      [TENANT_A, id]
    );
    const res = await request(app).get("/api/home");
    expect(res.body.openItems.map((i) => i.callId)).toEqual([id]);
    expect(res.body.openItems[0].request).toMatchObject({ type: "unconfirmed_claim", notes: "Follow-up needed: please call them back to confirm." });
    expect(res.body.doneToday.map((d) => d.callId)).not.toContain(id);
  });

  it("another tenant's calls and bookings are never counted", async () => {
    await call(TENANT_A, "CA_home_count_own", new Date());
    const theirs = await call(TENANT_B, "CA_home_count_theirs", new Date());
    await admin.query(
      `INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at) VALUES ($1, $2, 'Other Patient', '+15550170009', now() + interval '1 hour')`,
      [TENANT_B, theirs]
    );
    const res = await request(app).get("/api/home");
    expect(res.body.today).toEqual({ answered: 1, bookingsMade: 0 });
    expect(res.body.todaysBookings).toEqual([]);
    expect(res.body.week.calls).toBe(1);
  });

  it("the week counts moves and cancellations separately from bookings made", async () => {
    const ownCall = await call(TENANT_A, "CA_home_week_changes", new Date());
    const booking = await admin.query(
      `INSERT INTO appointments (business_id, call_id, client_name, scheduled_at) VALUES ($1, $2, 'Sample Caller', now() + interval '2 days') RETURNING id`,
      [TENANT_A, ownCall]
    );
    const apptId = booking.rows[0].id;
    const weekStart = (
      await admin.query(`SELECT date_trunc('week', now() AT TIME ZONE $1) AT TIME ZONE $1 AS t`, [TZ])
    ).rows[0].t;
    await admin.query(
      `INSERT INTO appointment_changes (business_id, appointment_id, call_id, kind, old_scheduled_at, new_scheduled_at, created_at)
       VALUES ($1, $2, $3, 'moved', now() + interval '1 day', now() + interval '2 days', now()),
              ($1, $2, $3, 'cancelled', now() + interval '2 days', NULL, now()),
              ($1, $2, $3, 'moved', now(), now() + interval '1 day', $4::timestamptz - interval '1 hour')`,
      [TENANT_A, apptId, ownCall, weekStart]
    );
    // Another business's change is never counted.
    const theirCall = await call(TENANT_B, "CA_home_week_theirs", new Date());
    const theirs = await admin.query(
      `INSERT INTO appointments (business_id, call_id, scheduled_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
      [TENANT_B, theirCall]
    );
    await admin.query(
      `INSERT INTO appointment_changes (business_id, appointment_id, call_id, kind, old_scheduled_at) VALUES ($1, $2, $3, 'cancelled', now())`,
      [TENANT_B, theirs.rows[0].id, theirCall]
    );
    const res = await request(app).get("/api/home");
    expect(res.body.week).toEqual({ calls: 1, bookingsMade: 1, bookingsMoved: 1, bookingsCancelled: 1 });
  });

  it("an item closed at launch is not 'done today'; one a person closed today is", async () => {
    const now = new Date();
    await call(TENANT_A, "CA_home_launch", new Date(now.getTime() - 9 * 86400000), { request: true, handledBy: "launch", handledAt: now });
    const byPerson = await call(TENANT_A, "CA_home_person", new Date(now.getTime() - 2 * 86400000), {
      request: true, handledBy: STAFF_A, handledAt: now,
    });
    const res = await request(app).get("/api/home");
    const done = res.body.doneToday.map((d) => d.callId);
    expect(done).toEqual([byPerson]);
    expect(res.body.doneToday[0]).toMatchObject({ hadRequest: true, handledBy: STAFF_A });
    expect(res.body.openItems).toEqual([]);
  });
});
