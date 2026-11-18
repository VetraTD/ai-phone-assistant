import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// A2's gate, and the contract says these must FAIL today.
//
//   "Cross-tenant negative tests are written BEFORE the data-layer rewrite and
//    must demonstrably FAIL against the current service-key client. A negative
//    test that passes on day one is testing nothing."
//
// So this file is expected to be red until A3 and B2 make it green, and a green
// run before then means the test is wrong, not that the database is safe.
//
// ---------------------------------------------------------------------------
// What is actually being asserted
// ---------------------------------------------------------------------------
//
// Not "does services/db.js filter by business_id". It does, wherever
// somebody remembered to. The assertion is that isolation survives a query that
// FORGOT to — that there is a second line of defence underneath the discipline.
//
// Today there is none. `select count(*) from pg_policies` returns 0, and the
// Supabase service key bypasses row-level security by design, so every tenant's
// rows are one missing WHERE clause away from every other tenant's. That is a
// single point of failure spread across 33 exported functions, and §164.312 is
// not satisfied by everyone being careful.
//
// The test speaks SQL rather than calling the data layer on purpose. It has to
// keep meaning the same thing after A3 replaces services/db.js with
// services/db.js, and it must not encode a guess about that module's shape.
// What it encodes instead is the property the database has to have:
//
//   a connection scoped to tenant A, issuing an UNFILTERED select, sees only A.

const url = process.env.DATABASE_URL;

/** The unprivileged role the application will connect as. A superuser — or a table owner — is not subject to RLS, so running these as `vetra` would pass while proving nothing. */
const APP_ROLE = "vetra_app";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * Every table that holds rows belonging to one tenant, and how it gets there.
 *
 * `calls` and `appointments` carry business_id directly. call_transcripts hangs
 * off a call, which is the interesting case: a join-away table is exactly where
 * a hand-written filter gets forgotten.
 */
const TENANT_TABLES = [
  { table: "calls", tenantColumn: "business_id" },
  { table: "appointments", tenantColumn: "business_id" },
  { table: "customer_requests", tenantColumn: "business_id" },
  { table: "business_knowledge", tenantColumn: "business_id" },
  { table: "business_capabilities", tenantColumn: "business_id" },
  { table: "integrations", tenantColumn: "business_id" },
  { table: "users", tenantColumn: "business_id" },
  { table: "call_transcripts", tenantColumn: null }, // reached through calls.id
];

let admin;

const describeDb = url ? describe : describe.skip;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  for (const [id, name] of [
    [TENANT_A, "Tenant A Cardiology"],
    [TENANT_B, "Tenant B Cardiology"],
  ]) {
    await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, $2, $3)`, [
      id,
      name,
      id === TENANT_A ? "+15550000001" : "+15550000002",
    ]);
    const call = await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status) VALUES ($1, $2, $3, 'completed') RETURNING id`,
      [id, `CA-isolation-${id.slice(0, 8)}`, id === TENANT_A ? "+15551110001" : "+15551110002"]
    );
    await admin.query(
      `INSERT INTO call_transcripts (call_id, speaker, message, sequence) VALUES ($1, 'user', $2, 1)`,
      [call.rows[0].id, `transcript belonging to ${name}`]
    );
    await admin.query(
      `INSERT INTO appointments (business_id, call_id, client_name, scheduled_at) VALUES ($1, $2, $3, now())`,
      [id, call.rows[0].id, `Patient of ${name}`]
    );
    await admin.query(
      `INSERT INTO customer_requests (business_id, call_id, request_type, message) VALUES ($1, $2, 'message', $3)`,
      [id, call.rows[0].id, `message for ${name}`]
    );
    await admin.query(`INSERT INTO business_knowledge (business_id, question, answer) VALUES ($1, $2, $3)`, [
      id,
      "where are you",
      `address of ${name}`,
    ]);
    await admin.query(`INSERT INTO business_capabilities (business_id, capability_id, enabled) VALUES ($1, 'appointments', true)`, [id]);
    await admin.query(`INSERT INTO integrations (business_id, provider, name, config) VALUES ($1, 'webhook', $2, '{}')`, [
      id,
      `hook-${id.slice(0, 4)}`,
    ]);
    await admin.query(`INSERT INTO users (business_id, email, auth_uid) VALUES ($1, $2, $3)`, [id, `staff@${id.slice(0, 4)}.example`, `authuid-${id.slice(0, 8)}`]);
  }
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.end();
});

/**
 * A connection as the application role, scoped to one tenant, running one
 * unfiltered query. No WHERE clause: that is the point.
 */
async function selectAllAs(tenantId, sql) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`SET ROLE ${APP_ROLE}`);
    await client.query(`SELECT set_config('app.business_id', $1, false)`, [tenantId]);
    const { rows } = await client.query(sql);
    return rows;
  } finally {
    await client.end();
  }
}

describeDb("cross-tenant isolation at the database layer", () => {
  it(`the application role ${APP_ROLE} exists and is not a superuser`, async () => {
    const { rows } = await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
    expect(rows, `role ${APP_ROLE} does not exist — the app connects as a table owner, which RLS does not apply to`).toHaveLength(1);
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it.each(TENANT_TABLES.map((t) => t.table))("%s has row-level security enabled and forced", async (table) => {
    const { rows } = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
      [table]
    );
    expect(rows).toHaveLength(1);
    // FORCE matters as much as ENABLE: without it the table OWNER is exempt,
    // and the owner is who a naive connection string connects as.
    expect(rows[0].relrowsecurity, `${table} has no RLS`).toBe(true);
    expect(rows[0].relforcerowsecurity, `${table} does not FORCE RLS, so its owner bypasses it`).toBe(true);
  });

  it.each(TENANT_TABLES.filter((t) => t.tenantColumn))(
    "an unfiltered select on $table returns nothing belonging to the other tenant",
    async ({ table, tenantColumn }) => {
      const rows = await selectAllAs(TENANT_A, `SELECT ${tenantColumn} FROM ${table}`);
      const foreign = rows.filter((r) => r[tenantColumn] === TENANT_B);
      expect(foreign, `${table} leaked ${foreign.length} of tenant B's rows to a connection scoped to tenant A`).toEqual([]);
    }
  );

  it("an unfiltered select on call_transcripts returns nothing belonging to the other tenant", async () => {
    // The join-away table. Nothing on the row itself says which tenant it
    // belongs to, which is precisely why a hand-written filter forgets it.
    const rows = await selectAllAs(TENANT_A, `SELECT message FROM call_transcripts`);
    const foreign = rows.filter((r) => String(r.message).includes("Tenant B"));
    expect(foreign, "call_transcripts leaked another tenant's conversation").toEqual([]);
  });

  it("a scoped connection cannot UPDATE another tenant's row", async () => {
    // Reading is the loud failure; writing is the quiet one. A cross-tenant
    // UPDATE that silently affects 0 rows is correct; one that affects 1 is a
    // tenant editing another tenant's records.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`SET ROLE ${APP_ROLE}`);
      await client.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_A]);
      const res = await client.query(`UPDATE businesses SET name = 'pwned' WHERE id = $1`, [TENANT_B]);
      expect(res.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("with no tenant set, a scoped connection sees nothing rather than everything", async () => {
    // The failure mode a default-deny policy is for: a code path that forgets
    // to scope should get an empty result, not the whole table.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`SET ROLE ${APP_ROLE}`);
      const { rows } = await client.query(`SELECT id FROM calls`);
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
