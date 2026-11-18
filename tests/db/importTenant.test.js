/**
 * `scripts/import-tenant.js` against a real PostgreSQL, as a role that CANNOT
 * bypass row-level security.
 *
 * THE REASON THIS FILE IS SHAPED THE WAY IT IS: local `vetra` is a superuser
 * with `rolbypassrls = true`, so it sails past every policy. Cloud SQL's
 * `postgres` — which is what the migrate job actually connects as — is
 * `rolsuper = false, rolbypassrls = false`, and `businesses` carries FORCE ROW
 * LEVEL SECURITY, which binds the table owner too. So a test run as `vetra`
 * would pass whether the import's `set_config` dance is right or completely
 * absent. This repository has already paid for that lesson three times: six
 * tests passed against a bootstrap function that was broken on Cloud SQL.
 *
 * Every test here therefore runs as `import_probe`, created NOSUPERUSER
 * NOBYPASSRLS, and one test ASSERTS THAT PROPERTY rather than trusting it —
 * because if the role ever gained bypassrls the rest of the file would go green
 * and stop checking anything.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { parsePayload, importTenant } from "../../scripts/import-tenant.js";

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_ROLE = "import_probe";
const PROBE_PASS = "probe_only";

let admin;
let probeUrl;

const CONFIG = {
  business: {
    name: "Probe Media",
    phone_number: "+441372000001",
    timezone: "Europe/London",
    greeting: "Thanks for calling Probe Media.",
    business_hours: { mon: { open: "09:00", close: "17:00", closed: false } },
    allowed_tasks: ["book_appointment"],
    languages_spoken: ["en"],
    voice_provider: "elevenlabs",
    voice_id: "TESTVOICEID",
    notifications_enabled: true,
  },
  capabilities: [{ capability_id: "appointments", enabled: true }],
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  // REVOKE BEFORE DROP, and no silent catch on the drop itself.
  //
  // `DROP ROLE` fails while the role still holds grants, and the first version
  // of this file swallowed that with `.catch(() => {})` — so a leftover role
  // from a previous run made the NEXT run fail in `CREATE ROLE` with "already
  // exists", which points at the wrong statement entirely. A cleanup that hides
  // its own failure is worse than no cleanup.
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await admin.query(
    `CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASS}' NOSUPERUSER NOBYPASSRLS`
  );
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);

  const u = new URL(ADMIN_URL);
  u.username = PROBE_ROLE;
  u.password = PROBE_PASS;
  probeUrl = u.toString();
}, 60000);

afterAll(async () => {
  if (admin) {
    await admin
      .query(`DELETE FROM businesses WHERE phone_number LIKE '+44137200%'`)
      .catch(() => {});
    await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
    await admin.end();
  }
});

async function asProbe(fn) {
  const c = new pg.Client({ connectionString: probeUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("import-tenant: the probe role is honest", () => {
  it("cannot bypass row-level security, which is what makes every other test here mean something", async () => {
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [PROBE_ROLE]
    );
    expect(r.rows[0].rolsuper).toBe(false);
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("businesses really is FORCE row-level security, so the insert is a real test", async () => {
    const r = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'businesses'`
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
    expect(r.rows[0].relforcerowsecurity).toBe(true);
  });
});

describe("import-tenant: parsePayload", () => {
  it("refuses a payload carrying patient data, before any connection is opened", () => {
    for (const t of ["calls", "call_transcripts", "appointments", "sms_consents", "phi_access_log"]) {
      expect(() =>
        parsePayload(Buffer.from(JSON.stringify({ business: CONFIG.business, [t]: [] })).toString("base64"))
      ).toThrow(/CONFIGURATION ONLY/);
    }
  });

  it("ignores unknown fields rather than failing, so a source one migration behind still imports", () => {
    const p = parsePayload(
      Buffer.from(
        JSON.stringify({ business: { ...CONFIG.business, default_language: "en", city: "London" } })
      ).toString("base64")
    );
    expect(p.ignored).toEqual(expect.arrayContaining(["default_language", "city"]));
    expect(p.business.name).toBe("Probe Media");
  });

  it("requires name and timezone", () => {
    expect(() => parsePayload(Buffer.from(JSON.stringify({ business: { name: "x" } })).toString("base64"))).toThrow(
      /timezone is required/
    );
  });

  it("rejects an unset or non-base64 payload with a message naming the variable", () => {
    expect(() => parsePayload("")).toThrow(/IMPORT_TENANT_B64 is not set/);
    expect(() => parsePayload("not-json-at-all")).toThrow(/not JSON|not valid base64/);
  });
});

describe("import-tenant: against FORCE RLS as a non-bypassing role", () => {
  const b64 = Buffer.from(JSON.stringify(CONFIG)).toString("base64");

  it("creates the tenant, and the row is visible through RLS afterwards", async () => {
    const row = await asProbe((c) => importTenant(c, parsePayload(b64)));
    expect(row.name).toBe("Probe Media");
    expect(row.phone_number).toBe("+441372000001");

    const seen = await admin.query(`SELECT name, timezone, voice_id FROM businesses WHERE id = $1`, [row.id]);
    expect(seen.rows[0].name).toBe("Probe Media");
    expect(seen.rows[0].timezone).toBe("Europe/London");
    expect(seen.rows[0].voice_id).toBe("TESTVOICEID");
  });

  it("routes the number — business_directory is what makes a call resolve at all", async () => {
    const d = await admin.query(
      `SELECT business_id FROM business_directory WHERE phone_number = '+441372000001'`
    );
    expect(d.rowCount).toBe(1);
  });

  it("copies capability rows", async () => {
    const c = await admin.query(
      `SELECT capability_id, enabled FROM business_capabilities
        WHERE business_id = (SELECT business_id FROM business_directory WHERE phone_number = '+441372000001')`
    );
    expect(c.rows.map((r) => r.capability_id)).toContain("appointments");
  });

  it("is idempotent — a second run UPDATES rather than creating a second tenant on one number", async () => {
    const changed = { ...CONFIG, business: { ...CONFIG.business, greeting: "Second run." } };
    await asProbe((c) =>
      importTenant(c, parsePayload(Buffer.from(JSON.stringify(changed)).toString("base64")))
    );
    const r = await admin.query(`SELECT id, greeting FROM businesses WHERE phone_number = '+441372000001'`);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].greeting).toBe("Second run.");
  });

  it("writes NOTHING to any PHI table", async () => {
    const bid = (
      await admin.query(`SELECT business_id FROM business_directory WHERE phone_number = '+441372000001'`)
    ).rows[0].business_id;
    for (const t of ["calls", "appointments", "customer_requests", "sms_consents"]) {
      const n = await admin.query(`SELECT count(*)::int AS n FROM ${t} WHERE business_id = $1`, [bid]);
      expect(n.rows[0].n, `${t} should be untouched`).toBe(0);
    }
  });

  it("a write the DATABASE refuses leaves nothing behind", async () => {
    // `locale` carries a real CHECK constraint, so this fails in postgres
    // rather than in our validation — which is the point: it exercises the
    // BEGIN/ROLLBACK wrapper rather than the guard in parsePayload.
    const bad = {
      business: { ...CONFIG.business, phone_number: "+441372000002", locale: "en-XX" },
    };
    await expect(
      asProbe((c) => importTenant(c, parsePayload(Buffer.from(JSON.stringify(bad)).toString("base64"))))
    ).rejects.toThrow();

    const r = await admin.query(
      `SELECT count(*)::int AS n FROM businesses WHERE phone_number = '+441372000002'`
    );
    expect(r.rows[0].n).toBe(0);
    // The directory row is written by a TRIGGER on the insert, so checking it
    // separately proves the rollback reached the trigger's work too.
    const d = await admin.query(
      `SELECT count(*)::int AS n FROM business_directory WHERE phone_number = '+441372000002'`
    );
    expect(d.rows[0].n).toBe(0);
  });

  it("refuses a bogus timezone that the DATABASE WOULD HAVE ACCEPTED", async () => {
    // The finding this test exists for: `businesses.timezone` has no CHECK
    // constraint. Before the guard, "Not/AZone" inserted successfully and the
    // damage surfaced later as wrong opening hours on a live call.
    const bad = { business: { ...CONFIG.business, phone_number: "+441372000003", timezone: "Not/AZone" } };
    expect(() => parsePayload(Buffer.from(JSON.stringify(bad)).toString("base64"))).toThrow(
      /not a recognised IANA time zone/
    );

    // Sabotage-check in the other direction: real zones must still pass, or the
    // guard is just a blocker wearing a validation costume.
    for (const tz of ["Europe/London", "America/Chicago", "Europe/Kyiv", "Asia/Kolkata"]) {
      expect(() =>
        parsePayload(Buffer.from(JSON.stringify({ business: { ...CONFIG.business, timezone: tz } })).toString("base64"))
      ).not.toThrow();
    }
  });
});
