/**
 * Settings > Usage counts the month in the BUSINESS's timezone.
 *
 * /api/usage used `date_trunc('month', CURRENT_DATE)`, the database's month
 * (UTC): a call at 11:30 pm on the last evening of October in Chicago landed in
 * November's count.
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

const TENANT_A = "a9a9a9a9-1111-4111-8111-a9a9a9a9a9a9";
const TENANT_B = "b9b9b9b9-2222-4222-8222-b9b9b9b9b9b9";
const STAFF_A = "c9c9c9c9-3333-4333-8333-c9c9c9c9c9c9";
const TZ = "America/Chicago";

const require = createRequire(import.meta.url);
const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "AI-phone-dashboard", "backend", "src");

let admin;
let app;
let authState;
let monthStart; // the 1st at 00:00 in Chicago, as a Date

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
  return { app: require(path.join(BACKEND, "server.js")), state };
}

let sid = 0;
async function callAt(tenant, when, seconds = 60) {
  sid += 1;
  await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, started_at, duration_seconds, summary)
     VALUES ($1, $2, '+15550190000', 'completed', $3, $4, 'Synthetic call.')`,
    [tenant, `CAusage${Date.now()}${sid}`, when, seconds]
  );
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
  const m = await admin.query(`SELECT date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1 AS t`, [TZ]);
  monthStart = new Date(m.rows[0].t);
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
    [TENANT_A, "Usage Probe A", "+15550190001"],
    [TENANT_B, "Usage Probe B", "+15550190002"],
  ]) {
    await admin.query(`INSERT INTO businesses (id, name, phone_number, timezone) VALUES ($1, $2, $3, $4)`, [id, name, phone, TZ]);
  }
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, 'usage-a@example.com', $3)`, [STAFF_A, TENANT_A, STAFF_A]);
  authState.user = { id: STAFF_A, email: "usage-a@example.com" };
});

describeDb("GET /api/usage", () => {
  it("counts the month in the business's time zone", async () => {
    const minutes = (n) => new Date(monthStart.getTime() + n * 60 * 1000);
    await callAt(TENANT_A, minutes(30), 150);
    // The last evening of last month in Chicago: already this month in UTC.
    await callAt(TENANT_A, minutes(-30), 600);
    await callAt(TENANT_B, minutes(60), 600);
    const res = await request(app).get("/api/usage");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ calls_this_month: 1, minutes_this_month: 2 });
  });
});
