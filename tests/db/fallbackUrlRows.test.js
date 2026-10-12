/**
 * `scripts/fallback-urls.js` row read, against a real PostgreSQL, as a role that
 * CANNOT bypass row-level security. The probe role owns the SECURITY DEFINER
 * lookup (as production's `postgres` does). app_lookup_business_by_phone adopts
 * the first tenant it sees for a whole transaction, so the read must be one
 * autocommit query per phone; the last test shows the single-transaction shape
 * really does lose the second tenant, which is what lets this file fail.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { listFallbackRows } from "../../lib/db/fallbackUrlRows.js";

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_ROLE = "fur_probe";
const PROBE_PASS = "probe_only";

const ONE = { id: "6d6d0000-0000-4000-8000-000000000001", phone: "+441372990001", transfer: "+442071230001" };
const TWO = { id: "6d6d0000-0000-4000-8000-000000000002", phone: "+441372990002", transfer: "+442071230002" };
const OURS = [ONE.phone, TWO.phone];
const OUR_IDS = [ONE.id, TWO.id];

let admin;
let probeUrl;
let pool;

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
  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO ${PROBE_ROLE}`);

  await admin.query(`DELETE FROM businesses WHERE phone_number = ANY($1) OR id = ANY($2)`, [OURS, OUR_IDS]);
  for (const [b, name] of [[ONE, "Fallback One"], [TWO, "Fallback Two"]]) {
    await admin.query(
      `INSERT INTO businesses (id, name, phone_number, transfer_phone_number, transfer_no_answer)
       VALUES ($1, $2, $3, $4, 'own_voicemail')`,
      [b.id, name, b.phone, b.transfer]
    );
  }

  const u = new URL(ADMIN_URL);
  u.username = PROBE_ROLE;
  u.password = PROBE_PASS;
  probeUrl = u.toString();
  pool = new pg.Pool({ connectionString: probeUrl, max: 2 });
}, 60000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE phone_number = ANY($1) OR id = ANY($2)`, [OURS, OUR_IDS]).catch(() => {});
  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO vetra`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  await admin.end();
});

d("fallback-urls row read", () => {
  it("is not a bypass: a direct select with no scope reads 0 rows as the probe role", async () => {
    const r = await pool.query(`SELECT id FROM businesses WHERE phone_number = $1`, [ONE.phone]);
    expect(r.rows).toHaveLength(0);
  });

  it("returns BOTH tenants with their transfer numbers (one lookup per phone)", async () => {
    const rows = (await listFallbackRows(pool)).filter((r) => OURS.includes(r.phone_number));
    expect(rows.map((r) => r.phone_number)).toEqual(OURS);
    expect(rows.map((r) => r.transfer_phone_number)).toEqual([ONE.transfer, TWO.transfer]);
    expect(rows.map((r) => r.name)).toEqual(["Fallback One", "Fallback Two"]);
    expect(rows[0].transfer_no_answer).toBe("own_voicemail");
    expect(rows[0].allow_pricier_numbers).toBe(false);
    expect(rows[0].business.id).toBe(ONE.id);
  });

  it("the trap is real: both lookups inside one transaction return only the first tenant", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const a = await c.query("SELECT * FROM app_lookup_business_by_phone($1)", [ONE.phone]);
      const b = await c.query("SELECT * FROM app_lookup_business_by_phone($1)", [TWO.phone]);
      await c.query("COMMIT");
      expect(a.rows).toHaveLength(1);
      expect(b.rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });
});
