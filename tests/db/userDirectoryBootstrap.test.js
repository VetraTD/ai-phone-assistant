import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";

// ---------------------------------------------------------------------------
// Authenticated identity -> tenant, under the row-level security that actually
// applies.
//
// The third instance of one defect. Migration 029 wrote three bootstrap paths
// on the assumption that SECURITY DEFINER escapes row security. It does not,
// because 029 also uses FORCE ROW LEVEL SECURITY, which applies to the table
// owner too, and only BYPASSRLS escapes — which Cloud SQL's `postgres` does not
// hold. Migration 032 fixed the write path, 033 fixed the dialled-number path,
// and this one was still live: `app_lookup_user_by_email` is how BOTH servers
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
const FNS = ["app_lookup_user_by_email(text)", "app_sync_user_directory()"];

const BIZ_A = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa";
const BIZ_B = "bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb";
const USER_A = "a1a1a1a1-4444-4444-8444-a1a1a1a1a1a1";
const USER_B = "b1b1b1b1-4444-4444-8444-b1b1b1b1b1b1";
const EMAIL_A = "userdir-a@example.test";
const EMAIL_B = "userdir-b@example.test";

let admin;
let probe;

/** Fixture setup as the superuser, which bypasses RLS. Not the behaviour under test. */
async function seedTenant(businessId, userId, email, role = "staff") {
  await admin.query(
    `INSERT INTO businesses (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [businessId, `User Directory Probe ${businessId.slice(0, 4)}`]
  );
  await admin.query(
    `INSERT INTO users (id, business_id, email, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET business_id = EXCLUDED.business_id,
                                    email = EXCLUDED.email,
                                    role = EXCLUDED.role`,
    [userId, businessId, email, role]
  );
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

  await seedTenant(BIZ_A, USER_A, EMAIL_A, "owner");
  await seedTenant(BIZ_B, USER_B, EMAIL_B, "staff");
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

describeDb("app_lookup_user_by_email under FORCE row-level security", () => {
  it("the function owner does NOT bypass RLS — otherwise nothing here proves anything", async () => {
    const r = await admin.query(
      `SELECT r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'app_lookup_user_by_email'`
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("RESOLVES an email with no tenant scope set — the whole bug", async () => {
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [EMAIL_A]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].business_id).toBe(BIZ_A);
  });

  it("returns the shape both servers read: id, business_id, email, role", async () => {
    // requireBusinessAccess writes `id` into the PHI audit trail and compares
    // `business_id` against the path. A lookup that resolved the tenant and
    // dropped the user id would pass the test above and break the audit record.
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [EMAIL_A]);
    expect(r.rows[0]).toEqual({
      id: USER_A,
      business_id: BIZ_A,
      email: EMAIL_A,
      role: "owner",
    });
  });

  it("returns nothing for an email nobody holds", async () => {
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, ["nobody@example.test"]);
    expect(r.rows).toHaveLength(0);
  });

  it("returns nothing for null or blank input rather than erroring", async () => {
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email(NULL)`)).rows).toHaveLength(0);
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email('   ')`)).rows).toHaveLength(0);
  });

  it("matches the address EXACTLY, as it always has", async () => {
    // 029 compared with `=`. Quietly folding case or trimming here would change
    // who resolves to which tenant, and would do it invisibly.
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [EMAIL_A.toUpperCase()])).rows)
      .toHaveLength(0);
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [` ${EMAIL_A} `])).rows)
      .toHaveLength(0);
  });

  it("does NOT repoint a caller that already declared a tenant", async () => {
    await probe.query("BEGIN");
    await probe.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_B]);
    // Asking for A's user while scoped to B must not hand over A's row, and must
    // not silently move the transaction onto A.
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [EMAIL_A]);
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
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [EMAIL_A]);
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
    await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [EMAIL_A]);
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
  it("a new user resolves immediately", async () => {
    const biz = "cccccccc-4444-4444-8444-cccccccccccc";
    const user = "c1c1c1c1-4444-4444-8444-c1c1c1c1c1c1";
    const email = "userdir-c@example.test";
    await seedTenant(biz, user, email);

    const r = await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [email]);
    expect(r.rows[0]?.business_id).toBe(biz);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("changing an address stops the OLD one resolving and starts the new one", async () => {
    const biz = "dddddddd-4444-4444-8444-dddddddddddd";
    const user = "d1d1d1d1-4444-4444-8444-d1d1d1d1d1d1";
    const oldEmail = "userdir-d-old@example.test";
    const newEmail = "userdir-d-new@example.test";
    await seedTenant(biz, user, oldEmail);
    await admin.query(`UPDATE users SET email = $2 WHERE id = $1`, [user, newEmail]);

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [oldEmail])).rows).toHaveLength(0);
    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [newEmail])).rows[0]?.id).toBe(user);

    // AND the mapping is actually gone, asserted on the table.
    //
    // The two lines above are NOT enough, and finding that out is why this one
    // exists: a trigger that leaves the old row behind passes them both,
    // because the function's second read still finds no `users` row for the
    // retired address and returns nothing either way. Sabotaging the trigger
    // left all nineteen tests green until this assertion was added — the test
    // was describing an outcome that two different mechanisms produce.
    const stale = await admin.query(`SELECT count(*)::int AS n FROM user_directory WHERE email = $1`, [oldEmail]);
    expect(stale.rows[0].n).toBe(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("a directory row alone cannot resolve anybody — the second read is a backstop", async () => {
    // Defence in depth, and the property the test above leans on. If a row ever
    // does go stale — a trigger regression, a hand edit, a restore that half
    // ran — it must not by itself hand a session a tenant. The function reads
    // the directory to LEARN a scope and then still has to find the person.
    const biz = "8a8a8a8a-4444-4444-8444-8a8a8a8a8a8a";
    const orphan = "userdir-orphan@example.test";
    await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'User Directory Probe Orphan')
                       ON CONFLICT (id) DO NOTHING`, [biz]);
    await admin.query(`INSERT INTO user_directory (email, business_id) VALUES ($1, $2)
                       ON CONFLICT (email) DO UPDATE SET business_id = EXCLUDED.business_id`, [orphan, biz]);

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [orphan])).rows).toHaveLength(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("moving a user to another business moves where they resolve", async () => {
    const bizOne = "eeeeeeee-4444-4444-8444-eeeeeeeeeeee";
    const bizTwo = "ffffffff-4444-4444-8444-ffffffffffff";
    const user = "e1e1e1e1-4444-4444-8444-e1e1e1e1e1e1";
    const email = "userdir-e@example.test";
    await seedTenant(bizOne, user, email);
    await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'User Directory Probe F')
                       ON CONFLICT (id) DO NOTHING`, [bizTwo]);
    await admin.query(`UPDATE users SET business_id = $2 WHERE id = $1`, [user, bizTwo]);

    // A stale mapping here is a cross-tenant read: the person would authenticate
    // and be handed their PREVIOUS employer's records.
    const r = await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [email]);
    expect(r.rows[0]?.business_id).toBe(bizTwo);

    await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [bizOne, bizTwo]);
  });

  it("deleting a user stops their address resolving", async () => {
    const biz = "9a9a9a9a-4444-4444-8444-9a9a9a9a9a9a";
    const user = "9b9b9b9b-4444-4444-8444-9b9b9b9b9b9b";
    const email = "userdir-g@example.test";
    await seedTenant(biz, user, email);
    await admin.query(`DELETE FROM users WHERE id = $1`, [user]);

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [email])).rows).toHaveLength(0);
    // On the table too, for the same reason as the rename case: the function's
    // second read would produce this outcome whether or not the row went.
    const stale = await admin.query(`SELECT count(*)::int AS n FROM user_directory WHERE email = $1`, [email]);
    expect(stale.rows[0].n).toBe(0);

    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);
  });

  it("deleting a business stops its staff resolving", async () => {
    const biz = "9c9c9c9c-4444-4444-8444-9c9c9c9c9c9c";
    const user = "9d9d9d9d-4444-4444-8444-9d9d9d9d9d9d";
    const email = "userdir-h@example.test";
    await seedTenant(biz, user, email);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [biz]);

    expect((await probe.query(`SELECT * FROM app_lookup_user_by_email($1)`, [email])).rows).toHaveLength(0);
    // And nothing orphaned behind it.
    const left = await admin.query(`SELECT count(*)::int AS n FROM user_directory WHERE email = $1`, [email]);
    expect(left.rows[0].n).toBe(0);
  });

  it("the backfill reads NOTHING unless FORCE is stood down — the migration's own trap", async () => {
    // What the migration does, reproduced as its own experiment.
    //
    // The residue this leaves — "every users row has a directory row" — CANNOT
    // be tested here, and trying was a mistake worth recording: this file's
    // fixtures insert users, which fires the trigger, which recreates every
    // directory row. Emptying user_directory entirely and re-running left all
    // twenty tests green. The assertion was true and proved nothing about the
    // backfill, because the backfill was not what made it true.
    //
    // So test the mechanism instead. Everything below happens inside one
    // transaction that is rolled back, including the ownership change, so a
    // failure anywhere cannot leave `users` owned by a probe role or FORCE
    // switched off.
    await admin.query("BEGIN");
    try {
      // Model Cloud SQL: the migration role OWNS the table and does not bypass
      // RLS. `vetra` alone cannot show this — a superuser bypasses regardless
      // of who owns what, which is the whole reason this defect reached
      // production three times.
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
    // Worth asserting because the trigger is what keeps it true from here on,
    // and a trigger that stops firing shows up here first. It is NOT evidence
    // about the migration: see the test above for why.
    const r = await admin.query(
      `SELECT count(*)::int AS missing
         FROM users u
    LEFT JOIN user_directory d ON d.email = u.email
        WHERE d.email IS NULL AND btrim(u.email) <> ''`
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
    // It is protected by having no grants, not by a policy — a policy on a table
    // whose whole job is to be readable before a tenant is known would recreate
    // the deadlock this migration exists to break.
    const r = await admin.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'user_directory'`
    );
    expect(r.rows[0].relrowsecurity).toBe(false);
  });

  it("holds nothing beyond an address and a tenant", async () => {
    // The one guard against it growing into a second, unprotected copy of the
    // staff table.
    const r = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_directory' ORDER BY column_name`
    );
    expect(r.rows.map((x) => x.column_name)).toEqual(["business_id", "email"]);
  });
});
