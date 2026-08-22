import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import request from "supertest";

// The dashboard backend, against a real database, as the UNPRIVILEGED role.
//
// This is the gate B2/B5 needs and the existing dashboard suite cannot give.
// That suite injects a fake pool into require.cache and asserts on the SQL text,
// which proves the query was WRITTEN correctly and nothing about whether it
// returns anything once row-level security applies.
//
// The dashboard has its own pool, is CommonJS (so it cannot import the ESM
// services/db.js), and runs 48 queries of which 23 are hand-filtered by
// business_id. As a non-superuser against an RLS database every one of them
// returns nothing — the dashboard would come up blank the day B2 moves the
// connection string to Cloud SQL, which grants no superuser.
//
// So this boots the REAL express app with the REAL db module pointed at the
// real Postgres as vetra_app, and fakes only the auth middleware — because
// Supabase Auth is what B3 replaces and is not what is under test here.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaa1111";
const TENANT_B = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbb2222";
const STAFF_A = "cccc3333-cccc-4ccc-8ccc-cccccccc3333";
const STAFF_B = "dddd4444-dddd-4ddd-8ddd-dddddddd4444";
const EMAIL_A = "dash-a@example.com";
const EMAIL_B = "dash-b@example.com";

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

/** Boot the dashboard app fresh, with a fake auth middleware and the real pool. */
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
  const loaded = require(path.join(BACKEND, "server.js"));
  return { app: loaded, state };
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
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.query(`DELETE FROM phi_access_log WHERE business_id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await admin.query(`DELETE FROM phi_access_log WHERE business_id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});

  for (const [id, name, phone] of [
    [TENANT_A, "Dash Tenant A", "+15558880001"],
    [TENANT_B, "Dash Tenant B", "+15558880002"],
  ]) {
    await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, $2, $3)`, [id, name, phone]);
    await admin.query(
      `INSERT INTO business_knowledge (business_id, question, answer) VALUES ($1, $2, $3)`,
      [id, `hours for ${name}`, `answer for ${name}`]
    );
    const { rows } = await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status)
       VALUES ($1, $2, '+15551239876', 'completed') RETURNING id`,
      [id, `CA-dash-${id.slice(0, 8)}`]
    );
    await admin.query(
      `INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at)
       VALUES ($1, $2, 'A Patient', '+15551239876', now() + interval '2 days')`,
      [id, rows[0].id]
    );
  }
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, $3, $4)`, [STAFF_A, TENANT_A, EMAIL_A, STAFF_A]);
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, $3, $4)`, [STAFF_B, TENANT_B, EMAIL_B, STAFF_B]);

  authState.user = { id: STAFF_A, email: EMAIL_A };
});

describeDb("the dashboard can read its own tenant under RLS", () => {
  it("resolves the signed-in user to a business at all", async () => {
    // The bootstrap. `select business_id from users where id = $1` is itself
    // RLS'd, so before this it returned nothing and every route below 403'd
    // with "No business linked to this user" — the dashboard would have looked
    // like an authorisation bug rather than a scoping one.
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.needsOnboarding).toBe(false);
    expect(res.body.business?.id).toBe(TENANT_A);
  });

  it("lists the tenant's knowledge base", async () => {
    const res = await request(app).get("/api/knowledge").query({ businessId: TENANT_A });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].answer).toBe("answer for Dash Tenant A");
  });

  it("lists the tenant's calls", async () => {
    const res = await request(app).get("/api/calls");
    expect(res.status).toBe(200);
    const rows = res.body.calls ?? res.body;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("lists the tenant's appointments", async () => {
    const res = await request(app).get("/api/appointments").query({ range: "upcoming" });
    expect(res.status).toBe(200);
    const rows = res.body.appointments ?? res.body;
    expect(rows).toHaveLength(1);
  });

  it("returns the tenant's own settings row", async () => {
    const res = await request(app).get(`/api/businesses/${TENANT_A}`);
    expect(res.status).toBe(200);
    expect(res.body.id ?? res.body.business?.id).toBe(TENANT_A);
  });

  it("counts analytics over its own rows", async () => {
    const res = await request(app).get("/api/usage");
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
  });
});

describeDb("the dashboard cannot read another tenant under RLS", () => {
  it("refuses a knowledge read for a business the user does not own", async () => {
    const res = await request(app).get("/api/knowledge").query({ businessId: TENANT_B });
    expect(res.status).toBe(403);
  });

  it("refuses another tenant's settings row", async () => {
    const res = await request(app).get(`/api/businesses/${TENANT_B}`);
    expect([403, 404]).toContain(res.status);
  });

  it("shows each user only their own tenant's knowledge", async () => {
    authState.user = { id: STAFF_B, email: EMAIL_B };
    const res = await request(app).get("/api/knowledge").query({ businessId: TENANT_B });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].answer).toBe("answer for Dash Tenant B");
  });
});

describeDb("onboarding still works when there is no tenant yet", () => {
  // An Identity Platform account id — 28 alphanumeric characters, NOT a uuid.
  // It used to be a uuid here because Supabase Auth issued uuids, and the
  // bootstrap function's `p_user_id uuid` typechecked by that coincidence
  // alone. Migration 035 retyped it; keeping a uuid in this fixture would have
  // kept the test green against a signup path that 500s in production.
  const NEW_STAFF = "dashProbeAuthUid9Kk3QwZr77xy";
  const NEW_EMAIL = "dash-new@example.com";

  beforeEach(async () => {
    await admin.query(`DELETE FROM users WHERE auth_uid = $1`, [NEW_STAFF]);
    await admin.query(`DELETE FROM users WHERE email = $1`, [NEW_EMAIL]);
    await admin.query(`DELETE FROM businesses WHERE name = 'Brand New Clinic'`);
    authState.user = { id: NEW_STAFF, email: NEW_EMAIL };
  });

  afterAll(async () => {
    await admin?.query(`DELETE FROM users WHERE auth_uid = $1`, [NEW_STAFF]).catch(() => {});
    await admin?.query(`DELETE FROM users WHERE email = $1`, [NEW_EMAIL]).catch(() => {});
    await admin?.query(`DELETE FROM businesses WHERE name = 'Brand New Clinic'`).catch(() => {});
  });

  it("reports that a brand-new account needs onboarding", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.needsOnboarding).toBe(true);
  });

  it("creates the business and links the user", async () => {
    // The bootstrap problem migration 029 did not cover. All three writes here
    // happen BEFORE a tenant exists: insert a users row with a NULL
    // business_id, insert a businesses row, then link them. Under FORCE row
    // security every one violates its WITH CHECK, so signup was broken in a way
    // nothing in the ledger had noticed.
    const res = await request(app)
      .post("/api/onboarding/create-business")
      .send({ name: "Brand New Clinic", timezone: "America/Chicago" });

    expect(res.status).toBe(200);
    expect(res.body.business?.name).toBe("Brand New Clinic");

    // Keyed on auth_uid, not id: `users.id` is generated inside the bootstrap
    // function now and is deliberately NOT the auth account id.
    const linked = await admin.query(
      `SELECT business_id FROM users WHERE auth_uid = $1`,
      [NEW_STAFF]
    );
    expect(linked.rows[0].business_id).toBe(res.body.business.id);
  });

  it("lets the newly onboarded user read their own business immediately after", async () => {
    await request(app)
      .post("/api/onboarding/create-business")
      .send({ name: "Brand New Clinic", timezone: "America/Chicago" });

    const me = await request(app).get("/api/me");
    expect(me.body.needsOnboarding).toBe(false);
    expect(me.body.business?.name).toBe("Brand New Clinic");
  });
});

describeDb("an unauthenticated request never reaches the database", () => {
  it("401s before any tenant is established", async () => {
    authState.user = null;
    const res = await request(app).get("/api/knowledge").query({ businessId: TENANT_A });
    expect(res.status).toBe(401);
  });
});
