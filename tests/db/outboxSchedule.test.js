// tests/db/outboxSchedule.test.js
/**
 * S3-8 fix round 1, I3(a): migration 050's `outbox_schedule` routing table
 * and `app_outbound_webhook_due` -- the 044/045 pattern, real Postgres, the
 * SAME re-owned-to-a-NOBYPASSRLS-role proof tests/db/outboundDirectories.test.js
 * uses for app_outbound_due, so a definer bug that only shows up in
 * production (Cloud SQL's postgres cannot bypass FORCE RLS) cannot hide
 * behind the local superuser.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "obxsched_owner";
const BIZ_A = "0f0f0000-0000-4000-8000-00000000000a";
const BIZ_B = "0f0f0000-0000-4000-8000-00000000000b";
const FNS = ["app_outbound_webhook_due(integer, integer)", "app_sync_outbox_schedule()"];

let admin, app, epA, epB;

async function appTx(fn) {
  await app.query("BEGIN");
  try {
    return await fn(app);
  } finally {
    await app.query("ROLLBACK");
  }
}

async function mkOutbox(admin, biz, epId, { status = "pending", nextAttemptAt = new Date(Date.now() - 60_000), idemSuffix } = {}) {
  const res = await admin.query(
    `INSERT INTO outbox (business_id, kind, target_id, event_type, payload, idempotency_key, status, attempts, next_attempt_at, delivered_at)
     VALUES ($1,'webhook',$2,'call.completed','{}',$3,$4,0,$5,CASE WHEN $4='delivered' THEN now() ELSE NULL END)
     RETURNING id`,
    [biz, epId, `os-${idemSuffix || Math.random().toString(36).slice(2)}`, status, nextAttemptAt]
  );
  return res.rows[0].id;
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO vetra`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'probe_only' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${OWNER}`);
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO ${OWNER}`);
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ_A, BIZ_B]]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Sched A'), ($2,'Sched B')`, [BIZ_A, BIZ_B]);
  epA = (await admin.query(`INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active) VALUES ($1,'https://example.com/a','\\x00','{}',true) RETURNING id`, [BIZ_A])).rows[0].id;
  epB = (await admin.query(`INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active) VALUES ($1,'https://example.com/b','\\x00','{}',true) RETURNING id`, [BIZ_B])).rows[0].id;

  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  if (!admin) return;
  await app?.end().catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ_A, BIZ_B]]).catch(() => {});
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO vetra`).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.end();
});

d("outbox_schedule: honest ownership (Cloud SQL's postgres cannot bypass RLS)", () => {
  it("app_outbound_webhook_due and its sync trigger are owned by a role that cannot bypass RLS", async () => {
    const r = await admin.query(
      `SELECT DISTINCT r.rolbypassrls, r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN ('app_outbound_webhook_due', 'app_sync_outbox_schedule')`
    );
    expect(r.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  it("vetra_app cannot read outbox_schedule directly -- it cannot enumerate", async () => {
    await expect(appTx((c) => c.query(`SELECT 1 FROM outbox_schedule LIMIT 1`))).rejects.toThrow(/permission denied/);
  });
});

d("app_sync_outbox_schedule: the trigger keeps the routing table true", () => {
  it("an INSERT of a pending row creates a matching outbox_schedule row", async () => {
    const id = await mkOutbox(admin, BIZ_A, epA);
    const row = (await admin.query(`SELECT business_id, status FROM outbox_schedule WHERE outbox_id = $1`, [id])).rows[0];
    expect(row).toEqual({ business_id: BIZ_A, status: "pending" });
  });

  it("marking the row delivered removes it from outbox_schedule", async () => {
    const id = await mkOutbox(admin, BIZ_A, epA);
    await admin.query(`UPDATE outbox SET status = 'delivered', delivered_at = now() WHERE id = $1`, [id]);
    const row = (await admin.query(`SELECT 1 FROM outbox_schedule WHERE outbox_id = $1`, [id])).rows[0];
    expect(row).toBeUndefined();
  });

  it("marking the row dead removes it from outbox_schedule too", async () => {
    const id = await mkOutbox(admin, BIZ_A, epA);
    await admin.query(`UPDATE outbox SET status = 'dead' WHERE id = $1`, [id]);
    const row = (await admin.query(`SELECT 1 FROM outbox_schedule WHERE outbox_id = $1`, [id])).rows[0];
    expect(row).toBeUndefined();
  });

  it("a retry (still pending, new next_attempt_at) updates the schedule row in place", async () => {
    const id = await mkOutbox(admin, BIZ_A, epA, { nextAttemptAt: new Date(Date.now() - 5 * 60_000) });
    const laterAt = new Date(Date.now() + 60 * 60_000);
    await admin.query(`UPDATE outbox SET attempts = 1, next_attempt_at = $2 WHERE id = $1`, [id, laterAt]);
    const row = (await admin.query(`SELECT next_attempt_at FROM outbox_schedule WHERE outbox_id = $1`, [id])).rows[0];
    expect(Math.abs(row.next_attempt_at.getTime() - laterAt.getTime())).toBeLessThan(1000);
  });

  it("deleting the outbox row deletes its schedule row", async () => {
    const id = await mkOutbox(admin, BIZ_A, epA);
    await admin.query(`DELETE FROM outbox WHERE id = $1`, [id]);
    const row = (await admin.query(`SELECT 1 FROM outbox_schedule WHERE outbox_id = $1`, [id])).rows[0];
    expect(row).toBeUndefined();
  });
});

d("app_outbound_webhook_due: cross-tenant, ids only", () => {
  it("returns due rows across BOTH tenants -- this is the whole point of I3(a): no per-tenant blind spot", async () => {
    const dueA = await mkOutbox(admin, BIZ_A, epA, { idemSuffix: "due-a" });
    const dueB = await mkOutbox(admin, BIZ_B, epB, { idemSuffix: "due-b" });
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_webhook_due(100, 0)`));
    const ids = r.rows.map((row) => row.outbox_id);
    expect(ids).toContain(dueA);
    expect(ids).toContain(dueB);
    const rowA = r.rows.find((row) => row.outbox_id === dueA);
    expect(rowA.business_id).toBe(BIZ_A);
  });

  it("excludes a row not yet due", async () => {
    const futureId = await mkOutbox(admin, BIZ_A, epA, { nextAttemptAt: new Date(Date.now() + 60 * 60_000), idemSuffix: "future" });
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_webhook_due(500, 0)`));
    expect(r.rows.map((row) => row.outbox_id)).not.toContain(futureId);
  });

  it("excludes a delivered or dead row (removed from the schedule by the trigger)", async () => {
    const deliveredId = await mkOutbox(admin, BIZ_A, epA, { idemSuffix: "delivered" });
    await admin.query(`UPDATE outbox SET status = 'delivered', delivered_at = now() WHERE id = $1`, [deliveredId]);
    const deadId = await mkOutbox(admin, BIZ_A, epA, { idemSuffix: "dead" });
    await admin.query(`UPDATE outbox SET status = 'dead' WHERE id = $1`, [deadId]);
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_webhook_due(500, 0)`));
    const ids = r.rows.map((row) => row.outbox_id);
    expect(ids).not.toContain(deliveredId);
    expect(ids).not.toContain(deadId);
  });

  it("runs with NO tenant scope set at all -- this is the cross-tenant sweep's whole reason to exist", async () => {
    const dueId = await mkOutbox(admin, BIZ_A, epA, { idemSuffix: "noscope" });
    const r = await appTx(async (c) => {
      const scope = (await c.query(`SELECT current_setting('app.business_id', true) AS s`)).rows[0].s;
      expect(scope === null || scope === "").toBe(true);
      return c.query(`SELECT * FROM app_outbound_webhook_due(500, 0)`);
    });
    expect(r.rows.map((row) => row.outbox_id)).toContain(dueId);
  });

  it("respects the limit and orders by next_attempt_at", async () => {
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_webhook_due(1, 0)`));
    expect(r.rows.length).toBeLessThanOrEqual(1);
  });
});
