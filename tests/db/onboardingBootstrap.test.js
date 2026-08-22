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

// An Identity Platform account id, not a uuid — 28 alphanumeric characters.
// The old signature took `p_user_id uuid` and the dashboard passed it the auth
// provider's id, which typechecked ONLY because Supabase Auth issued uuids.
// Identity Platform's does not, and the real error was:
//   invalid input syntax for type uuid: "7Ziacgk6NkY3lKC6dXu3VthNO1Y2"
// See migration 035.
const authUid = (n) => `probeAuthUid${String(n).repeat(4)}Kk9QwZr77`.slice(0, 28);

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
    `ALTER FUNCTION app_create_business_for_user(text, text, text, text) OWNER TO bootstrap_probe`
  );

  asMigrator = new pg.Client({ connectionString: MIGRATOR_URL });
  await asMigrator.connect();
});

afterAll(async () => {
  if (!url) return;
  await asMigrator?.end().catch(() => {});
  // Hand the function back before the role can be dropped.
  await admin
    ?.query(`ALTER FUNCTION app_create_business_for_user(text, text, text, text) OWNER TO vetra`)
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
    const uid = authUid(9);
    await admin.query(`DELETE FROM users WHERE auth_uid = $1`, [uid]);

    const r = await asMigrator.query(
      `SELECT id, name FROM app_create_business_for_user($1,$2,$3,$4)`,
      [uid, "bootstrap-probe@vetratd.invalid", "Bootstrap Probe Clinic", "America/Chicago"]
    );

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe("Bootstrap Probe Clinic");

    // And the account is attached, in the same statement, so a users row with a
    // NULL business_id never exists.
    const u = await admin.query(`SELECT business_id, id FROM users WHERE auth_uid = $1`, [uid]);
    expect(u.rows[0].business_id).toBe(r.rows[0].id);

    // `users.id` is this system's OWN identifier and is generated here — it is
    // NOT the auth account id, and after migration 035 the two are different
    // types. Asserted because the previous version conflated them silently.
    expect(u.rows[0].id).not.toBe(uid);
    expect(u.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);

    await admin.query(`DELETE FROM users WHERE auth_uid = $1`, [uid]);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [r.rows[0].id]);
  });

  it("REFUSES a blank or missing auth id", async () => {
    for (const bad of ["", null]) {
      await expect(
        asMigrator.query(`SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`, [
          bad,
          "blank-probe@vetratd.invalid",
          "Blank Clinic",
          "UTC",
        ])
      ).rejects.toThrow(/all arguments are required/);
      await asMigrator.query("ROLLBACK").catch(() => {});
    }
  });

  it("RESTORES the caller's tenant scope, so it cannot silently repoint a transaction", async () => {
    const uid = authUid(8);
    const caller = "44444444-4444-4444-8444-444444444444";
    await admin.query(`DELETE FROM users WHERE auth_uid = $1`, [uid]);

    await asMigrator.query("BEGIN");
    await asMigrator.query(`SELECT set_config('app.business_id', $1, true)`, [caller]);
    const made = await asMigrator.query(
      `SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`,
      [uid, "scope-probe@vetratd.invalid", "Scope Probe Clinic", "UTC"]
    );
    const after = await asMigrator.query(`SELECT current_setting('app.business_id', true) AS scope`);
    await asMigrator.query("COMMIT");

    // Without the restore this would be the NEW business's id, and every
    // subsequent write in the caller's transaction would land on the wrong
    // tenant while looking perfectly ordinary.
    expect(after.rows[0].scope).toBe(caller);

    await admin.query(`DELETE FROM users WHERE auth_uid = $1`, [uid]);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [made.rows[0].id]);
  });

  it("still refuses to give one AUTH ACCOUNT a second business", async () => {
    // The guard moved onto auth_uid at migration 035, and it had to: users.id
    // is generated INSIDE the function now, so a guard keyed on it could never
    // collide — it would have been no guard at all while still looking like one.
    const uid = authUid(7);
    await admin.query(`DELETE FROM users WHERE auth_uid = $1`, [uid]);

    const first = await asMigrator.query(
      `SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`,
      [uid, "twice-probe@vetratd.invalid", "First Clinic", "UTC"]
    );

    await expect(
      asMigrator.query(`SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`, [
        uid,
        "twice-probe-other@vetratd.invalid",
        "Second Clinic",
        "UTC",
      ])
    ).rejects.toThrow(/already belongs to a business/);
    await asMigrator.query("ROLLBACK").catch(() => {});

    // Nothing left behind by the refusal: the business inserted moments before
    // the guard fired must roll back with it.
    const orphans = await admin.query(
      `SELECT count(*)::int AS n FROM businesses WHERE name = 'Second Clinic'`
    );
    expect(orphans.rows[0].n).toBe(0);

    await admin.query(`DELETE FROM users WHERE auth_uid = $1`, [uid]);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [first.rows[0].id]);
  });

  it("refuses a SECOND auth account claiming an email that already has a business", async () => {
    // The other unique index, and it is the one that matters for tenant safety:
    // migration 034 resolves a session's tenant BY EMAIL, so two auth accounts
    // sharing one address would be two people resolving to one clinic.
    const uid = authUid(6);
    const other = authUid(5);
    await admin.query(`DELETE FROM users WHERE auth_uid IN ($1,$2)`, [uid, other]);

    const first = await asMigrator.query(
      `SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`,
      [uid, "shared-address@vetratd.invalid", "Address Clinic", "UTC"]
    );

    await expect(
      asMigrator.query(`SELECT id FROM app_create_business_for_user($1,$2,$3,$4)`, [
        other,
        "shared-address@vetratd.invalid",
        "Impostor Clinic",
        "UTC",
      ])
    ).rejects.toThrow(/already belongs to a business/);
    await asMigrator.query("ROLLBACK").catch(() => {});

    await admin.query(`DELETE FROM users WHERE auth_uid IN ($1,$2)`, [uid, other]);
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
