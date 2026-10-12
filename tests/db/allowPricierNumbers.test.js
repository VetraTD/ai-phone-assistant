// tests/db/allowPricierNumbers.test.js
/**
 * Migration 053 on real Postgres, as the unprivileged vetra_app role under
 * FORCE RLS: businesses.allow_pricier_numbers defaults false, and loadConfig
 * reads true after a scoped UPDATE.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const TENANT = "66666666-aaaa-4aaa-8aaa-666666666666";

let admin;
let db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Pricier Test')`, [TENANT]);
});

const businessRow = async () =>
  (await admin.query(`SELECT * FROM businesses WHERE id = $1`, [TENANT])).rows[0];

describeDb("businesses.allow_pricier_numbers", () => {
  it("defaults to false, and loadConfig says false", async () => {
    const row = await businessRow();
    expect(row.allow_pricier_numbers).toBe(false);
    expect(db.loadConfig(row, []).allowPricierNumbers).toBe(false);
  });

  it("loadConfig reads true after a tenant-scoped UPDATE", async () => {
    await db.withTenant(TENANT, (c) =>
      c.query(`UPDATE businesses SET allow_pricier_numbers = true WHERE id = $1`, [TENANT])
    );
    const row = await businessRow();
    expect(row.allow_pricier_numbers).toBe(true);
    expect(db.loadConfig(row, []).allowPricierNumbers).toBe(true);
  });
});
