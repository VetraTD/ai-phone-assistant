// tests/db/callHandled.test.js
/**
 * Migration 061 against real Postgres: a call's open item can be marked done.
 *
 * `calls.handled_at` / `calls.handled_by` record who cleared what the call left
 * for the owner (a message or call-back request). The launch backfill (owner,
 * 2026-11-22) keeps the last 7 days open and marks older items done "at launch",
 * not by a person, so the new Home does not open on months of history.
 *
 * The backfill is an UPDATE run by the migrating role, which on Cloud SQL OWNS
 * the tables and does NOT bypass row-level security. Under FORCE RLS such an
 * UPDATE matches nothing and reports no error (the trap migrations 034 and 036
 * fell into). So the migration's own SQL is run here as an owner role modelled
 * on Cloud SQL's `postgres`, inside a transaction that is rolled back, and the
 * rows are read back before the rollback.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const MIGRATION = new URL("../../database/061_call_handled.sql", import.meta.url);
const OWNER_ROLE = "callhandled_owner";

const TENANT = "6a1f0a2b-7c3d-4e5f-8a9b-0c1d2e3f4a61";
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

let admin;
const ids = {};

async function seedCall(sid, startedAt, withRequest) {
  const r = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, started_at)
     VALUES ($1, $2, '+15550161000', 'completed', $3) RETURNING id`,
    [TENANT, sid, startedAt]
  );
  const id = r.rows[0].id;
  if (withRequest) {
    await admin.query(
      `INSERT INTO customer_requests (business_id, call_id, request_type, caller_name, message)
       VALUES ($1, $2, 'callback', 'Sample Caller', 'Please ring back')`,
      [TENANT, id]
    );
  }
  return id;
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER_ROLE} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`);
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Call Handled Probe')`, [TENANT]);
  ids.oldWithRequest = await seedCall("CA_handled_old_req", ago(8), true);
  ids.recentWithRequest = await seedCall("CA_handled_recent_req", ago(6), true);
  ids.oldNoRequest = await seedCall("CA_handled_old_none", ago(8), false);
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${OWNER_ROLE}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER_ROLE}`).catch(() => {});
  await admin.end();
});

describeDb("061: a call's open item can be marked done", () => {
  it("adds handled_at and handled_by, and the open-items index", async () => {
    const cols = await admin.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'calls' AND column_name IN ('handled_at', 'handled_by') ORDER BY column_name`
    );
    expect(cols.rows).toEqual([
      { column_name: "handled_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "handled_by", data_type: "text", is_nullable: "YES" },
    ]);
    const idx = await admin.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_calls_open_items'`);
    expect(idx.rows[0]?.indexdef).toMatch(/\(business_id, started_at\) WHERE \(handled_at IS NULL\)/);
  });

  it("gives up rather than queue live call writes behind it", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    const firstStatement = sql.split("\n").find((l) => l.trim() && !l.trim().startsWith("--"));
    expect(firstStatement.trim()).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it("indexes requests and bookings by call, which every Home and Inbox read joins on", async () => {
    const r = await admin.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('idx_customer_requests_call', 'idx_appointments_call') ORDER BY indexname`
    );
    expect(r.rows.map((x) => x.indexname)).toEqual(["idx_appointments_call", "idx_customer_requests_call"]);
    expect(r.rows[0].indexdef).toMatch(/\(call_id\)/);
    expect(r.rows[1].indexdef).toMatch(/\(call_id\)/);
  });

  it("the launch backfill, run as a Cloud SQL-like owner, closes only requests older than 7 days", async () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    await admin.query("BEGIN");
    try {
      // Model Cloud SQL: the migrating role owns the tables and does NOT bypass
      // RLS. The superuser `vetra` would bypass regardless and prove nothing.
      await admin.query(`ALTER TABLE calls OWNER TO ${OWNER_ROLE}`);
      await admin.query(`ALTER TABLE customer_requests OWNER TO ${OWNER_ROLE}`);
      await admin.query(`ALTER TABLE appointments OWNER TO ${OWNER_ROLE}`);
      await admin.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
      await admin.query(sql);
      await admin.query(`RESET ROLE`);

      const rows = await admin.query(
        `SELECT id, handled_at IS NOT NULL AS done, handled_by FROM calls WHERE business_id = $1`,
        [TENANT]
      );
      const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
      expect(byId[ids.oldWithRequest]).toMatchObject({ done: true, handled_by: "launch" });
      expect(byId[ids.recentWithRequest]).toMatchObject({ done: false, handled_by: null });
      expect(byId[ids.oldNoRequest]).toMatchObject({ done: false, handled_by: null });

      // The migration stood FORCE down for its backfill and must put it back.
      const force = await admin.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('calls', 'customer_requests') ORDER BY relname`
      );
      expect(force.rows).toEqual([
        { relname: "calls", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "customer_requests", relrowsecurity: true, relforcerowsecurity: true },
      ]);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("re-running it keeps an item someone marked done as theirs", async () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    await admin.query("BEGIN");
    try {
      await admin.query(
        `UPDATE calls SET handled_at = now() - interval '1 day', handled_by = 'staff-uid-1' WHERE id = $1`,
        [ids.oldWithRequest]
      );
      await admin.query(sql);
      const r = await admin.query(`SELECT handled_by FROM calls WHERE id = $1`, [ids.oldWithRequest]);
      expect(r.rows[0].handled_by).toBe("staff-uid-1");
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});
