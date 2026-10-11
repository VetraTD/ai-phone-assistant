// tests/db/transferNoAnswer.test.js
/**
 * Migration 052 on real Postgres, run as the unprivileged vetra_app role under
 * FORCE RLS: businesses.transfer_no_answer (default + CHECK) and
 * calls.transferred_at (set once by markCallTransferred, first time wins).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT = "55555555-aaaa-4aaa-8aaa-555555555555";
const SID = "CA-transfer-at-test-0001";

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
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Transfer Test')`, [TENANT]);
  await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status) VALUES ($1, $2, '+15559876543', 'in-progress')`,
    [TENANT, SID]
  );
});

const callRow = async () =>
  (await admin.query(`SELECT status, transferred_at FROM calls WHERE twilio_call_sid = $1`, [SID])).rows[0];

describeDb("calls.transferred_at via markCallTransferred", () => {
  it("sets status and transferred_at inside the tenant scope", async () => {
    await db.withTenant(TENANT, () => db.markCallTransferred(SID));
    const r = await callRow();
    expect(r.status).toBe("transferred");
    expect(r.transferred_at).toBeInstanceOf(Date);
  });

  it("a second call keeps the FIRST timestamp", async () => {
    await db.withTenant(TENANT, () => db.markCallTransferred(SID));
    const first = (await callRow()).transferred_at;
    await new Promise((r) => setTimeout(r, 25));
    await db.withTenant(TENANT, () => db.markCallTransferred(SID));
    expect((await callRow()).transferred_at.getTime()).toBe(first.getTime());
  });

  it("outside a tenant scope the write lands on 0 rows (control: the scoped read-back above is real)", async () => {
    await db.markCallTransferred(SID);
    const r = await callRow();
    expect(r.status).toBe("in-progress");
    expect(r.transferred_at).toBeNull();
  });
});

describeDb("businesses.transfer_no_answer", () => {
  const read = async () =>
    (await admin.query(`SELECT transfer_no_answer FROM businesses WHERE id = $1`, [TENANT])).rows[0].transfer_no_answer;

  it("defaults to take_message", async () => {
    expect(await read()).toBe("take_message");
  });
  it("accepts own_voicemail", async () => {
    await admin.query(`UPDATE businesses SET transfer_no_answer = 'own_voicemail' WHERE id = $1`, [TENANT]);
    expect(await read()).toBe("own_voicemail");
  });
  it("refuses any other value", async () => {
    await expect(
      admin.query(`UPDATE businesses SET transfer_no_answer = 'maybe' WHERE id = $1`, [TENANT])
    ).rejects.toThrow(/transfer_no_answer_check|check constraint/i);
  });
});
