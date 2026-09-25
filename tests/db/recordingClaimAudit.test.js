/**
 * The production audit behind `db-inspect --recording-claims` (spec D4), against
 * a real PostgreSQL, as a role that CANNOT bypass row-level security.
 *
 * Why a non-bypassing role: `businesses`, `business_capabilities` and
 * `business_knowledge` are all FORCE ROW LEVEL SECURITY, and Cloud SQL's
 * `postgres` -- what the migrate job connects as -- is rolsuper=false,
 * rolbypassrls=false. Local `vetra` is a superuser and would see every row
 * whether the audit scopes itself correctly or not, so a test run as `vetra`
 * proves nothing (tests/db/importTenant.test.js carries the full history).
 *
 * The audit has to enumerate EVERY tenant, which a tenant-scoped policy makes
 * impossible from `businesses` directly. It walks `business_directory` (no RLS,
 * readable by its owner) and reads each tenant through
 * app_lookup_business_by_phone, which adopts the tenant for the transaction.
 * The test that matters most is therefore "a tenant with a claim is FOUND" --
 * an audit that silently reads zero rows under RLS would otherwise report a
 * clean database.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { auditRecordingClaims, auditIsComplete } from "../../lib/db/recordingClaimAudit.js";

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_ROLE = "claims_probe";
const PROBE_PASS = "probe_only";

const CLEAN = { id: "5a5a0000-0000-4000-8000-000000000001", phone: "+441372990001" };
const GREETING = { id: "5a5a0000-0000-4000-8000-000000000002", phone: "+441372990002" };
const EVERYWHERE = { id: "5a5a0000-0000-4000-8000-000000000003", phone: "+441372990003" };
const OURS = [CLEAN.phone, GREETING.phone, EVERYWHERE.phone];

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
  // In production the migrate job connects as `postgres`, which OWNS
  // app_lookup_business_by_phone and does NOT bypass RLS. Locally the function
  // is owned by the `vetra` superuser, which bypasses RLS whatever the scope --
  // and with that owner, deleting the audit's scope-clearing line stayed GREEN.
  // So the probe role is made the owner for this file, exactly as production
  // is shaped, and ownership goes back to `vetra` in afterAll.
  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO ${PROBE_ROLE}`);

  await admin.query(`DELETE FROM businesses WHERE phone_number = ANY($1)`, [OURS]);
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, greeting) VALUES ($1, 'Clean Co', $2, $3)`,
    [CLEAN.id, CLEAN.phone, "Thanks for calling Clean Co. This call may be transcribed to help us assist you."]
  );
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, greeting) VALUES ($1, 'Greeting Co', $2, $3)`,
    [GREETING.id, GREETING.phone, "Thanks for calling Greeting Co. You're through to our AI receptionist — calls are recorded for quality."]
  );
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, greeting, general_info, custom_instructions,
                             recording_disclosure_enabled, recording_disclosure_text)
     VALUES ($1, 'Everywhere Co', $2, 'Hello.', 'We record all calls.', 'If asked, calls may be monitored or recorded.',
             true, 'This call may be recorded for quality and training purposes.')`,
    [EVERYWHERE.id, EVERYWHERE.phone]
  );
  await admin.query(
    `INSERT INTO business_capabilities (business_id, capability_id, enabled, config)
     VALUES ($1, 'appointments', true, $2)`,
    [EVERYWHERE.id, JSON.stringify({ notes: "Tell them the call is recorded for training." })]
  );
  // A claim split across a line break inside a nested value. JSON.stringify
  // would turn the newline into the two characters "\n", which the patterns'
  // \s+ cannot cross -- so the audit must read the string values themselves.
  await admin.query(
    `INSERT INTO business_capabilities (business_id, capability_id, enabled, config)
     VALUES ($1, 'messages', true, $2)`,
    [EVERYWHERE.id, JSON.stringify({ notes: "Before taking a message: calls are\nrecorded, tell them." })]
  );
  await admin.query(
    `UPDATE businesses SET sms_templates = $2 WHERE id = $1`,
    [EVERYWHERE.id, JSON.stringify({ missed_call: "Sorry we missed you. Calls may be recorded." })]
  );
  await admin.query(
    `INSERT INTO business_knowledge (business_id, question, answer)
     VALUES ($1, 'Is this call recorded?', 'Yes, your call will be recorded.'),
            ($1, 'Opening hours?', 'Nine to five.')`,
    [EVERYWHERE.id]
  );

  const u = new URL(ADMIN_URL);
  u.username = PROBE_ROLE;
  u.password = PROBE_PASS;
  probeUrl = u.toString();
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

async function auditAsProbe() {
  const c = new pg.Client({ connectionString: probeUrl });
  await c.connect();
  try {
    const report = await auditRecordingClaims(c);
    return { ...report, tenants: report.tenants.filter((t) => OURS.includes(t.phone_number)) };
  } finally {
    await c.end();
  }
}

d("recording-claim audit: the probe role is honest", () => {
  it("cannot bypass row-level security, which is what makes the rest of this file mean something", async () => {
    const r = await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [PROBE_ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("owns the lookup function, as production's non-bypassing postgres does", async () => {
    const r = await admin.query(
      `SELECT r.rolname, r.rolbypassrls, r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'app_lookup_business_by_phone'`
    );
    expect(r.rows).toEqual([{ rolname: PROBE_ROLE, rolbypassrls: false, rolsuper: false }]);
  });

  it("really cannot see businesses unscoped, so a naive audit would read zero rows", async () => {
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

d("recording-claim audit: what it finds", () => {
  it("reaches every tenant through the directory, not just the ones RLS happens to show", async () => {
    const report = await auditAsProbe();
    expect(report.tenants.map((t) => t.phone_number).sort()).toEqual([...OURS].sort());
  });

  it("reports a clean tenant as clean", async () => {
    const report = await auditAsProbe();
    const clean = report.tenants.find((t) => t.phone_number === CLEAN.phone);
    expect(clean.claims).toEqual([]);
    expect(clean.disclosure_enabled).toBe(false);
  });

  it("finds the claim in a greeting -- the Digile shape", async () => {
    const report = await auditAsProbe();
    const t = report.tenants.find((x) => x.phone_number === GREETING.phone);
    expect(t.claims).toEqual(["greeting"]);
  });

  it("finds a claim in every place tenant text reaches the prompt", async () => {
    const report = await auditAsProbe();
    const t = report.tenants.find((x) => x.phone_number === EVERYWHERE.phone);
    expect(t.claims).toEqual([
      "general_info",
      "custom_instructions",
      "recording_disclosure_text",
      "sms_templates",
      "capability:appointments",
      "capability:messages",
      "knowledge:1",
    ]);
    expect(t.disclosure_enabled).toBe(true);
  });

  it("still reads every tenant when the connection arrives already scoped to one", async () => {
    // A pooled connection can carry a session-level app.business_id from an
    // earlier question. The lookup function RESPECTS an existing scope, so
    // without the audit clearing it, every other tenant would read as missing.
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      await c.query(`SELECT set_config('app.business_id', $1, false)`, [CLEAN.id]);
      const report = await auditRecordingClaims(c);
      const ours = report.tenants.filter((t) => OURS.includes(t.phone_number)).map((t) => t.phone_number).sort();
      expect(ours).toEqual([...OURS].sort());
      expect(report.unread).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("never returns the text itself, only field names and flags", async () => {
    const report = await auditAsProbe();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/recorded for quality/i);
    expect(serialized).not.toMatch(/Greeting Co/);
  });

  it("counts the tenants it read, so zero can never pass for clean", async () => {
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      const report = await auditRecordingClaims(c);
      expect(report.directory_rows).toBeGreaterThanOrEqual(OURS.length);
      expect(report.tenants_read).toBe(report.directory_rows);
      expect(report.complete).toBe(true);
    } finally {
      await c.end();
    }
  });
});

describe("auditIsComplete", () => {
  // Pure, so it runs without a database. The two ways a zero can pass for
  // clean: an empty directory (wrong database, failed backfill) and a
  // directory number that resolved to no tenant.
  it("refuses an empty directory", () => {
    expect(auditIsComplete({ directory_rows: 0, tenants_read: 0, unread: [] })).toBe(false);
  });
  it("refuses a partial read", () => {
    expect(auditIsComplete({ directory_rows: 3, tenants_read: 2, unread: ["+441372990009"] })).toBe(false);
  });
  it("accepts a full read", () => {
    expect(auditIsComplete({ directory_rows: 3, tenants_read: 3, unread: [] })).toBe(true);
  });
});
