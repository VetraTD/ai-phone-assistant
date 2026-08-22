import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { backfillAuthUids } from "../../scripts/import-users.js";

// ---------------------------------------------------------------------------
// Writing account ids onto staff rows, under the row-level security that
// actually applies.
//
// This is the FOURTH appearance of one trap. `users` is FORCE ROW LEVEL
// SECURITY on `business_id = app_current_business_id()`, and a backfill is by
// definition cross-tenant and unscoped — so the UPDATE matches NOTHING and
// reports success. Migrations 032, 033 and 034 each hit the same wall from a
// different direction.
//
// It is the worst possible failure here, because it is silent AND it looks like
// somebody else's fault: migration 036 would then refuse to apply, correctly,
// and the refusal would read as "the import failed" when the import worked and
// the backfill quietly did nothing.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const OWNER_ROLE = "backfill_owner";
const OWNER_URL = "postgres://backfill_owner:probe_only@localhost:55432/vetra";
const BIZ = "7a7a7a7a-5555-4555-8555-7a7a7a7a7a7a";
const USER_A = "7b7b7b7b-5555-4555-8555-7b7b7b7b7b7b";
const USER_B = "7c7c7c7c-5555-4555-8555-7c7c7c7c7c7c";

let admin;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD 'probe_only' NOSUPERUSER NOBYPASSRLS`);
  // Without USAGE the table is not even VISIBLE to the role, and the failure is
  // `relation "users" does not exist` — which reads as a missing migration
  // rather than a missing grant.
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER_ROLE}`);

  await admin.query(
    `INSERT INTO businesses (id, name) VALUES ($1, 'Backfill Probe')
     ON CONFLICT (id) DO NOTHING`,
    [BIZ]
  );
});

afterEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [USER_A, USER_B]).catch(() => {});
});

afterAll(async () => {
  if (!url) return;
  // Ownership back, unconditionally, before the role can be dropped. A crashed
  // run must not leave `users` owned by a role that is about to disappear.
  await admin?.query(`ALTER TABLE users OWNER TO vetra`).catch(() => {});
  await admin?.query(`ALTER TABLE users FORCE ROW LEVEL SECURITY`).catch(() => {});
  await admin?.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin?.query(`DROP OWNED BY ${OWNER_ROLE}`).catch(() => {});
  await admin?.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`).catch(() => {});
  await admin?.end().catch(() => {});
});

async function seedTwoStaff() {
  await admin.query(
    // Seeded WITH an auth_uid because 036 made it NOT NULL, then overwritten by
    // the backfill under test — which is what the real import does to rows that
    // 036 filled in from users.id.
    //
    // Separate parameters rather than `$1::text`: reusing one placeholder as
    // both uuid and text makes Postgres refuse with "inconsistent types deduced
    // for parameter $1".
    `INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1,$2,$3,$4), ($5,$2,$6,$7)`,
    [
      USER_A, BIZ, "backfill-a@example.test", USER_A,
      USER_B, "backfill-b@example.test", USER_B,
    ]
  );
}

describeDb("backfillAuthUids", () => {
  it("SETS auth_uid on the right rows", async () => {
    // The acceptance case, and the one that makes the refusals below mean
    // something.
    await seedTwoStaff();

    const updated = await backfillAuthUids(admin, [
      { dbUserId: USER_A, localId: "supa-uid-aaaa" },
      { dbUserId: USER_B, localId: "supa-uid-bbbb" },
    ]);

    expect(updated).toBe(2);
    const r = await admin.query(`SELECT id, auth_uid FROM users WHERE id IN ($1,$2) ORDER BY email`, [
      USER_A,
      USER_B,
    ]);
    expect(r.rows).toEqual([
      { id: USER_A, auth_uid: "supa-uid-aaaa" },
      { id: USER_B, auth_uid: "supa-uid-bbbb" },
    ]);
  });

  it("pairs each id with ITS OWN account, not with the wrong one", async () => {
    // An off-by-one in the unnest() would silently give every member of staff
    // somebody else's account, and each row would still be non-null — so a
    // count check alone cannot see it.
    await seedTwoStaff();
    await backfillAuthUids(admin, [
      { dbUserId: USER_B, localId: "supa-uid-for-b" },
      { dbUserId: USER_A, localId: "supa-uid-for-a" },
    ]);
    const r = await admin.query(`SELECT auth_uid FROM users WHERE id = $1`, [USER_A]);
    expect(r.rows[0].auth_uid).toBe("supa-uid-for-a");
  });

  it("leaves FORCE row level security ON afterwards", async () => {
    await seedTwoStaff();
    await backfillAuthUids(admin, [{ dbUserId: USER_A, localId: "supa-uid-aaaa" }]);
    const r = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'users'`
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("rolls back on failure WITHOUT leaving FORCE switched off", async () => {
    // The reason it is one transaction. A backfill that dies half way and
    // leaves row security relaxed would disable every tenant policy for the
    // table owner, permanently and silently.
    await seedTwoStaff();
    await expect(
      backfillAuthUids(admin, [{ dbUserId: "not-a-uuid", localId: "x" }])
    ).rejects.toThrow();

    const r = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'users'`
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("does nothing, and touches no transaction, for an empty list", async () => {
    expect(await backfillAuthUids(admin, [])).toBe(0);
  });

  it("WORKS AS A NON-BYPASSING OWNER — which is the only run that proves anything", async () => {
    // Every test above runs as `vetra`, a superuser with rolbypassrls, so they
    // pass whether or not the function stands FORCE down. Deleting the
    // stand-down leaves all of them green. This one does not: it runs the real
    // function on a connection shaped like Cloud SQL's `postgres` — owns the
    // table, bypasses nothing — and without the stand-down it updates zero rows.
    await seedTwoStaff();
    const probe = new pg.Client({ connectionString: OWNER_URL });

    try {
      await admin.query(`ALTER TABLE users OWNER TO ${OWNER_ROLE}`);
      await probe.connect();

      const attrs = await admin.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
        [OWNER_ROLE]
      );
      expect(attrs.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      expect(
        await backfillAuthUids(probe, [
          { dbUserId: USER_A, localId: "owner-run-aaaa" },
          { dbUserId: USER_B, localId: "owner-run-bbbb" },
        ])
      ).toBe(2);
    } finally {
      await probe.end().catch(() => {});
      await admin.query(`ALTER TABLE users OWNER TO vetra`).catch(() => {});
    }

    const r = await admin.query(`SELECT auth_uid FROM users WHERE id = $1`, [USER_A]);
    expect(r.rows[0].auth_uid).toBe("owner-run-aaaa");

    const flags = await admin.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'users'`
    );
    expect(flags.rows[0].relforcerowsecurity).toBe(true);
  });
});

describeDb("why the FORCE stand-down is there at all", () => {
  it("an unscoped UPDATE matches ZERO rows with FORCE on, and all of them with it off", async () => {
    // The mechanism, reproduced as its own experiment rather than asserted in a
    // comment. `vetra` alone cannot show this: a superuser bypasses row security
    // regardless of who owns what, which is precisely why this defect reached
    // production three times before anybody saw it.
    //
    // Everything happens inside one transaction that is rolled back — including
    // the ownership change — so a failure cannot leave `users` owned by a probe
    // role or FORCE switched off.
    await seedTwoStaff();

    await admin.query("BEGIN");
    try {
      await admin.query(`ALTER TABLE users OWNER TO ${OWNER_ROLE}`);
      await admin.query(`SET LOCAL ROLE ${OWNER_ROLE}`);

      // Distinct values per row: `auth_uid` is UNIQUE, and setting both to the
      // same string fails on the index before row security is ever consulted —
      // which would have made this test pass for the wrong reason had the
      // ordering been the other way round.
      const update = `UPDATE users SET auth_uid = 'probe-' || left(id::text, 8) WHERE id IN ($1,$2)`;

      const forced = await admin.query(update, [USER_A, USER_B]);
      expect(forced.rowCount).toBe(0); // <- the silent backfill of nothing

      await admin.query(`ALTER TABLE users NO FORCE ROW LEVEL SECURITY`);
      const unforced = await admin.query(update, [USER_A, USER_B]);
      expect(unforced.rowCount).toBe(2);
    } finally {
      await admin.query("ROLLBACK");
    }

    // And nothing leaked out of the rolled-back transaction.
    const owner = await admin.query(
      `SELECT pg_get_userbyid(relowner) AS owner, relforcerowsecurity
         FROM pg_class WHERE relname = 'users'`
    );
    expect(owner.rows[0].owner).toBe("vetra");
    expect(owner.rows[0].relforcerowsecurity).toBe(true);
  });
});
