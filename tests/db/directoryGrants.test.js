import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// ---------------------------------------------------------------------------
// The routing directories must be unreachable by the application role.
//
// business_directory maps a dialled number to a tenant, and user_directory maps
// an email to a user. Both deliberately have NO row-level security — they
// cannot, because a tenant cannot be discovered through a policy that requires
// the tenant. That is only safe while the application role has no rights on
// them and reaches them solely through the SECURITY DEFINER bootstrap
// functions.
//
// IT WAS NOT SAFE. Migration 033 says in its own COMMENT ON TABLE that these
// are "deliberately NOT granted to vetra_app" and backs it with
// `REVOKE ALL ... FROM PUBLIC`. The privilege never came from PUBLIC: migration
// 029 runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT,
// UPDATE, DELETE ON TABLES TO vetra_app`, which applies to every table created
// afterwards — and 033 creates these afterwards. So the application role could
// read the entire tenant routing map, and the revoke aimed at PUBLIC could
// never have stopped it. Migration 039 revokes from the actual grantee.
//
// WHY NOTHING CAUGHT IT: the Cloud SQL RLS run connects as `postgres`, which
// OWNS these tables. An owner's implicit privileges are not grants, so every
// grant assertion was vacuous there — ledger P23. This test asks the question
// as the role that matters, which locally is possible because SET ROLE is.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const DIRECTORIES = ["business_directory", "user_directory"];

let admin;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
});

describeDb("the routing directories are not granted to the application role", () => {
  for (const table of DIRECTORIES) {
    it(`${table}: vetra_app holds no privilege of any kind`, async () => {
      const { rows } = await admin.query(
        `SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'vetra_app' AND table_name = $1`,
        [table]
      );
      expect(rows.map((r) => r.privilege_type).sort()).toEqual([]);
    });

    it(`${table}: a SELECT as vetra_app is refused`, async () => {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE vetra_app");
        await expect(admin.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/i);
      } finally {
        await admin.query("ROLLBACK");
      }
    });
  }

  // Without this, the two assertions above would still pass if the tables
  // vanished, or if the role stopped existing — a green test proving nothing.
  it("the premise holds: the tables and the role both exist", async () => {
    const { rows: roles } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'vetra_app'");
    expect(roles).toHaveLength(1);
    for (const table of DIRECTORIES) {
      const { rows } = await admin.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`]);
      expect(rows[0].present).toBe(true);
    }
  });

  // The access the application actually needs must still work, or the revoke
  // above has broken call routing rather than secured it.
  it("the SECURITY DEFINER lookup still works for vetra_app", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE vetra_app");
      // Executes as the function owner, not the caller — which is the whole
      // reason these functions exist. No row is expected; not throwing is
      // the assertion.
      const { rows } = await admin.query("SELECT * FROM app_lookup_business_by_phone($1)", ["+15550000000"]);
      expect(Array.isArray(rows)).toBe(true);
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});
