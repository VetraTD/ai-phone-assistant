import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";

// ---------------------------------------------------------------------------
// The onboarding bootstrap, under the row-level security that actually applies.
//
// Migration 031 created `app_create_business_for_user` because a brand-new
// tenant cannot satisfy `WITH CHECK (id = app_current_business_id())` — creating
// the tenant is what establishes the scope. It relied on SECURITY DEFINER to
// get past the policy, and that is not enough: migration 029 uses FORCE ROW
// LEVEL SECURITY, which applies to the table OWNER too. Only BYPASSRLS escapes,
// and Cloud SQL's `postgres` does not have it.
//
// So no business could be created at all — the dashboard's entire signup path.
// It was found by trying to seed one row into staging, not by a test, because
// no test ran this function as a role without BYPASSRLS.
//
// THAT IS THE TRAP THIS FILE EXISTS FOR. The local `vetra` superuser has
// rolbypassrls, so running these as `vetra` passes whether the fix is present
// or not — the same way tests/db/rlsAppRole.test.js warns that RLS is "inert
// for the application" locally. Every test here therefore runs as a role
// created WITHOUT superuser and WITHOUT bypassrls, which is what Cloud SQL
// gives you.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

/** A role shaped like Cloud SQL's `postgres`: owns the schema, bypasses nothing. */
const MIGRATOR_URL = "postgres://bootstrap_probe:probe_only@localhost:55432/vetra";

let admin;
let asMigrator;

const uuid = (n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`.slice(0, 36);

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  await admin.query(`DROP ROLE IF EXISTS bootstrap_probe`).catch(() => {});
  await admin.query(`CREATE ROLE bootstrap_probe LOGIN PASSWORD 'probe_only'`);
  // Owns nothing it does not need, and crucially: NOSUPERUSER, NOBYPASSRLS.
  await admin.query(`GRANT USAGE ON SCHEMA public TO bootstrap_probe`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bootstrap_probe`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO bootstrap_probe`);

  // THE STEP WITHOUT WHICH THIS FILE PROVES NOTHING.
  //
  // SECURITY DEFINER runs as the function's OWNER. Locally that owner is
  // `vetra`, a superuser with rolbypassrls = true, so the function sails past
  // every policy and the tests pass whether the bug is fixed or not — verified
  // by watching all six pass against the broken migration 031.
  //
  // Cloud SQL's `postgres` is a cloudsqlsuperuser with rolbypassrls = FALSE.
  // Reassigning the function to a role shaped like that is what makes the local
  // database behave like the real one.
  await admin.query(
    `ALTER FUNCTION app_create_business_for_user(uuid, text, text, text) OWNER TO bootstrap_probe`
  );

  asMigrator = new pg.Client({ connectionString: MIGRATOR_URL });
  await asMigrator.connect();
});

afterAll(async () => {
  if (!url) return;
  await asMigrator?.end().catch(() => {});
  // Hand the function back before the role can be dropped.
  await admin
    ?.query(`ALTER FUNCTION app_create_business_for_user(uuid, text, text, text) OWNER TO vetra`)
    .catch(() => {});
  await admin?.query(`REVOKE ALL ON SCHEMA public FROM bootstrap_probe`).catch(() => {});
  await admin?.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bootstrap_probe`).catch(() => {});
  await admin?.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM bootstrap_probe`).catch(() => {});
  await admin?.query(`DROP ROLE IF EXISTS bootstrap_probe`).catch(() => {});
  await admin?.end().catch(() => {});
});

// A failed statement inside BEGIN leaves the connection in an aborted
// transaction, and every later test on it then fails with "current transaction
// is aborted" — which looks like four broken tests instead of one. Harmless
// when no transaction is open.
afterEach(async () => {
  await asMigrator?.query("ROLLBACK").catch(() => {});
});

describeDb("app_create_business_for_user under FORCE row-level security", () => {
  it("the probe role really does NOT bypass RLS — otherwise these tests prove nothing", async () => {
    const r = await admin.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'bootstrap_probe'`
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("the function is owned by a role that does NOT bypass RLS, like Cloud SQL's", async () => {
    // If this ever reads true, every other test in this file is vacuous.
    const r = await admin.query(
      `SELECT r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname = 'app_create_business_for_user'`
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("businesses is FORCE row level security, which is what defeats SECURITY DEFINER", async () => {
    const r = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'businesses'`
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("CREATES a business with no tenant scope set — the whole point of a bootstrap", async () => {
    const userId = uuid(9);
    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const r = await asMigrator.query(
      `SELECT id, name FROM app_create_business_for_user($1,$2,$3,$4)`,
      [userId, "bootstrap-probe@vetratd.invalid", "Bootstrap Probe Clinic", "America/Chicago"]
    );

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe("Bootstrap Probe Clinic");

    // And the account is attached, in the same statement, so a users row with a
    // NULL business_id never exists.
    const u = await admin.query(`SELECT business_id FROM users WHERE id = $1`, [userId]);
    expect(u.rows[0].business_id).toBe(r.rows[0].id);

    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [r.rows[0].id]);
  });

  it("RESTORES the caller's tenant scope, so it cannot silently repoint a transaction", async () => {
    const userId = uuid(8);
    const caller = "44444444-4444-4444-8444-444444444444";
    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await asMigrator.query("BEGIN");
    await asMigrator.query(`SELECT set_config('app.business_id', $1, true)`, [caller]);
    const made = await asMigrator.query(
      `SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`,
      [userId, "scope-probe@vetratd.invalid", "Scope Probe Clinic", "UTC"]
    );
    const after = await asMigrator.query(`SELECT current_setting('app.business_id', true) AS scope`);
    await asMigrator.query("COMMIT");

    // Without the restore this would be the NEW business's id, and every
    // subsequent write in the caller's transaction would land on the wrong
    // tenant while looking perfectly ordinary.
    expect(after.rows[0].scope).toBe(caller);

    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [made.rows[0].id]);
  });

  it("still refuses to give one account a second business", async () => {
    const userId = uuid(7);
    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const first = await asMigrator.query(
      `SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`,
      [userId, "twice-probe@vetratd.invalid", "First Clinic", "UTC"]
    );

    await expect(
      asMigrator.query(`SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`, [
        userId,
        "twice-probe@vetratd.invalid",
        "Second Clinic",
        "UTC",
      ])
    ).rejects.toThrow(/already belongs to a business/);

    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [first.rows[0].id]);
  });

  it("a DIRECT insert is still refused — the policy is intact, not relaxed", async () => {
    // The fix must not have widened anything. Creating a tenant is allowed only
    // through the one named, audited function.
    await expect(
      asMigrator.query(`INSERT INTO businesses (name, timezone) VALUES ('Sneaky Clinic','UTC')`)
    ).rejects.toThrow(/row-level security/i);
  });
});
