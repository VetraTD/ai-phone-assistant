import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";

// ---------------------------------------------------------------------------
// Dialled number -> tenant, under the row-level security that actually applies.
//
// Migration 029's read bootstrap relied on SECURITY DEFINER to escape the
// policy. It does not, because 029 also uses FORCE ROW LEVEL SECURITY, which
// applies to the table owner. The result on Cloud SQL was that the receptionist
// could not resolve ANY dialled number, so every call was answered as unrouted
// voicemail. Migration 033 gives the lookup a scope-free routing table instead.
//
// EVERY TEST HERE RUNS WITH THE FUNCTION OWNED BY A ROLE THAT DOES NOT BYPASS
// RLS. Without that the local superuser owns it, SECURITY DEFINER clears
// everything, and these pass against broken code — which is precisely what
// happened with the write bootstrap before the ownership was reassigned.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// Two roles, because production has two and collapsing them hides the property
// under test. On Cloud SQL `postgres` OWNS the tables and the functions and does
// not bypass RLS; `vetra_app` is the application and has no rights on the
// directory at all. A single role cannot model both.
const OWNER_URL = "postgres://phonedir_owner:probe_only@localhost:55432/vetra";
const APP_URL = "postgres://phonedir_app:probe_only@localhost:55432/vetra";
const FNS = [
  "app_lookup_business_by_phone(text)",
  "app_sync_business_directory()",
];

const BIZ_A = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa";
const BIZ_B = "bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb";
const PHONE_A = "+15550100001";
const PHONE_B = "+15550100002";

let admin;
let probe;

async function seedBusiness(id, name, phone) {
  // Direct insert as the superuser, which bypasses RLS — this is fixture setup,
  // not the behaviour under test.
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone_number = EXCLUDED.phone_number`,
    [id, name, phone]
  );
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  for (const role of ["phonedir_owner", "phonedir_app"]) {
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe_only'`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  }
  // The application must not be able to read the directory. The blanket grant
  // above would undo that, so take it straight back — from the app only. The
  // owner keeps it, exactly as Cloud SQL's postgres does.
  await admin.query(`REVOKE ALL ON business_directory FROM phonedir_app`);

  // Cloud SQL's postgres owns these and does NOT bypass RLS. Match it.
  for (const fn of FNS) {
    await admin.query(`ALTER FUNCTION ${fn} OWNER TO phonedir_owner`);
  }

  probe = new pg.Client({ connectionString: APP_URL });
  await probe.connect();

  await seedBusiness(BIZ_A, "Directory Probe A", PHONE_A);
  await seedBusiness(BIZ_B, "Directory Probe B", PHONE_B);
});

afterEach(async () => {
  await probe?.query("ROLLBACK").catch(() => {});
});

afterAll(async () => {
  if (!url) return;
  await probe?.end().catch(() => {});
  for (const fn of FNS) {
    await admin?.query(`ALTER FUNCTION ${fn} OWNER TO vetra`).catch(() => {});
  }
  await admin?.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [BIZ_A, BIZ_B]).catch(() => {});
  for (const role of ["phonedir_owner", "phonedir_app"]) {
    await admin?.query(`REVOKE ALL ON SCHEMA public FROM ${role}`).catch(() => {});
    await admin?.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => {});
    await admin?.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`).catch(() => {});
    await admin?.query(`DROP OWNED BY ${role}`).catch(() => {});
    await admin?.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  await admin?.end().catch(() => {});
});

describeDb("app_lookup_business_by_phone under FORCE row-level security", () => {
  it("the function owner does NOT bypass RLS — otherwise nothing here proves anything", async () => {
    const r = await admin.query(
      `SELECT r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'app_lookup_business_by_phone'`
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("RESOLVES a dialled number with no tenant scope set — the whole bug", async () => {
    const r = await probe.query(`SELECT id, name FROM app_lookup_business_by_phone($1)`, [PHONE_A]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(BIZ_A);
  });

  it("returns nothing for a number nobody owns", async () => {
    const r = await probe.query(`SELECT id FROM app_lookup_business_by_phone($1)`, ["+15559999999"]);
    expect(r.rows).toHaveLength(0);
  });

  it("returns nothing for null or blank input rather than erroring", async () => {
    expect((await probe.query(`SELECT id FROM app_lookup_business_by_phone(NULL)`)).rows).toHaveLength(0);
    expect((await probe.query(`SELECT id FROM app_lookup_business_by_phone('   ')`)).rows).toHaveLength(0);
  });

  it("does NOT repoint a caller that already declared a tenant", async () => {
    await probe.query("BEGIN");
    await probe.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_B]);
    // Asking for A's number while scoped to B must not hand over A's row, and
    // must not silently move the transaction onto A.
    const r = await probe.query(`SELECT id FROM app_lookup_business_by_phone($1)`, [PHONE_A]);
    const scope = await probe.query(`SELECT current_setting('app.business_id', true) AS s`);
    await probe.query("COMMIT");

    expect(r.rows).toHaveLength(0);
    expect(scope.rows[0].s).toBe(BIZ_B);
  });

  it("the application role CANNOT read the directory directly", async () => {
    // A table without row-level security is only safe while nothing but the
    // bootstrap function can read it. If this ever succeeds, the directory has
    // become a window onto every other tenant's phone number.
    await expect(probe.query(`SELECT * FROM business_directory`)).rejects.toThrow(/permission denied/i);
  });
});

describeDb("business_directory stays true to businesses", () => {
  it("a new business with a number becomes routable immediately", async () => {
    const id = "cccccccc-3333-4333-8333-cccccccccccc";
    const phone = "+15550100003";
    await seedBusiness(id, "Directory Probe C", phone);

    const r = await probe.query(`SELECT id FROM app_lookup_business_by_phone($1)`, [phone]);
    expect(r.rows[0]?.id).toBe(id);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [id]);
  });

  it("changing a number stops the OLD one routing and starts the new one", async () => {
    const id = "dddddddd-3333-4333-8333-dddddddddddd";
    const oldPhone = "+15550100004";
    const newPhone = "+15550100005";
    await seedBusiness(id, "Directory Probe D", oldPhone);
    await admin.query(`UPDATE businesses SET phone_number = $2 WHERE id = $1`, [id, newPhone]);

    // The old number must go dead. Leaving it mapped would route a stranger —
    // a released number gets reissued to somebody else.
    expect((await probe.query(`SELECT id FROM app_lookup_business_by_phone($1)`, [oldPhone])).rows).toHaveLength(0);
    expect((await probe.query(`SELECT id FROM app_lookup_business_by_phone($1)`, [newPhone])).rows[0]?.id).toBe(id);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [id]);
  });

  it("deleting a business stops its number routing", async () => {
    const id = "eeeeeeee-3333-4333-8333-eeeeeeeeeeee";
    const phone = "+15550100006";
    await seedBusiness(id, "Directory Probe E", phone);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [id]);

    expect((await probe.query(`SELECT id FROM app_lookup_business_by_phone($1)`, [phone])).rows).toHaveLength(0);
  });

  it("clearing a number stops it routing without deleting the business", async () => {
    const id = "ffffffff-3333-4333-8333-ffffffffffff";
    const phone = "+15550100007";
    await seedBusiness(id, "Directory Probe F", phone);
    await admin.query(`UPDATE businesses SET phone_number = NULL WHERE id = $1`, [id]);

    expect((await probe.query(`SELECT id FROM app_lookup_business_by_phone($1)`, [phone])).rows).toHaveLength(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [id]);
  });

  it("FORCE row level security is still on after the migration's backfill", async () => {
    // The backfill stands FORCE down briefly. If a failure ever left it off,
    // every tenant policy would silently stop applying to the owner.
    const r = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'businesses'`
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
