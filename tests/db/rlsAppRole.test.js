import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// The data layer, running as the UNPRIVILEGED application role, under RLS.
//
// tests/db/crossTenantIsolation.test.js proves the DATABASE has the property.
// This proves services/db.js can still function once it does — which is a
// different question, and the one that decides whether B2 lands or explodes.
//
// It matters now because of a fact that is easy to miss: the local `vetra` user
// is a SUPERUSER with rolbypassrls, so RLS is currently inert for the
// application. Cloud SQL does not grant superuser. The moment B2 moves the
// connection string, every policy in migration 029 starts applying to the app,
// and anything that does not work here will not work there.
//
// Probing this before writing a line of it was worth doing: as vetra_app with
// no tenant set, lookupBusinessByPhone returned null, fetchUserByEmail returned
// null, and createCall failed with "new row violates row-level security
// policy". The app would not have answered a single call.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let admin;
let db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  // The role exists with NOLOGIN from migration 029 — the password belongs in
  // Secret Manager, not in a migration file in git. Tests need to log in as it,
  // so they grant that here and nowhere else.
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  for (const [id, name, phone] of [
    [TENANT_A, "Tenant A", "+15551110001"],
    [TENANT_B, "Tenant B", "+15551110002"],
  ]) {
    await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, $2, $3)`, [id, name, phone]);
    await admin.query(`INSERT INTO users (business_id, email) VALUES ($1, $2)`, [id, `staff-${id.slice(0, 8)}@example.com`]);
    await admin.query(`INSERT INTO business_knowledge (business_id, question, answer) VALUES ($1, 'hours', $2)`, [
      id,
      `answer for ${name}`,
    ]);
  }
});

describeDb("bootstrap lookups work without a tenant", () => {
  // They are how the tenant becomes known, so they cannot be scoped to one.
  // Both go through SECURITY DEFINER functions rather than a policy that allows
  // unscoped reads — a policy like that would make "forgot to scope" mean "may
  // see everything", which is the failure RLS exists to prevent.
  it("lookupBusinessByPhone resolves the dialled number", async () => {
    const biz = await db.lookupBusinessByPhone("+15551110001");
    expect(biz?.id).toBe(TENANT_A);
  });

  it("lookupBusinessByPhone still brings capability rows in one round trip", async () => {
    await admin.query(
      `INSERT INTO business_capabilities (business_id, capability_id, enabled) VALUES ($1, 'appointments', true)`,
      [TENANT_A]
    );
    const biz = await db.lookupBusinessByPhone("+15551110001");
    expect(biz.business_capabilities).toHaveLength(1);
  });

  it("fetchUserByEmail resolves an identity to its tenant", async () => {
    const user = await db.fetchUserByEmail(`staff-${TENANT_A.slice(0, 8)}@example.com`);
    expect(user?.business_id).toBe(TENANT_A);
  });

  it("neither leaks the other tenant", async () => {
    const biz = await db.lookupBusinessByPhone("+15551110001");
    expect(biz.id).not.toBe(TENANT_B);
    const user = await db.fetchUserByEmail(`staff-${TENANT_B.slice(0, 8)}@example.com`);
    // Found, because this is the lookup that ESTABLISHES the tenant — and it
    // returns tenant B's own row, not tenant A's.
    expect(user.business_id).toBe(TENANT_B);
  });
});

describeDb("withTenant scopes the connection", () => {
  it("sets the tenant for everything inside", async () => {
    const seen = await db.withTenant(TENANT_A, async (client) => {
      const res = await client.query("SELECT app_current_business_id() AS id");
      return res.rows[0].id;
    });
    expect(seen).toBe(TENANT_A);
  });

  it("a scoped read returns only that tenant's rows", async () => {
    const rows = await db.withTenant(TENANT_A, async (client) => {
      const res = await client.query("SELECT business_id, answer FROM business_knowledge");
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].business_id).toBe(TENANT_A);
  });

  it("a scoped write into ANOTHER tenant is rejected, not silently misfiled", async () => {
    // WITH CHECK, not just USING. Without it a scoped connection could INSERT a
    // row belonging to someone else and then be unable to see it — a write-only
    // cross-tenant leak, discovered much later than a read one.
    await expect(
      db.withTenant(TENANT_A, (client) =>
        client.query(`INSERT INTO business_knowledge (business_id, question, answer) VALUES ($1, 'q', 'a')`, [
          TENANT_B,
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("does not leak the tenant onto the next borrower of that connection", async () => {
    // The reason it is SET LOCAL in a transaction rather than a session-level
    // set_config: a pooled connection is reused, and a scope that outlives the
    // checkout is a cross-tenant read produced by connection reuse — the
    // hardest kind to reproduce and the easiest to ship.
    await db.withTenant(TENANT_A, async () => {});
    const after = await db.currentTenant();
    expect(after).toBeNull();
  });

  it("rolls back and still clears the scope when the body throws", async () => {
    await expect(
      db.withTenant(TENANT_A, async (client) => {
        await client.query(`INSERT INTO business_knowledge (business_id, question, answer) VALUES ($1, 'q', 'a')`, [
          TENANT_A,
        ]);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await db.currentTenant()).toBeNull();

    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM business_knowledge WHERE business_id = $1`, [
      TENANT_A,
    ]);
    expect(rows[0].n).toBe(1); // the seeded row only — the insert rolled back
  });

  it("refuses to run without a tenant rather than running unscoped", async () => {
    await expect(db.withTenant(null, async () => "should not run")).rejects.toThrow(/businessId is required/);
  });
});

describeDb("unscoped access is denied, which is the whole point", () => {
  it("a tenant-scoped read with no tenant set returns nothing", async () => {
    // Not an error — nothing. Every policy compares against a NULL
    // current_setting, NULL comparisons are never true, so default-deny falls
    // out of the semantics rather than needing its own rule.
    const rows = await db.fetchBusinessKnowledge(TENANT_A);
    expect(rows).toEqual([]);
  });

  it("a write with no tenant set is rejected", async () => {
    const id = await db.createCall(TENANT_A, "CA-rls-unscoped", "+15559990000", "+15551110001");
    expect(id).toBeNull();
  });
});
