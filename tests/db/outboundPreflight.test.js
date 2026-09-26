/**
 * `db-inspect --outbound-preflight` (go-live pre-deploy, Y1) against a real
 * PostgreSQL, as a role that CANNOT bypass row-level security.
 *
 * Same reasoning as tests/db/recordingClaimAudit.test.js: local `vetra` is a
 * superuser with BYPASSRLS and would pass whether the tenant walk's
 * set_config dance is right or entirely absent. The tenant-walk tests run as
 * `outbound_preflight_probe`, created NOSUPERUSER NOBYPASSRLS, with
 * app_lookup_business_by_phone re-owned to it -- one test asserts both
 * properties rather than trusting them.
 *
 * The privilege-matrix tests need no tenant scope and no non-bypassing role
 * (has_table_privilege/to_regclass read the catalog, which FORCE RLS does not
 * touch), so those run as `admin` (superuser `vetra`) directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  outboundTenantWalk,
  tenantWalkIsComplete,
  outboundPrivileges,
  outboundPreflight,
  EXPECTED_OUTBOUND_PRIVILEGES,
} from "../../lib/db/outboundPreflight.js";

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_ROLE = "outbound_preflight_probe";
const PROBE_PASS = "probe_only";

const CLEAN = { id: "6b6b0000-0000-4000-8000-000000000001", phone: "+441372991001" };
const BUSY = { id: "6b6b0000-0000-4000-8000-000000000002", phone: "+441372991002" };
const OTHER = { id: "6b6b0000-0000-4000-8000-000000000003", phone: "+441372991003" };
const OURS = [CLEAN.phone, BUSY.phone, OTHER.phone];

let admin;
let probeUrl;

const d = ADMIN_URL ? describe : describe.skip;

beforeAll(async () => {
  if (!ADMIN_URL) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO vetra`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await admin.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASS}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  // Production shape: the migrate job's `postgres` owns the lookup function
  // and does not bypass RLS. Locally the function is owned by superuser
  // `vetra`, which would pass this file whether the tenant walk's set_config
  // dance is right or missing entirely.
  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO ${PROBE_ROLE}`);

  await admin.query(`DELETE FROM businesses WHERE phone_number = ANY($1)`, [OURS]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Clean Preflight Co', $2)`, [CLEAN.id, CLEAN.phone]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Busy Preflight Co', $2)`, [BUSY.id, BUSY.phone]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Other Preflight Co', $2)`, [OTHER.id, OTHER.phone]);

  // BUSY: three calls, one legacy webhook integration literally named
  // confirm_identity (services/tools.js:360-372 -- reserved as an engine tool
  // going forward, but a pre-existing row by that name is not renamed and is
  // silently shadowed on outbound calls). Plus one unrelated integration, to
  // prove the WHERE name = 'confirm_identity' filter actually filters.
  for (const sid of ["CApreflight-b1", "CApreflight-b2", "CApreflight-b3"]) {
    await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status) VALUES ($1, $2, '+15550001111', 'completed')`,
      [BUSY.id, sid]
    );
  }
  await admin.query(
    `INSERT INTO integrations (business_id, provider, name) VALUES ($1, 'webhook', 'confirm_identity')`,
    [BUSY.id]
  );
  await admin.query(
    `INSERT INTO integrations (business_id, provider, name) VALUES ($1, 'webhook', 'get_caller_appointments')`,
    [BUSY.id]
  );

  // OTHER: two calls, zero confirm_identity integrations -- exercises totals
  // aggregation across more than one non-zero tenant.
  for (const sid of ["CApreflight-o1", "CApreflight-o2"]) {
    await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status) VALUES ($1, $2, '+15550002222', 'completed')`,
      [OTHER.id, sid]
    );
  }
}, 60000);

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE phone_number = ANY($1)`, [OURS]).catch(() => {});
  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO vetra`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  await admin.end();
});

async function walkAsProbe() {
  const c = new pg.Client({ connectionString: probeUrl });
  await c.connect();
  try {
    const report = await outboundTenantWalk(c);
    return { ...report, tenants: report.tenants.filter((t) => OURS.includes(t.phone_number)) };
  } finally {
    await c.end();
  }
}

d("outbound-preflight: the probe role is honest", () => {
  it("cannot bypass row-level security, which is what makes the tenant-walk tests below mean something", async () => {
    const r = await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [PROBE_ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("really cannot see businesses unscoped, so a naive count would read zero", async () => {
    const u = new URL(ADMIN_URL);
    u.username = PROBE_ROLE;
    u.password = PROBE_PASS;
    probeUrl = u.toString();
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      const r = await c.query(`SELECT count(*)::int AS n FROM businesses WHERE phone_number = ANY($1)`, [OURS]);
      expect(r.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });
});

d("outbound-preflight: tenant walk", () => {
  it("reaches every tenant through the directory, not just the ones RLS happens to show", async () => {
    const report = await walkAsProbe();
    expect(report.tenants.map((t) => t.phone_number).sort()).toEqual([...OURS].sort());
  });

  it("reports a clean tenant's counts as zero", async () => {
    const report = await walkAsProbe();
    const clean = report.tenants.find((t) => t.phone_number === CLEAN.phone);
    expect(clean).toMatchObject({ calls: 0, confirm_identity_integrations: 0 });
  });

  it("counts seeded calls and the confirm_identity integration correctly, filtering out an unrelated one", async () => {
    const report = await walkAsProbe();
    const busy = report.tenants.find((t) => t.phone_number === BUSY.phone);
    expect(busy).toMatchObject({ calls: 3, confirm_identity_integrations: 1 });
  });

  it("counts a second non-zero tenant independently", async () => {
    const report = await walkAsProbe();
    const other = report.tenants.find((t) => t.phone_number === OTHER.phone);
    expect(other).toMatchObject({ calls: 2, confirm_identity_integrations: 0 });
  });

  it("totals add up across every tenant read", async () => {
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      const report = await outboundTenantWalk(c);
      const oursTenants = report.tenants.filter((t) => OURS.includes(t.phone_number));
      const expectedCalls = oursTenants.reduce((s, t) => s + t.calls, 0);
      const expectedConfirm = oursTenants.reduce((s, t) => s + t.confirm_identity_integrations, 0);
      expect(report.totals.calls).toBeGreaterThanOrEqual(expectedCalls);
      expect(report.totals.confirm_identity_integrations).toBeGreaterThanOrEqual(expectedConfirm);
      // Exactly our three tenants' contribution, isolated from whatever else
      // the shared local database carries at this point in the suite.
      expect(oursTenants.reduce((s, t) => s + t.calls, 0)).toBe(5);
      expect(oursTenants.reduce((s, t) => s + t.confirm_identity_integrations, 0)).toBe(1);
    } finally {
      await c.end();
    }
  });

  it("counts the tenants it read, so a full directory reports complete", async () => {
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      const report = await outboundTenantWalk(c);
      expect(report.directory_rows).toBeGreaterThanOrEqual(OURS.length);
      expect(report.tenants_read).toBe(report.directory_rows);
      expect(report.complete).toBe(true);
    } finally {
      await c.end();
    }
  });

  it("still reads every tenant when the connection arrives already scoped to one", async () => {
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      await c.query(`SELECT set_config('app.business_id', $1, false)`, [CLEAN.id]);
      const report = await outboundTenantWalk(c);
      const ours = report.tenants.filter((t) => OURS.includes(t.phone_number)).map((t) => t.phone_number).sort();
      expect(ours).toEqual([...OURS].sort());
      expect(report.unread).toEqual([]);
    } finally {
      await c.end();
    }
  });
});

describe("tenantWalkIsComplete", () => {
  // Pure, so it runs without a database. The two ways a zero can pass for
  // clean: an empty directory (wrong database, failed backfill) and a
  // directory number that resolved to no tenant.
  it("refuses an empty directory", () => {
    expect(tenantWalkIsComplete({ directory_rows: 0, tenants_read: 0, unread: [] })).toBe(false);
  });
  it("refuses a partial read", () => {
    expect(tenantWalkIsComplete({ directory_rows: 3, tenants_read: 2, unread: ["+441372990009"] })).toBe(false);
  });
  it("accepts a full read", () => {
    expect(tenantWalkIsComplete({ directory_rows: 3, tenants_read: 3, unread: [] })).toBe(true);
  });
});

d("outbound-preflight: privilege matrix", () => {
  it("reports ok for every table migrations 042-045 create, on this migrated local database", async () => {
    const { tables, anyMismatch } = await outboundPrivileges(admin);
    expect(tables.map((t) => t.table).sort()).toEqual(Object.keys(EXPECTED_OUTBOUND_PRIVILEGES).sort());
    for (const row of tables) {
      expect(row, JSON.stringify(row)).toMatchObject({ present: true, verdict: "ok" });
    }
    expect(anyMismatch).toBe(false);
  });

  it("the directory tables really do carry no grant to vetra_app -- a real test, not a tautology", async () => {
    const { tables } = await outboundPrivileges(admin);
    for (const t of ["call_attempt_directory", "dial_registry", "outreach_schedule", "postcall_pending"]) {
      const row = tables.find((r) => r.table === t);
      expect(row, t).toMatchObject({ select: false, insert: false, update: false, delete: false, verdict: "ok" });
    }
  });

  it("reports absent, not a crash, for a table that does not exist -- pre-migration shape", async () => {
    const { tables } = await outboundPrivileges(admin);
    // Sanity check the mechanism itself against a name guaranteed absent,
    // rather than assuming to_regclass behaves as documented.
    const priv = await admin.query(`SELECT to_regclass('outbound_table_that_does_not_exist') AS r`);
    expect(priv.rows[0].r).toBeNull();
    expect(tables.every((t) => t.table !== "outbound_table_that_does_not_exist")).toBe(true);
  });

  it("reports MISMATCH when a directory table has been granted a privilege the migrations never gave it", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("GRANT SELECT ON call_attempt_directory TO vetra_app");
      const { tables, anyMismatch } = await outboundPrivileges(admin);
      const row = tables.find((t) => t.table === "call_attempt_directory");
      expect(row).toMatchObject({ present: true, select: true, verdict: "MISMATCH" });
      expect(anyMismatch).toBe(true);
    } finally {
      // Never committed -- the sabotage must not outlive this test.
      await admin.query("ROLLBACK");
    }
  });

  it("the sabotage above did not leak: the grant is gone once rolled back", async () => {
    const { tables } = await outboundPrivileges(admin);
    const row = tables.find((t) => t.table === "call_attempt_directory");
    expect(row).toMatchObject({ select: false, verdict: "ok" });
  });
});

d("outboundPreflight: both sections together", () => {
  it("runs the tenant walk and the privilege matrix on one client and returns both", async () => {
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      const result = await outboundPreflight(c);
      expect(result.tenantWalk.complete).toBe(true);
      expect(result.privileges.anyMismatch).toBe(false);
      expect(result.privileges.tables.length).toBe(Object.keys(EXPECTED_OUTBOUND_PRIVILEGES).length);
    } finally {
      await c.end();
    }
  });
});
