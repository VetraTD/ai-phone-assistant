// tests/db/loopGuard.test.js
/**
 * Migration 054 (batch 3, S4): pending_dials, blocked_callers and the six
 * SECURITY DEFINER functions behind the loop guard, the block list and the
 * repeat-caller counts. Real Postgres, queried as vetra_app.
 *
 * WHY THE RE-OWN: in production the functions are owned by Cloud SQL's
 * `postgres`, which cannot bypass FORCE RLS. Locally the owner is a superuser,
 * which can, so a function that forgot to set the tenant scope would pass here
 * and read ZERO rows in production. Every function is therefore re-owned to a
 * NOBYPASSRLS role first (the tests/db/outboxSchedule.test.js pattern).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "loopguard_owner";
const BIZ_A = "0f0f0054-0000-4000-8000-00000000000a";
const BIZ_B = "0f0f0054-0000-4000-8000-00000000000b";
const PHONE_A = "+15559054001";
const PHONE_B = "+15559054002";
const X = "+15559054100"; // the caller we count
const Y = "+15559054101"; // another caller
const DIALLED = "+15559054200"; // the number we transferred to
const OTHER = "+15559054300";
const FNS = [
  "app_record_pending_dial(uuid, text, text, text, integer)",
  "app_end_pending_dial(text)",
  "app_dial_bounced(uuid, text)",
  "app_caller_blocked(text, uuid)",
  "app_calls_from_today(text)",
  "app_ai_seconds_today(uuid, text, text)",
];

let admin, app, db;

const DAY_START = `date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const bounced = async (biz, from) => (await one(app, `SELECT app_dial_bounced($1,$2) AS v`, [biz, from])).v;
const blocked = async (from, biz) => (await one(app, `SELECT app_caller_blocked($1,$2) AS v`, [from, biz])).v;
const record = (biz, sid, caller, dialled, timeout = 20) =>
  one(app, `SELECT app_record_pending_dial($1,$2,$3,$4,$5) AS id`, [biz, sid, caller, dialled, timeout]);

async function seedCall(biz, sid, caller, { direction = "inbound", startOffset = "1 second", endSecs = null, transferSecs = null, dayShift = "0 days" } = {}) {
  await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, direction, started_at, ended_at, transferred_at)
     SELECT $1, $2, $3, $4, s.t,
            CASE WHEN $5::int IS NULL THEN NULL ELSE s.t + make_interval(secs => $5::int) END,
            CASE WHEN $6::int IS NULL THEN NULL ELSE s.t + make_interval(secs => $6::int) END
       FROM (SELECT ${DAY_START} + $7::interval + $8::interval AS t) s`,
    [biz, sid, caller, direction, endSecs, transferSecs, startOffset, dayShift]
  );
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
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${OWNER}`);
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO ${OWNER}`);
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
  await admin.query(`DELETE FROM blocked_callers WHERE phone LIKE '+1555905%'`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ_A, BIZ_B]]).catch(() => {});
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO vetra`).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM blocked_callers WHERE phone LIKE '+1555905%'`);
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ_A, BIZ_B]]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1,'Guard A',$2), ($3,'Guard B',$4)`, [BIZ_A, PHONE_A, BIZ_B, PHONE_B]);
  // The directory is normally kept by a trigger; make sure both rows exist either way.
  for (const [b, p] of [[BIZ_A, PHONE_A], [BIZ_B, PHONE_B]]) {
    await admin.query(`INSERT INTO business_directory (phone_number, business_id) VALUES ($1,$2) ON CONFLICT (phone_number) DO NOTHING`, [p, b]);
  }
});

d("054: honest ownership and no direct table access", () => {
  it("the six functions are owned by a role that cannot bypass RLS", async () => {
    const r = await admin.query(
      `SELECT DISTINCT r.rolbypassrls, r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = ANY($1::text[])`,
      [FNS.map((f) => f.split("(")[0])]
    );
    expect(r.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  it("1. vetra_app cannot SELECT pending_dials or blocked_callers directly", async () => {
    for (const t of ["pending_dials", "blocked_callers"]) {
      await app.query("BEGIN");
      try {
        await expect(app.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toThrow(/permission denied/);
      } finally {
        await app.query("ROLLBACK");
      }
    }
  });

  it("2. with no tenant set, vetra_app gets correct non-zero answers from every function", async () => {
    expect((await one(app, `SELECT current_setting('app.business_id', true) AS s`)).s || "").toBe("");
    const rec = await record(BIZ_A, "CAguard2", X, DIALLED);
    expect(Number(rec.id)).toBeGreaterThan(0);
    expect(await bounced(BIZ_A, X)).toBe(true);
    await admin.query(`INSERT INTO blocked_callers (phone, reason) VALUES ($1,'test')`, [Y]);
    expect(await blocked(Y, BIZ_A)).toBe(true);
    await seedCall(BIZ_A, "CAguard2-c1", X, { endSecs: 100 });
    expect((await one(app, `SELECT app_calls_from_today($1) AS n`, [X])).n).toBe(1);
    expect((await one(app, `SELECT app_ai_seconds_today($1,$2) AS n`, [BIZ_A, X])).n).toBe(100);
    expect((await one(app, `SELECT app_end_pending_dial($1) AS n`, ["CAguard2"])).n).toBe(1);
  });
});

d("054: the loop guard", () => {
  it("3. a recorded dial bounces from the caller and from the dialled number, for that business only", async () => {
    await record(BIZ_A, "CAg3", X, DIALLED);
    expect(await bounced(BIZ_A, X)).toBe(true);
    expect(await bounced(BIZ_A, DIALLED)).toBe(true);
    expect(await bounced(BIZ_A, OTHER)).toBe(false);
    expect(await bounced(BIZ_B, X)).toBe(false);
  });

  it("4. ending the dial returns 1 then 0, and an ended dial never matches", async () => {
    await record(BIZ_A, "CAg4", X, DIALLED);
    expect((await one(app, `SELECT app_end_pending_dial($1) AS n`, ["CAg4"])).n).toBe(1);
    expect((await one(app, `SELECT app_end_pending_dial($1) AS n`, ["CAg4"])).n).toBe(0);
    expect(await bounced(BIZ_A, X)).toBe(false);
    expect(await bounced(BIZ_A, DIALLED)).toBe(false);
    expect((await one(app, `SELECT app_end_pending_dial($1) AS n`, [null])).n).toBe(0);
    expect((await one(app, `SELECT app_end_pending_dial($1) AS n`, ["  "])).n).toBe(0);
  });

  it("5. an expired dial never matches", async () => {
    await record(BIZ_A, "CAg5", X, DIALLED);
    expect(await bounced(BIZ_A, X)).toBe(true);
    await admin.query(`UPDATE pending_dials SET expires_at = now() - interval '1 second' WHERE call_sid = 'CAg5'`);
    expect(await bounced(BIZ_A, X)).toBe(false);
    expect(await bounced(BIZ_A, DIALLED)).toBe(false);
  });

  it("6. expiry is timeout + 15 s, with the timeout clamped to 5..120", async () => {
    const secs = async (sid) =>
      (await one(admin, `SELECT EXTRACT(EPOCH FROM expires_at - started_at)::int AS s FROM pending_dials WHERE call_sid = $1`, [sid])).s;
    for (const [timeout, want] of [[20, 35], [45, 60], [0, 20], [999, 135]]) {
      await record(BIZ_A, `CAg6-${timeout}`, X, DIALLED, timeout);
      expect(await secs(`CAg6-${timeout}`), `timeout ${timeout}`).toBe(want);
    }
  });

  it("7. rows older than a day are deleted by the next record", async () => {
    await admin.query(
      `INSERT INTO pending_dials (business_id, call_sid, caller_number, dialled_number, started_at, expires_at)
       VALUES ($1,'CAg7-old',$2,$3, now() - interval '2 days', now() - interval '2 days')`,
      [BIZ_A, X, DIALLED]
    );
    await record(BIZ_A, "CAg7-new", X, DIALLED);
    const rows = (await admin.query(`SELECT call_sid FROM pending_dials WHERE call_sid IN ('CAg7-old','CAg7-new')`)).rows;
    expect(rows).toEqual([{ call_sid: "CAg7-new" }]);
  });

  it("8. a null or blank caller is stored NULL and matches only through the dialled number", async () => {
    await record(BIZ_A, "CAg8-null", null, DIALLED);
    await record(BIZ_A, "CAg8-blank", "   ", OTHER);
    const stored = (await admin.query(`SELECT call_sid, caller_number FROM pending_dials WHERE call_sid LIKE 'CAg8-%' ORDER BY call_sid`)).rows;
    expect(stored).toEqual([
      { call_sid: "CAg8-blank", caller_number: null },
      { call_sid: "CAg8-null", caller_number: null },
    ]);
    expect(await bounced(BIZ_A, DIALLED)).toBe(true);
    expect(await bounced(BIZ_A, OTHER)).toBe(true);
    expect(await bounced(BIZ_A, X)).toBe(false);
    expect(await bounced(BIZ_A, "")).toBe(false);
    expect(await bounced(BIZ_A, "   ")).toBe(false);
    expect(await bounced(BIZ_A, null)).toBe(false);
    expect(await bounced(null, DIALLED)).toBe(false);
  });

  it("9. recording requires a business, a call sid and a dialled number", async () => {
    await expect(record(null, "CAg9", X, DIALLED)).rejects.toThrow(/required/);
    await expect(record(BIZ_A, "  ", X, DIALLED)).rejects.toThrow(/required/);
    await expect(record(BIZ_A, null, X, DIALLED)).rejects.toThrow(/required/);
    await expect(record(BIZ_A, "CAg9", X, "  ")).rejects.toThrow(/required/);
    await expect(record(BIZ_A, "CAg9", X, null)).rejects.toThrow(/required/);
  });
});

d("054: the block list", () => {
  it("10. global, per-business and expiring blocks", async () => {
    const GLOBAL = "+15559054401";
    const ONLY_A = "+15559054402";
    const EXPIRED = "+15559054403";
    const FUTURE = "+15559054404";
    await admin.query(
      `INSERT INTO blocked_callers (phone, business_id, reason, expires_at) VALUES
        ($1, NULL, 'g', NULL), ($2, $5, 'a', NULL),
        ($3, NULL, 'e', now() - interval '1 second'), ($4, NULL, 'f', now() + interval '1 day')`,
      [GLOBAL, ONLY_A, EXPIRED, FUTURE, BIZ_A]
    );
    expect(await blocked(GLOBAL, BIZ_A)).toBe(true);
    expect(await blocked(GLOBAL, BIZ_B)).toBe(true);
    expect(await blocked(ONLY_A, BIZ_A)).toBe(true);
    expect(await blocked(ONLY_A, BIZ_B)).toBe(false);
    expect(await blocked(EXPIRED, BIZ_A)).toBe(false);
    expect(await blocked(FUTURE, BIZ_A)).toBe(true);
    expect(await blocked(OTHER, BIZ_A)).toBe(false);
    expect(await blocked(null, BIZ_A)).toBe(false);
    expect(await blocked("  ", BIZ_A)).toBe(false);
  });
});

d("054: repeat-caller counts", () => {
  it("11. app_calls_from_today counts today's inbound calls from the number across tenants and restores the scope", async () => {
    await seedCall(BIZ_A, "CAg11-a1", X);
    await seedCall(BIZ_A, "CAg11-a2", X, { startOffset: "2 seconds" });
    await seedCall(BIZ_B, "CAg11-b1", X);
    await seedCall(BIZ_A, "CAg11-out", X, { direction: "outbound" });
    await seedCall(BIZ_A, "CAg11-yday", X, { dayShift: "-1 hour", startOffset: "0 seconds" });
    await seedCall(BIZ_A, "CAg11-other", Y);
    expect((await one(app, `SELECT app_calls_from_today($1) AS n`, [X])).n).toBe(3);
    expect((await one(app, `SELECT app_calls_from_today($1) AS n`, [null])).n).toBe(0);
    expect((await one(app, `SELECT app_calls_from_today($1) AS n`, ["  "])).n).toBe(0);

    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_A]);
      expect((await one(app, `SELECT app_calls_from_today($1) AS n`, [X])).n).toBe(3);
      expect((await one(app, `SELECT current_setting('app.business_id', true) AS s`)).s).toBe(BIZ_A);
    } finally {
      await app.query("ROLLBACK");
    }
  });

  it("12. app_ai_seconds_today sums AI time only, counts a transfer at the transfer, and can exclude a call", async () => {
    await seedCall(BIZ_A, "CAg12-normal", X, { endSecs: 600 });
    await seedCall(BIZ_A, "CAg12-xfer", X, { startOffset: "2 seconds", transferSecs: 120, endSecs: 900 });
    await seedCall(BIZ_A, "CAg12-live", X, { startOffset: "3 seconds" });
    await seedCall(BIZ_A, "CAg12-out", X, { direction: "outbound", endSecs: 300 });
    await seedCall(BIZ_A, "CAg12-other", Y, { endSecs: 500 });
    await seedCall(BIZ_B, "CAg12-b", X, { endSecs: 777 });
    const secs = (biz, who, excl) => one(app, `SELECT app_ai_seconds_today($1,$2,$3) AS n`, [biz, who, excl ?? null]).then((r) => r.n);
    expect(await secs(BIZ_A, X)).toBe(720);
    expect(await secs(BIZ_A, X, "CAg12-normal")).toBe(120);
    expect(await secs(BIZ_B, X)).toBe(777);
    expect(await secs(null, X)).toBe(0);
    expect(await secs(BIZ_A, null)).toBe(0);
    expect(await secs(BIZ_A, "  ")).toBe(0);

    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_B]);
      await expect(app.query(`SELECT app_ai_seconds_today($1,$2)`, [BIZ_A, X])).rejects.toThrow(/another tenant/);
    } finally {
      await app.query("ROLLBACK");
    }
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_A]);
      expect((await one(app, `SELECT app_ai_seconds_today($1,$2) AS n`, [BIZ_A, X])).n).toBe(720);
      expect((await one(app, `SELECT current_setting('app.business_id', true) AS s`)).s).toBe(BIZ_A);
    } finally {
      await app.query("ROLLBACK");
    }
  });
});

d("054: the services/db.js wrappers", () => {
  it("13. return the documented shapes", async () => {
    const id = await db.recordPendingDial({ businessId: BIZ_A, callSid: "CAg13", callerNumber: X, dialledNumber: DIALLED, timeoutSec: 20 });
    expect(Number(id)).toBeGreaterThan(0);
    await admin.query(`INSERT INTO blocked_callers (phone, reason) VALUES ($1,'t')`, [X]);
    await seedCall(BIZ_A, "CAg13-c1", X, { endSecs: 60 });
    await seedCall(BIZ_A, "CAg13-c2", X, { startOffset: "2 seconds", endSecs: 40 });

    expect(await db.inboundGuardFacts({ businessId: BIZ_A, from: X, countCalls: true })).toEqual({ blocked: true, bounced: true, callsToday: 2 });
    expect(await db.inboundGuardFacts({ businessId: BIZ_A, from: X, countCalls: false })).toEqual({ blocked: true, bounced: true, callsToday: 0 });
    expect(await db.inboundGuardFacts({ businessId: BIZ_B, from: OTHER, countCalls: true })).toEqual({ blocked: false, bounced: false, callsToday: 0 });
    expect(await db.aiSecondsToday({ businessId: BIZ_A, callerNumber: X, callSid: "CAg13-c1" })).toEqual({ after: 100, before: 40 });
    expect(await db.endPendingDial("CAg13")).toBe(1);
    expect(await db.endPendingDial("CAg13")).toBe(0);
    await expect(db.recordPendingDial({ businessId: null, callSid: "CAg13b", callerNumber: X, dialledNumber: DIALLED, timeoutSec: 20 })).rejects.toThrow(/required/);
  });
});
