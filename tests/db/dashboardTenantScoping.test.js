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

// ---------------------------------------------------------------------------
// §164.312(b) — the DASHBOARD's half of the PHI-access audit trail.
//
// O29 built this for the voice server and stopped there. Found 2026-08-23 by
// running the C8 probe against the live deployment: 15 authenticated
// tenant-scoped API calls produced ZERO phi_access entries, while
// voice-us-staging emits them normally.
//
// That is the wrong way round. O29 audits the RECEPTIONIST writing transcripts.
// The dashboard is the only place a HUMAN BEING reads a transcript, an
// appointment or a caller's phone number, and §164.312(b) exists principally to
// detect inappropriate access BY WORKFORCE MEMBERS. The automated path was
// covered and the human path was not.
//
// These run against real Postgres as vetra_app, because the dashboard's own
// suite fakes withTenant transparently — asserting there would prove things
// about the fake.
// ---------------------------------------------------------------------------
describeDb("the dashboard records PHI access (§164.312(b))", () => {
  const readAuditRows = async () =>
    (
      await admin.query(
        `SELECT actor_type, actor_id, action, operations, resources, resource_ids, row_count
           FROM phi_access_log WHERE business_id = $1 ORDER BY occurred_at`,
        [TENANT_A]
      )
    ).rows;

  /**
   * Wait for `n` audit rows, up to a bound.
   *
   * NOT test tidiness — it exists because of a real property the first version
   * of these tests raced and lost: the handler calls `res.json()` INSIDE the
   * transaction, so supertest's request resolves BEFORE the audit row is
   * inserted and committed. The response genuinely precedes the audit write.
   *
   * Bounded, so a row that never arrives still fails the test rather than
   * hanging or passing.
   */
  const auditRows = async (n = 1) => {
    for (let i = 0; i < 100; i++) {
      const rows = await readAuditRows();
      if (rows.length >= n) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return readAuditRows();
  };

  it("writes one audit row when staff LIST CALLS", async () => {
    const res = await request(app).get("/api/calls");
    expect(res.status).toBe(200);

    const rows = await auditRows(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("user");
    expect(rows[0].actor_id).toBe(STAFF_A);
    expect(rows[0].action).toBe("read");
    expect(rows[0].resources).toContain("calls");
  });

  it("writes one audit row when staff LIST APPOINTMENTS", async () => {
    const res = await request(app).get("/api/appointments");
    expect(res.status).toBe(200);

    const rows = await auditRows(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("read");
    expect(rows[0].resources).toContain("appointments");
  });

  // The difference between an audit trail and a query log. A staff member
  // changing the business's greeting has touched no patient data, and a trail
  // that records it drowns the accesses that matter.
  it("writes NO audit row for a non-PHI route", async () => {
    const res = await request(app).get("/api/knowledge").query({ businessId: TENANT_A });
    expect(res.status).toBe(200);
    // No wait to lose a race against: this asserts a row NEVER appears, so a
    // deliberate pause is what makes the assertion mean anything.
    await new Promise((r) => setTimeout(r, 250));
    expect(await readAuditRows()).toHaveLength(0);
  });

  // Without this the row says "somebody read appointments" and cannot say
  // through WHICH endpoint — and `operations` is exactly the field the voice
  // server uses for that.
  it("records WHICH route was used, not just which table", async () => {
    await request(app).get("/api/calls");
    const rows = await auditRows(1);
    expect(rows[0].operations).toContain("GET /api/calls");
  });

  // O29's whole reason for a GIN index on resource_ids is to answer "who
  // accessed THIS record". A dashboard row with no id cannot answer it, and
  // reading one specific call is the case where the id is known for certain.
  it("records the ROW ID when a route names one, so 'who read this record' is answerable", async () => {
    const { rows: callRows } = await admin.query(
      `SELECT id FROM calls WHERE business_id = $1 LIMIT 1`,
      [TENANT_A]
    );
    const callId = callRows[0].id;

    const res = await request(app).get(`/api/calls/${callId}`);
    expect(res.status).toBe(200);

    const rows = await auditRows(1);
    expect(rows[0].resource_ids).toContain(callId);
  });

  // row_count has to be the number of records actually disclosed. The first
  // version set it to the length of resource_ids, so a list of twenty
  // appointments was recorded as row_count 0 — an auditor reading that would
  // conclude nothing was read. A wrong count in an audit trail is worse than an
  // absent one, because it is believed.
  it("records HOW MANY records were disclosed, not how many ids it happened to know", async () => {
    const res = await request(app).get("/api/appointments").query({ range: "upcoming" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const rows = await auditRows(1);
    expect(rows[0].row_count).toBe(1);
  });

  // One row per UNIT OF WORK, not per statement. /api/calls runs several
  // queries; a per-statement trail would make one staff member opening one page
  // look like a dozen accesses.
  it("writes ONE row per request, not one per statement", async () => {
    await request(app).get("/api/calls");
    await request(app).get("/api/calls");
    expect(await auditRows(2)).toHaveLength(2);
  });
});
