import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// ---------------------------------------------------------------------------
// app_attach_user_to_business — the flow ledger P25 says does not exist.
//
// scripts/import-tenant.js creates a business and deliberately no dashboard
// user. Both DSR routes sit behind requireBusinessAccess, which needs an
// Identity Platform session, and migration 036 keys the tenant lookup on
// auth_uid. No user -> no session -> a migrated clinic cannot serve an Art. 15
// or Art. 17 request at all, which is why Phase 5's DSR gate could not run.
//
// The assertion that matters most here is the NEGATIVE one: this function is
// granted to nobody. It takes a business id as an argument, so if vetra_app
// could execute it, any signed-up account could attach itself to any clinic.
// app_create_business_for_user is safe to expose precisely because the tenant
// it attaches you to is one it just generated; this one is not.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let admin;

const uniq = (p) => `${p}-${Math.floor(Math.random() * 1e9)}`;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
});

beforeEach(async () => {
  await admin.query("BEGIN");
});

// Every case rolls back, so the suite leaves no tenants behind.
async function rollback() {
  await admin.query("ROLLBACK");
}

async function makeBusiness() {
  const id = (await admin.query("SELECT gen_random_uuid() AS id")).rows[0].id;
  await admin.query("SELECT set_config('app.business_id', $1, true)", [id]);
  await admin.query("INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)", [
    id,
    "Imported Clinic",
    "Europe/London",
  ]);
  await admin.query("SELECT set_config('app.business_id', '', true)");
  return id;
}

describeDb("app_attach_user_to_business", () => {
  it("attaches an account to an existing imported tenant", async () => {
    try {
      const businessId = await makeBusiness();
      const uid = uniq("uid");
      const email = `${uniq("owner")}@example.com`;

      const { rows } = await admin.query("SELECT * FROM app_attach_user_to_business($1, $2, $3)", [
        uid,
        email,
        businessId,
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0].business_id).toBe(businessId);
      expect(rows[0].auth_uid).toBe(uid);
      expect(rows[0].email).toBe(email);
    } finally {
      await rollback();
    }
  });

  it("makes the tenant resolvable by auth_uid — which is the whole point", async () => {
    try {
      const businessId = await makeBusiness();
      const uid = uniq("uid");
      await admin.query("SELECT app_attach_user_to_business($1, $2, $3)", [
        uid,
        `${uniq("owner")}@example.com`,
        businessId,
      ]);

      // The lookup requireBusinessAccess depends on (migration 036).
      const { rows } = await admin.query("SELECT * FROM app_lookup_user_by_auth_uid($1)", [uid]);
      expect(rows).toHaveLength(1);
      expect(rows[0].business_id).toBe(businessId);
    } finally {
      await rollback();
    }
  });

  it("refuses a business that does not exist", async () => {
    try {
      await expect(
        admin.query("SELECT app_attach_user_to_business($1, $2, $3)", [
          uniq("uid"),
          `${uniq("x")}@example.com`,
          "00000000-0000-4000-8000-000000000000",
        ])
      ).rejects.toThrow(/no such business/i);
    } finally {
      await rollback();
    }
  });

  it("refuses to repoint an account that already belongs to a tenant", async () => {
    try {
      const a = await makeBusiness();
      const b = await makeBusiness();
      const uid = uniq("uid");

      await admin.query("SELECT app_attach_user_to_business($1, $2, $3)", [uid, `${uniq("o")}@example.com`, a]);
      await expect(
        admin.query("SELECT app_attach_user_to_business($1, $2, $3)", [uid, `${uniq("o")}@example.com`, b])
      ).rejects.toThrow(/already belongs to a business/i);
    } finally {
      await rollback();
    }
  });

  it("hands the caller back the tenant scope it arrived with", async () => {
    try {
      const businessId = await makeBusiness();
      await admin.query("SELECT set_config('app.business_id', $1, true)", [businessId]);

      await admin.query("SELECT app_attach_user_to_business($1, $2, $3)", [
        uniq("uid"),
        `${uniq("o")}@example.com`,
        businessId,
      ]);

      const { rows } = await admin.query("SELECT current_setting('app.business_id', true) AS scope");
      expect(rows[0].scope).toBe(businessId);
    } finally {
      await rollback();
    }
  });

  // ---- the security property -------------------------------------------
  it("is executable by NOBODY — vetra_app must not be able to call it", async () => {
    try {
      const { rows } = await admin.query(
        `SELECT has_function_privilege('vetra_app',
           'app_attach_user_to_business(text, text, uuid)', 'EXECUTE') AS can_execute`
      );
      expect(rows[0].can_execute).toBe(false);
    } finally {
      await rollback();
    }
  });

  it("and the contrast holds: vetra_app CAN call the create-a-new-tenant bootstrap", async () => {
    // Proves the assertion above is measuring a real difference rather than a
    // typo'd signature that would report false for anything.
    try {
      const { rows } = await admin.query(
        `SELECT has_function_privilege('vetra_app',
           'app_create_business_for_user(text, text, text, text)', 'EXECUTE') AS can_execute`
      );
      expect(rows[0].can_execute).toBe(true);
    } finally {
      await rollback();
    }
  });
});
