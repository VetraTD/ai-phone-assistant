import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";

// ---------------------------------------------------------------------------
// Authenticated identity -> tenant, under the row-level security that actually
// applies.
//
// KEYED ON THE ACCOUNT ID SINCE MIGRATION 036, not the email address. Between
// 034 and 036 this resolved a tenant from the token's `email` claim, and that
// was a hole: signup is OPEN, so an address is something a stranger can CHOOSE.
// An address with a `users` row and no identity-provider account could be
// claimed by anyone signing up with it, who would then inherit that clinic's
// tenant carrying a perfectly valid token. An account id cannot be chosen.
//
// The third instance of one defect. Migration 029 wrote three bootstrap paths
// on the assumption that SECURITY DEFINER escapes row security. It does not,
// because 029 also uses FORCE ROW LEVEL SECURITY, which applies to the table
// owner too, and only BYPASSRLS escapes — which Cloud SQL's `postgres` does not
// hold. Migration 032 fixed the write path, 033 fixed the dialled-number path,
// and this one was still live: `app_lookup_user_by_auth_uid` is how BOTH servers
// turn a verified login into the tenant it may act on, so under Cloud SQL every
// authenticated request answered "no business linked to this user" — a 403 that
// reads as an authorisation bug and is a scoping one.
//
// EVERY TEST HERE RUNS WITH THE FUNCTIONS OWNED BY A ROLE THAT DOES NOT BYPASS
// RLS, and the first test asserts that ownership. Without it the local
// superuser owns them, SECURITY DEFINER clears every policy, and these pass
// against broken code — which is exactly what happened to the write bootstrap
// before its ownership was reassigned.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// Two roles, because production has two. On Cloud SQL `postgres` OWNS the tables
// and functions and does not bypass RLS; `vetra_app` is the application and has
// no rights on the directory at all. One role cannot model both.
const OWNER_ROLE = "userdir_owner";
const APP_ROLE = "userdir_app";
const APP_URL = `postgres://${APP_ROLE}:probe_only@localhost:55432/vetra`;
const FNS = ["app_lookup_user_by_auth_uid(text)", "app_sync_user_directory()"];

const BIZ_A = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa";
const BIZ_B = "bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb";
const USER_A = "a1a1a1a1-4444-4444-8444-a1a1a1a1a1a1";
const USER_B = "b1b1b1b1-4444-4444-8444-b1b1b1b1b1b1";
const EMAIL_A = "userdir-a@example.test";
const EMAIL_B = "userdir-b@example.test";
const AUTH_A = "authuid-userdir-a-0001";
const AUTH_B = "authuid-userdir-b-0001";

let admin;
let probe;

/** Fixture setup as the superuser, which bypasses RLS. Not the behaviour under test. */
async function seedTenant(businessId, userId, email, role = "staff", authUid = null) {
  const uid = authUid || `authuid-${userId.slice(0, 8)}`;
  await admin.query(
    `INSERT INTO businesses (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [businessId, `User Directory Probe ${businessId.slice(0, 4)}`]
  );
  await admin.query(
    `INSERT INTO users (id, business_id, email, role, auth_uid) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET business_id = EXCLUDED.business_id,
                                    email = EXCLUDED.email,
                                    role = EXCLUDED.role,
                                    auth_uid = EXCLUDED.auth_uid`,
    [userId, businessId, email, role, uid]
  );
  return uid;
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  for (const role of [OWNER_ROLE, APP_ROLE]) {
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe_only'`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  }
  // The application must not reach the directory. The blanket grant above would
  // undo that, so take it straight back — from the app only. The owner keeps it,
  // exactly as Cloud SQL's postgres does.
  await admin.query(`REVOKE ALL ON user_directory FROM ${APP_ROLE}`).catch(() => {});

  // Cloud SQL's postgres owns these and does NOT bypass RLS. Match it.
  for (const fn of FNS) {
    await admin.query(`ALTER FUNCTION ${fn} OWNER TO ${OWNER_ROLE}`);
  }

  probe = new pg.Client({ connectionString: APP_URL });
  await probe.connect();

  await seedTenant(BIZ_A, USER_A, EMAIL_A, "owner", AUTH_A);
  await seedTenant(BIZ_B, USER_B, EMAIL_B, "staff", AUTH_B);
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
  for (const role of [OWNER_ROLE, APP_ROLE]) {
    await admin?.query(`REVOKE ALL ON SCHEMA public FROM ${role}`).catch(() => {});
    await admin?.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => {});
    await admin?.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`).catch(() => {});
    await admin?.query(`DROP OWNED BY ${role}`).catch(() => {});
    await admin?.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  await admin?.end().catch(() => {});
});

describeDb("app_lookup_user_by_auth_uid under FORCE row-level security", () => {
  it("the function owner does NOT bypass RLS — otherwise nothing here proves anything", async () => {
    const r = await admin.query(
      `SELECT r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'app_lookup_user_by_auth_uid'`
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("RESOLVES an account id with no tenant scope set — the whole bug", async () => {
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [AUTH_A]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].business_id).toBe(BIZ_A);
  });

  it("returns the shape both servers read: id, business_id, email, role", async () => {
    // requireBusinessAccess writes `id` into the PHI audit trail and compares
    // `business_id` against the path. A lookup that resolved the tenant and
    // dropped the user id would pass the test above and break the audit record.
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [AUTH_A]);
    expect(r.rows[0]).toEqual({
      id: USER_A,
      business_id: BIZ_A,
      email: EMAIL_A,
      role: "owner",
    });
  });

  it("returns nothing for an account id nobody holds", async () => {
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, ["authuid-nobody"]);
    expect(r.rows).toHaveLength(0);
  });

  it("returns nothing for null or blank input rather than erroring", async () => {
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid(NULL)`)).rows).toHaveLength(0);
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid('   ')`)).rows).toHaveLength(0);
  });

  it("matches the account id EXACTLY", async () => {
    // Compared with `=`, as every version of this lookup has been. Quietly
    // folding case or trimming would change who resolves to which tenant, and
    // would do it invisibly.
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [AUTH_A.toUpperCase()])).rows)
      .toHaveLength(0);
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [` ${AUTH_A} `])).rows)
      .toHaveLength(0);
  });

  it("does NOT repoint a caller that already declared a tenant", async () => {
    await probe.query("BEGIN");
    await probe.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_B]);
    // Asking for A's user while scoped to B must not hand over A's row, and must
    // not silently move the transaction onto A.
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [AUTH_A]);
    const scope = await probe.query(`SELECT current_setting('app.business_id', true) AS s`);
    await probe.query("COMMIT");

    expect(r.rows).toHaveLength(0);
    expect(scope.rows[0].s).toBe(BIZ_B);
  });

  it("still resolves a user inside their OWN tenant's scope", async () => {
    // The acceptance half of the test above. Without it, "returns nothing while
    // scoped elsewhere" is equally consistent with a function that returns
    // nothing whenever any scope is set.
    await probe.query("BEGIN");
    await probe.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_A]);
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [AUTH_A]);
    await probe.query("COMMIT");

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(USER_A);
  });

  it("leaves an unscoped caller scoped to the tenant it discovered", async () => {
    // The dashboard reads this on a pooled connection outside a transaction, so
    // the adopted scope evaporates with the statement — but inside one, the
    // caller may go on to read that tenant's rows, and 033 behaves this way for
    // the dialled-number path. Asserted so the two cannot drift.
    await probe.query("BEGIN");
    await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [AUTH_A]);
    const scope = await probe.query(`SELECT current_setting('app.business_id', true) AS s`);
    await probe.query("COMMIT");
    expect(scope.rows[0].s).toBe(BIZ_A);
  });

  it("the application role CANNOT read the directory directly", async () => {
    // A table without row-level security is only safe while nothing but the
    // bootstrap function can read it. If this ever succeeds, the directory has
    // become a window onto every other tenant's staff.
    await expect(probe.query(`SELECT * FROM user_directory`)).rejects.toThrow(/permission denied/i);
  });
});


describeDb("user_directory stays true to users", () => {
  it("a new account resolves immediately", async () => {
    const biz = "cccccccc-4444-4444-8444-cccccccccccc";
    const user = "c1c1c1c1-4444-4444-8444-c1c1c1c1c1c1";
    const uid = await seedTenant(biz, user, "userdir-c@example.test");

    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [uid]);
    expect(r.rows[0]?.business_id).toBe(biz);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("changing the ACCOUNT stops the old id resolving and starts the new one", async () => {
    const biz = "dddddddd-4444-4444-8444-dddddddddddd";
    const user = "d1d1d1d1-4444-4444-8444-d1d1d1d1d1d1";
    const oldUid = await seedTenant(biz, user, "userdir-d@example.test", "staff", "authuid-d-old");
    await admin.query(`UPDATE users SET auth_uid = $2 WHERE id = $1`, [user, "authuid-d-new"]);

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [oldUid])).rows).toHaveLength(0);
    expect(
      (await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, ["authuid-d-new"])).rows[0]?.id
    ).toBe(user);

    // AND the mapping is actually gone, asserted on the table.
    //
    // The two lines above are NOT enough, and finding that out is why this one
    // exists: a trigger that leaves the old row behind passes them both, because
    // the function's second read still finds no `users` row for the retired id
    // and returns nothing either way.
    const stale = await admin.query(
      `SELECT count(*)::int AS n FROM user_directory WHERE auth_uid = $1`,
      [oldUid]
    );
    expect(stale.rows[0].n).toBe(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("a directory row alone cannot resolve anybody — the second read is a backstop", async () => {
    // Defence in depth, and the property the test above leans on. If a row ever
    // does go stale — a trigger regression, a hand edit, a restore that half ran
    // — it must not by itself hand a session a tenant.
    const biz = "8a8a8a8a-4444-4444-8444-8a8a8a8a8a8a";
    const orphan = "authuid-orphan-0001";
    await admin.query(
      `INSERT INTO businesses (id, name) VALUES ($1, 'User Directory Probe Orphan')
       ON CONFLICT (id) DO NOTHING`,
      [biz]
    );
    await admin.query(
      `INSERT INTO user_directory (auth_uid, business_id) VALUES ($1, $2)
       ON CONFLICT (auth_uid) DO UPDATE SET business_id = EXCLUDED.business_id`,
      [orphan, biz]
    );

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [orphan])).rows).toHaveLength(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("CHANGING AN EMAIL MOVES NOBODY — which is the whole point of 036", async () => {
    // The property the migration exists for, asserted directly. Before 036 the
    // directory was keyed on the address, so the address was load-bearing and a
    // stranger who could claim one could claim the tenant. Now it is ordinary
    // data: the same person keeps resolving through the same account id.
    const biz = "9e9e9e9e-4444-4444-8444-9e9e9e9e9e9e";
    const user = "9f9f9f9f-4444-4444-8444-9f9f9f9f9f9f";
    const uid = await seedTenant(biz, user, "userdir-rename@example.test");

    await admin.query(`UPDATE users SET email = 'userdir-renamed@example.test' WHERE id = $1`, [user]);

    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [uid]);
    expect(r.rows[0]?.id).toBe(user);
    expect(r.rows[0]?.email).toBe("userdir-renamed@example.test");

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("moving a user to another business moves where they resolve", async () => {
    const bizOne = "eeeeeeee-4444-4444-8444-eeeeeeeeeeee";
    const bizTwo = "ffffffff-4444-4444-8444-ffffffffffff";
    const user = "e1e1e1e1-4444-4444-8444-e1e1e1e1e1e1";
    const uid = await seedTenant(bizOne, user, "userdir-e@example.test");
    await admin.query(
      `INSERT INTO businesses (id, name) VALUES ($1, 'User Directory Probe F')
       ON CONFLICT (id) DO NOTHING`,
      [bizTwo]
    );
    await admin.query(`UPDATE users SET business_id = $2 WHERE id = $1`, [user, bizTwo]);

    // A stale mapping here is a cross-tenant read: the person would authenticate
    // and be handed their PREVIOUS employer's records.
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [uid]);
    expect(r.rows[0]?.business_id).toBe(bizTwo);

    await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [bizOne, bizTwo]);
  });

  it("deleting a user stops their account resolving", async () => {
    const biz = "9a9a9a9a-4444-4444-8444-9a9a9a9a9a9a";
    const user = "9b9b9b9b-4444-4444-8444-9b9b9b9b9b9b";
    const uid = await seedTenant(biz, user, "userdir-g@example.test");
    await admin.query(`DELETE FROM users WHERE id = $1`, [user]);

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [uid])).rows).toHaveLength(0);
    const stale = await admin.query(
      `SELECT count(*)::int AS n FROM user_directory WHERE auth_uid = $1`,
      [uid]
    );
    expect(stale.rows[0].n).toBe(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("deleting a business stops its staff resolving", async () => {
    const biz = "9c9c9c9c-4444-4444-8444-9c9c9c9c9c9c";
    const user = "9d9d9d9d-4444-4444-8444-9d9d9d9d9d9d";
    const uid = await seedTenant(biz, user, "userdir-h@example.test");
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [uid])).rows).toHaveLength(0);
    const left = await admin.query(
      `SELECT count(*)::int AS n FROM user_directory WHERE auth_uid = $1`,
      [uid]
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("the backfill reads NOTHING unless FORCE is stood down — the migration's own trap", async () => {
    // What migrations 034 and 036 both do, reproduced as their own experiment.
    //
    // The residue this leaves — "every users row has a directory row" — CANNOT
    // be tested here, and trying was a mistake worth recording: this file's own
    // fixtures insert users, which fires the trigger, which recreates every
    // directory row. Emptying user_directory entirely left every test green.
    //
    // So test the mechanism instead. Everything below happens inside one
    // transaction that is rolled back, including the ownership change, so a
    // failure cannot leave `users` owned by a probe role or FORCE switched off.
    await admin.query("BEGIN");
    try {
      // Model Cloud SQL: the migration role OWNS the table and does not bypass
      // RLS. `vetra` alone cannot show this — a superuser bypasses regardless of
      // who owns what, which is why this defect reached production three times.
      await admin.query(`ALTER TABLE users OWNER TO ${OWNER_ROLE}`);
      await admin.query(`SET LOCAL ROLE ${OWNER_ROLE}`);

      const forced = await admin.query(`SELECT count(*)::int AS n FROM users`);
      expect(forced.rows[0].n).toBe(0); // <- the silent backfill of nothing

      await admin.query(`ALTER TABLE users NO FORCE ROW LEVEL SECURITY`);
      const unforced = await admin.query(`SELECT count(*)::int AS n FROM users`);
      expect(unforced.rows[0].n).toBeGreaterThan(0);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("every users row has a directory row — an invariant, not proof of the backfill", async () => {
    const r = await admin.query(
      `SELECT count(*)::int AS missing
         FROM users u
    LEFT JOIN user_directory d ON d.auth_uid = u.auth_uid
        WHERE d.auth_uid IS NULL AND btrim(u.auth_uid) <> ''`
    );
    expect(r.rows[0].missing).toBe(0);
  });

  it("FORCE row level security is still on users after the migration's backfill", async () => {
    const r = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'users'`
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("user_directory itself carries no row-level security, deliberately", async () => {
    // Protected by having no grants, not by a policy — a policy on a table whose
    // whole job is to be readable before a tenant is known would recreate the
    // deadlock it exists to break.
    const r = await admin.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'user_directory'`);
    expect(r.rows[0].relrowsecurity).toBe(false);
  });

  it("holds NO PERSONAL DATA — an account id and a tenant, nothing else", async () => {
    // Migration 036 took the email address out. Worth pinning: a table with no
    // row-level security should not accumulate anything worth reading.
    const r = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_directory' ORDER BY column_name`
    );
    expect(r.rows.map((x) => x.column_name)).toEqual(["auth_uid", "business_id"]);
  });
});

describeDb("the escalation migration 036 exists to close", () => {
  it("A STRANGER WHO CLAIMS A STAFF EMAIL RESOLVES TO NOTHING", async () => {
    // The attack, at the layer that decides it.
    //
    // Signup is open. Before 036 the tenant came from the token's `email`
    // claim, so an address with a `users` row and NO identity-provider account
    // could be claimed by anyone: they signed up with it, got a genuinely valid
    // token, and the lookup handed them that clinic. Every layer behaved
    // correctly and the tenant was still wrong.
    //
    // Demonstrated end to end against the live service on 2026-08-22 — a real
    // signup with a seeded victim's address came back `needsOnboarding: true`
    // rather than the clinic. This is that same property, pinned where it can
    // fail a test run.
    const biz = "11112222-6666-4666-8666-111122223333";
    const user = "44445555-6666-4666-8666-444455556666";
    const victimEmail = "victim@example.test";
    await seedTenant(biz, user, victimEmail, "staff", "the-real-victims-account");

    // The victim themselves still resolves.
    const real = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [
      "the-real-victims-account",
    ]);
    expect(real.rows[0]?.business_id).toBe(biz);

    // A stranger's brand-new account carries a DIFFERENT id, and the address
    // buys them nothing.
    const attacker = await probe.query(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [
      "a-freshly-created-account",
    ]);
    expect(attacker.rows).toHaveLength(0);

    // And the address is not a key at all any more — no lookup takes one.
    const byEmail = await admin.query(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'app_lookup_user_by_email'`
    );
    expect(byEmail.rows[0].n).toBe(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });
});
