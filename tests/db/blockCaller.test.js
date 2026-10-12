/**
 * `scripts/block-caller.js` against a real PostgreSQL, as a role that cannot
 * bypass row-level security and holds only table privileges (what the migrate
 * job's Cloud SQL `postgres` has on these platform tables). Local `vetra` is a
 * superuser, so a test run as it would pass whatever the script's SQL did; the
 * probe role is created NOSUPERUSER NOBYPASSRLS and one test asserts that.
 *
 * The block is then read back the way the voice service reads it, through
 * app_caller_blocked(number, business), as the admin connection.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { addBlock, removeBlock, listBlocks, formatRow } from "../../scripts/block-caller.js";

const ADMIN_URL = process.env.DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;

const PROBE_ROLE = "block_caller_probe";
const PROBE_PASS = "probe_only";
const BIZ_A_PHONE = "+15550198001";
const BIZ_B_PHONE = "+15550198002";
const CALLER = "+15550198777";
const OTHER = "+15550198778";

let admin;
let probe;
let bizA;
let bizB;

const blocked = async (number, business) =>
  (await admin.query("SELECT app_caller_blocked($1, $2) AS b", [number, business])).rows[0].b;
const rowsFor = async (number) => (await admin.query("SELECT * FROM blocked_callers WHERE phone = $1", [number])).rows;

beforeAll(async () => {
  if (!ADMIN_URL) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await admin.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASS}' NOSUPERUSER NOBYPASSRLS`);
  // Exactly what scripts/block-caller.js touches and nothing more, so a passing
  // test proves the script needs no other table. (app_caller_blocked is read back
  // as admin, never as the probe, so no EXECUTE grant.)
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON blocked_callers TO ${PROBE_ROLE}`);
  await admin.query(`GRANT SELECT ON business_directory TO ${PROBE_ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);

  const u = new URL(ADMIN_URL);
  u.username = PROBE_ROLE;
  u.password = PROBE_PASS;
  probe = new pg.Client({ connectionString: u.toString() });
  await probe.connect();

  await admin.query(`DELETE FROM blocked_callers WHERE phone IN ($1, $2)`, [CALLER, OTHER]);
  await admin.query(`DELETE FROM businesses WHERE phone_number LIKE '+1555019800%'`);
  bizA = (
    await admin.query(`INSERT INTO businesses (name, phone_number, timezone) VALUES ('Block A', $1, 'Europe/London') RETURNING id`, [
      BIZ_A_PHONE,
    ])
  ).rows[0].id;
  bizB = (
    await admin.query(`INSERT INTO businesses (name, phone_number, timezone) VALUES ('Block B', $1, 'Europe/London') RETURNING id`, [
      BIZ_B_PHONE,
    ])
  ).rows[0].id;
}, 60000);

afterAll(async () => {
  if (!admin) return;
  await probe?.end().catch(() => {});
  await admin.query(`DELETE FROM blocked_callers WHERE phone IN ($1, $2)`, [CALLER, OTHER]).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE phone_number LIKE '+1555019800%'`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM blocked_callers WHERE phone IN ($1, $2)`, [CALLER, OTHER]);
});

describeDb("block-caller: the probe role is honest", () => {
  it("cannot bypass row-level security and is not a superuser", async () => {
    const r = await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [PROBE_ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("blocked_callers is a platform table: vetra_app has no grant on it", async () => {
    const r = await admin.query(`SELECT has_table_privilege('vetra_app', 'blocked_callers', 'SELECT') AS s`);
    expect(r.rows[0].s).toBe(false);
  });
});

describeDb("block-caller: add", () => {
  it("a dry run writes nothing", async () => {
    const r = await addBlock(probe, { phone: CALLER, reason: "test", confirm: false });
    expect(r).toMatchObject({ ok: true, dryRun: true, existing: false });
    expect(await rowsFor(CALLER)).toHaveLength(0);
    expect(await blocked(CALLER, bizA)).toBe(false);
  });

  it("a global block refuses the number for any business", async () => {
    const r = await addBlock(probe, { phone: CALLER, reason: "prank", confirm: true });
    expect(r).toMatchObject({ ok: true, rows: 1, inserted: true });
    expect(await blocked(CALLER, bizA)).toBe(true);
    expect(await blocked(CALLER, bizB)).toBe(true);
    expect(await blocked(OTHER, bizA)).toBe(false);
    const [row] = await rowsFor(CALLER);
    expect(row.business_id).toBeNull();
    expect(row.expires_at).toBeNull();
  });

  it("--business scopes the block to that business only", async () => {
    const r = await addBlock(probe, { phone: CALLER, reason: "prank", businessPhone: BIZ_A_PHONE, confirm: true });
    expect(r.ok).toBe(true);
    expect(await blocked(CALLER, bizA)).toBe(true);
    expect(await blocked(CALLER, bizB)).toBe(false);
  });

  it("--days sets an expiry about 24 hours ahead", async () => {
    await addBlock(probe, { phone: CALLER, reason: "prank", days: 1, confirm: true });
    const [row] = await rowsFor(CALLER);
    const ms = new Date(row.expires_at).getTime() - Date.now();
    expect(ms).toBeGreaterThan(23.9 * 3600e3);
    expect(ms).toBeLessThan(24.1 * 3600e3);
    expect(await blocked(CALLER, bizA)).toBe(true);
  });

  it("an expired block no longer refuses", async () => {
    await addBlock(probe, { phone: CALLER, reason: "prank", confirm: true });
    await admin.query(`UPDATE blocked_callers SET expires_at = now() - interval '1 minute' WHERE phone = $1`, [CALLER]);
    expect(await blocked(CALLER, bizA)).toBe(false);
  });

  it("adding again is an upsert: scope, reason and expiry are replaced", async () => {
    await addBlock(probe, { phone: CALLER, reason: "first", confirm: true });
    const again = await addBlock(probe, { phone: CALLER, reason: "second", businessPhone: BIZ_A_PHONE, days: 2, confirm: true });
    expect(again).toMatchObject({ ok: true, rows: 1, inserted: false });
    const rows = await rowsFor(CALLER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "second", business_id: bizA });
    expect(rows[0].expires_at).not.toBeNull();
    expect(await blocked(CALLER, bizB)).toBe(false);
  });

  it("an unknown --business refuses and writes nothing", async () => {
    for (const confirm of [false, true]) {
      const r = await addBlock(probe, { phone: CALLER, reason: "x", businessPhone: "+15550198999", confirm });
      expect(r.ok).toBe(false);
      expect(r.error).not.toContain("+15550198999");
    }
    expect(await rowsFor(CALLER)).toHaveLength(0);
  });
});

describeDb("block-caller: remove", () => {
  it("a dry run counts and deletes nothing", async () => {
    await addBlock(probe, { phone: CALLER, reason: "x", confirm: true });
    const r = await removeBlock(probe, { phone: CALLER, confirm: false });
    expect(r).toMatchObject({ ok: true, dryRun: true, rows: 1 });
    expect(await blocked(CALLER, bizA)).toBe(true);
  });

  it("--confirm deletes the row and reports the count", async () => {
    await addBlock(probe, { phone: CALLER, reason: "x", confirm: true });
    expect(await removeBlock(probe, { phone: CALLER, confirm: true })).toMatchObject({ ok: true, rows: 1 });
    expect(await blocked(CALLER, bizA)).toBe(false);
    expect(await removeBlock(probe, { phone: CALLER, confirm: true })).toMatchObject({ ok: true, rows: 0 });
  });
});

describeDb("block-caller: list", () => {
  it("lists rows and every printed line is masked", async () => {
    await addBlock(probe, { phone: CALLER, reason: "global one", confirm: true });
    await addBlock(probe, { phone: OTHER, reason: "scoped one", businessPhone: BIZ_B_PHONE, days: 3, confirm: true });
    const lines = (await listBlocks(probe)).filter((r) => [CALLER, OTHER].includes(r.phone)).map(formatRow);
    expect(lines).toHaveLength(2);
    const text = lines.join("\n");
    expect(text).toContain("ending 8777");
    expect(text).toContain("ending 8778");
    expect(text).toContain("scope: all");
    expect(text).toContain(`business ${bizB}`);
    expect(text).toContain("until removed");
    expect(text).not.toContain("+1555019877");
    // (the scope's UUID is stripped first: a hex group can be all digits)
    expect(text.replaceAll(bizB, "")).not.toMatch(/\d{7,}/);
  });
});
