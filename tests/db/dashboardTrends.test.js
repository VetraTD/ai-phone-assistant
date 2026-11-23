/**
 * Call trends' "outside opening hours" figure uses the business's OWN opening
 * hours, on its clock.
 *
 * /api/analytics-breakdown counted a fixed 9 am to 5 pm, every day: a practice
 * open 8 to 6 saw its 8:30 and 5:30 calls as "outside", and a Saturday call
 * while it was closed as "inside". The rule here is the one the receptionist
 * uses on a call (isBusinessOpen + resolveDayHours): weekly shape by day, the
 * legacy single window every day, a closed day is outside, no hours set means
 * no figure at all.
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

const TENANT = "a8a8a8a8-1111-4111-8111-a8a8a8a8a8a8";
const STAFF = "c8c8c8c8-3333-4333-8333-c8c8c8c8c8c8";
const TZ = "America/Chicago";

const OPEN_8_TO_6_WEEKDAYS = {
  mon: { open: "08:00", close: "18:00", closed: false },
  tue: { open: "08:00", close: "18:00", closed: false },
  wed: { open: "08:00", close: "18:00", closed: false },
  thu: { open: "08:00", close: "18:00", closed: false },
  fri: { open: "08:00", close: "18:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};

const require = createRequire(import.meta.url);
const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "AI-phone-dashboard", "backend", "src");

let admin;
let app;
let authState;

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
/** A call at a clock time on a day of LAST week, in Chicago (0 = Monday, 5 = Saturday). */
async function callAtLocal(day, hhmm) {
  sid += 1;
  await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, started_at, summary)
     VALUES ($1, $2, '+15550180000', 'completed',
             ((date_trunc('week', now() AT TIME ZONE $3) - interval '7 days') + make_interval(days => $4) + $5::time) AT TIME ZONE $3,
             'Synthetic call.')`,
    [TENANT, `CAtrends${Date.now()}${sid}`, TZ, day, hhmm]
  );
}

async function setHours(hours) {
  await admin.query(`UPDATE businesses SET business_hours = $2 WHERE id = $1`, [TENANT, hours === null ? null : JSON.stringify(hours)]);
}

async function openingHoursFigure() {
  const res = await request(app).get("/api/analytics-breakdown").query({ period: "30d" });
  expect(res.status).toBe(200);
  return res.body.business_hours;
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
}, 40000);

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]).catch(() => {});
  await admin.query(`DELETE FROM phi_access_log WHERE business_id = $1`, [TENANT]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number, timezone) VALUES ($1, 'Trends Probe', '+15550180001', $2)`, [TENANT, TZ]);
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, 'trends@example.com', $3)`, [STAFF, TENANT, STAFF]);
  authState.user = { id: STAFF, email: "trends@example.com" };
});

describeDb("GET /api/analytics-breakdown — calls outside opening hours", () => {
  it("uses the business's own weekly hours, on its clock", async () => {
    await setHours(OPEN_8_TO_6_WEEKDAYS);
    await callAtLocal(0, "08:30"); // open (a fixed 9-5 said outside)
    await callAtLocal(0, "17:30"); // open (a fixed 9-5 said outside)
    await callAtLocal(0, "18:00"); // closing time itself is closed
    await callAtLocal(5, "10:00"); // Saturday: closed all day (a fixed 9-5 said inside)
    expect(await openingHoursFigure()).toMatchObject({ in_hours: 2, out_hours: 2, opening_hours_set: true, timezone: TZ });
  });

  it("applies the older single-window hours to every day", async () => {
    await setHours({ open_time: "10:00", close_time: "14:00" });
    await callAtLocal(5, "11:00"); // Saturday inside the window
    await callAtLocal(0, "09:30"); // before opening
    expect(await openingHoursFigure()).toMatchObject({ in_hours: 1, out_hours: 1, opening_hours_set: true });
  });

  it("gives no figure when the business has no opening hours set", async () => {
    await setHours(null);
    await callAtLocal(0, "03:00");
    expect(await openingHoursFigure()).toMatchObject({ opening_hours_set: false });
  });
});
