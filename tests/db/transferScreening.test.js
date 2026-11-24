// tests/db/transferScreening.test.js
/**
 * Migration 063 (LVX192 fix 4): per-business transfer screening columns and the
 * SECURITY DEFINER functions that judge whether the dispatcher pressed 1.
 * Real Postgres; the functions are called as the unprivileged vetra_app role.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const BIZ = "0f0f0063-0000-4000-8000-00000000000a";
const SID = "CA00630000000000000000000000000001";
const SID2 = "CA00630000000000000000000000000002";
const CALLER = "+15559063001";
const DIALLED = "+15559063200";

let admin, app, db;

const one = async (sql, params = []) => (await app.query(sql, params)).rows[0];
const recordScreened = (sid, timeout = 36) =>
  one(`SELECT app_record_screened_pending_dial($1,$2,$3,$4,$5) AS id`, [BIZ, sid, CALLER, DIALLED, timeout]);
const recordPlain = (sid) =>
  one(`SELECT app_record_pending_dial($1,$2,$3,$4,$5) AS id`, [BIZ, sid, CALLER, DIALLED, 20]);
const outcome = async (sid) => (await one(`SELECT app_pending_dial_outcome($1) AS v`, [sid])).v;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  await app?.end().catch(() => {});
  await db?.close().catch(() => {});
  process.env.DATABASE_URL = url;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Screening Test')`, [BIZ]);
});

d("063: columns", () => {
  it("defaults: screening false, whisper null, and loadConfig agrees", async () => {
    const row = (await admin.query(`SELECT * FROM businesses WHERE id = $1`, [BIZ])).rows[0];
    expect(row.transfer_screening).toBe(false);
    expect(row.transfer_whisper).toBeNull();
    const cfg = db.loadConfig(row, []);
    expect(cfg.transferScreening).toBe(false);
    expect(cfg.transferWhisper).toBeNull();
  });

  it("a whisper over 200 characters is rejected, 200 is accepted", async () => {
    await admin.query(`UPDATE businesses SET transfer_whisper = $2 WHERE id = $1`, [BIZ, "x".repeat(200)]);
    await expect(
      admin.query(`UPDATE businesses SET transfer_whisper = $2 WHERE id = $1`, [BIZ, "x".repeat(201)])
    ).rejects.toThrow(/transfer_whisper|check/i);
  });

  it("pending_dials gains screened (default false) and accepted_at", async () => {
    const r = await admin.query(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'pending_dials' AND column_name IN ('screened','accepted_at') ORDER BY 1`
    );
    expect(r.rows.map((x) => x.column_name)).toEqual(["accepted_at", "screened"]);
    expect(r.rows.find((x) => x.column_name === "screened")).toMatchObject({ column_default: "false", is_nullable: "NO" });
  });
});

d("063: functions", () => {
  it("vetra_app still cannot read pending_dials directly", async () => {
    await expect(app.query(`SELECT * FROM pending_dials`)).rejects.toThrow(/permission denied/);
  });

  it("an unscreened dial, and a call with no dial, are 'unscreened'", async () => {
    await recordPlain(SID);
    expect(await outcome(SID)).toBe("unscreened");
    expect(await outcome(SID2)).toBe("unscreened");
    expect(await outcome(null)).toBe("unscreened");
  });

  it("a screened dial is 'not_accepted' until accepted, then 'accepted'", async () => {
    await recordScreened(SID);
    expect(await outcome(SID)).toBe("not_accepted");
    expect((await one(`SELECT app_accept_pending_dial($1) AS n`, [SID])).n).toBe(1);
    expect(await outcome(SID)).toBe("accepted");
  });

  it("accept is a no-op (0 rows) for an unscreened, unknown or ended dial", async () => {
    await recordPlain(SID);
    expect((await one(`SELECT app_accept_pending_dial($1) AS n`, [SID])).n).toBe(0);
    expect((await one(`SELECT app_accept_pending_dial($1) AS n`, [SID2])).n).toBe(0);
    await recordScreened(SID2);
    await one(`SELECT app_end_pending_dial($1)`, [SID2]);
    expect((await one(`SELECT app_accept_pending_dial($1) AS n`, [SID2])).n).toBe(0);
    expect(await outcome(SID2)).toBe("not_accepted");
  });

  it("business lookup: the open screened dial's business, else null", async () => {
    expect((await one(`SELECT app_pending_dial_business($1) AS b`, [SID])).b).toBeNull();
    await recordPlain(SID);
    expect((await one(`SELECT app_pending_dial_business($1) AS b`, [SID])).b).toBeNull();
    await recordScreened(SID2);
    expect((await one(`SELECT app_pending_dial_business($1) AS b`, [SID2])).b).toBe(BIZ);
    await one(`SELECT app_end_pending_dial($1)`, [SID2]);
    expect((await one(`SELECT app_pending_dial_business($1) AS b`, [SID2])).b).toBeNull();
  });

  it("the newest dial row decides the outcome", async () => {
    await recordScreened(SID);
    await one(`SELECT app_accept_pending_dial($1)`, [SID]);
    await recordPlain(SID);
    expect(await outcome(SID)).toBe("unscreened");
  });

  it("a screened dial expires at timeout + 15 s like any other", async () => {
    await recordScreened(SID, 36);
    const r = await admin.query(
      `SELECT screened, EXTRACT(EPOCH FROM (expires_at - started_at))::int AS ttl FROM pending_dials WHERE call_sid = $1`,
      [SID]
    );
    expect(r.rows[0].screened).toBe(true);
    expect(r.rows[0].ttl).toBe(51);
  });
});

d("063: db wrappers", () => {
  it("recordPendingDial({screened}) -> business -> accept -> outcome", async () => {
    await db.recordPendingDial({ businessId: BIZ, callSid: SID, callerNumber: CALLER, dialledNumber: DIALLED, timeoutSec: 36, screened: true });
    expect(await db.pendingDialBusiness(SID)).toBe(BIZ);
    expect(await db.pendingDialOutcome(SID)).toBe("not_accepted");
    expect(await db.acceptPendingDial(SID)).toBe(1);
    expect(await db.pendingDialOutcome(SID)).toBe("accepted");
  });

  it("without screened it is the old unscreened dial", async () => {
    await db.recordPendingDial({ businessId: BIZ, callSid: SID, callerNumber: CALLER, dialledNumber: DIALLED, timeoutSec: 20 });
    expect(await db.pendingDialBusiness(SID)).toBeNull();
    expect(await db.pendingDialOutcome(SID)).toBe("unscreened");
  });
});
