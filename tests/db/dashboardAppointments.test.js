/**
 * The Calendar's bookings and "Email me bookings", in the BUSINESS's days.
 *
 * Both routes used `scheduled_at::date = CURRENT_DATE`, which is the database's
 * day (UTC): an 11:30 pm booking in Chicago was "tomorrow", and the email
 * counted bookings through `calls.business_id` (missing any booking without a
 * call) and counted cancelled ones as scheduled.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import request from "supertest";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_A = "a8a8a8a8-1111-4111-8111-a8a8a8a8a8a8";
const TENANT_B = "b8b8b8b8-2222-4222-8222-b8b8b8b8b8b8";
const STAFF_A = "c8c8c8c8-3333-4333-8333-c8c8c8c8c8c8";
const TZ = "America/Chicago";
const RANGE_ERROR = "Choose a date range of up to six weeks.";

const require = createRequire(import.meta.url);
const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "AI-phone-dashboard", "backend", "src");

const sendMail = vi.fn(async () => ({}));
let admin;
let app;
let authState;
let localMidnight; // today's 00:00 in Chicago, as a Date

function stub(relPath, exports) {
  const p = require.resolve(path.join(BACKEND, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function bootApp() {
  for (const key of Object.keys(require.cache)) if (key.startsWith(BACKEND)) delete require.cache[key];
  const state = { user: null };
  stub(path.join("middleware", "authMiddleware.js"), function fakeAuthenticate(req, res, next) {
    if (!state.user) return res.status(401).json({ error: "No authorization header" });
    req.authUser = state.user;
    next();
  });
  stub(path.join("services", "mailer.js"), { isConfigured: () => true, sendMail });
  return { app: require(path.join(BACKEND, "server.js")), state };
}

/** A booking at a Chicago wall-clock time ("2026-12-10 23:30"). */
async function bookAtLocal(tenant, local, { status = "scheduled", name = "Sample Caller" } = {}) {
  const r = await admin.query(
    `INSERT INTO appointments (business_id, client_name, scheduled_at, status)
     VALUES ($1, $2, ($3::timestamp AT TIME ZONE '${TZ}'), $4) RETURNING id`,
    [tenant, name, local, status]
  );
  return r.rows[0].id;
}

async function bookAt(tenant, when, { status = "scheduled" } = {}) {
  const r = await admin.query(
    `INSERT INTO appointments (business_id, client_name, scheduled_at, status) VALUES ($1, 'Sample Caller', $2, $3) RETURNING id`,
    [tenant, when, status]
  );
  return r.rows[0].id;
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
  sendMail.mockClear();
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  for (const [id, name, phone] of [
    [TENANT_A, "Appointments Probe A", "+15550180001"],
    [TENANT_B, "Appointments Probe B", "+15550180002"],
  ]) {
    await admin.query(
      `INSERT INTO businesses (id, name, phone_number, timezone, notification_email) VALUES ($1, $2, $3, $4, $5)`,
      [id, name, phone, TZ, `frontdesk-${phone.slice(-1)}@brightwork.example`]
    );
  }
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, 'appts-a@example.com', $3)`, [STAFF_A, TENANT_A, STAFF_A]);
  authState.user = { id: STAFF_A, email: "appts-a@example.com" };
});

describeDb("GET /api/appointments?from&to in the business's days", () => {
  it("returns bookings in the business's days, not the database's", async () => {
    await bookAtLocal(TENANT_A, "2026-12-03 23:50", { name: "Before" });
    const first = await bookAtLocal(TENANT_A, "2026-12-04 00:10", { name: "First" });
    const last = await bookAtLocal(TENANT_A, "2026-12-10 23:30", { name: "Last" });
    await bookAtLocal(TENANT_A, "2026-12-11 00:10", { name: "After" });
    const res = await request(app).get("/api/appointments").query({ from: "2026-12-04", to: "2026-12-10" });
    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.id)).toEqual([first, last]);
    expect(Object.keys(res.body[0]).sort()).toEqual(
      ["call_id", "client_name", "client_phone", "id", "notes", "scheduled_at", "status"].sort()
    );
  });

  it("never returns another business's bookings", async () => {
    const own = await bookAtLocal(TENANT_A, "2026-12-07 10:00");
    await bookAtLocal(TENANT_B, "2026-12-07 10:00");
    const res = await request(app).get("/api/appointments").query({ from: "2026-12-07", to: "2026-12-07" });
    expect(res.body.map((a) => a.id)).toEqual([own]);
  });

  it("rejects a range it cannot serve", async () => {
    for (const q of [
      { from: "2026-13-01", to: "2026-13-02" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-11-30", to: "2026-11-23" },
      { from: "2026-11-01", to: "2026-12-13" },
      { from: "2026-11-23" },
    ]) {
      const res = await request(app).get("/api/appointments").query(q);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body.error).toBe(RANGE_ERROR);
    }
  });

  it("still serves ?range=today, in the business's today", async () => {
    // Chicago's day spans two UTC dates, so a UTC "today" always misses either
    // the morning booking or the late one, whatever the hour the test runs.
    const morning = await bookAt(TENANT_A, new Date(localMidnight.getTime() + 9 * 60 * 60 * 1000));
    const late = await bookAt(TENANT_A, new Date(localMidnight.getTime() + (23 * 60 + 30) * 60 * 1000));
    await bookAt(TENANT_A, new Date(localMidnight.getTime() - 10 * 60 * 1000));
    const res = await request(app).get("/api/appointments").query({ range: "today" });
    expect(res.body.map((a) => a.id)).toEqual([morning, late]);
  });
});

describeDb("POST /api/appointments/email", () => {
  it("counts only this business's live bookings in its own today", async () => {
    const at = (minutes) => new Date(localMidnight.getTime() + minutes * 60 * 1000);
    await bookAt(TENANT_A, at(9 * 60));
    await bookAt(TENANT_A, at(14 * 60));
    // 23:30 in Chicago is already tomorrow in UTC.
    await bookAt(TENANT_A, at(23 * 60 + 30));
    await bookAt(TENANT_A, at(10 * 60), { status: "cancelled" });
    await bookAt(TENANT_B, at(11 * 60));
    const res = await request(app).post("/api/appointments/email").send({ range: "today" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 3 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe("frontdesk-1@brightwork.example");
  });
});
