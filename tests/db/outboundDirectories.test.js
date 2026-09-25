import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "outdir_owner";
const BIZ = "0d0d0000-0000-4000-8000-000000000001";
const FNS = [
  "app_outbound_attempt_by_call_sid(text)",
  "app_outbound_due(integer, integer)",
  "app_active_dial_counts()",
  "app_sync_outbound_directories()",
  "app_sync_outreach_schedule()",
];
let admin, app, outreachId, dueId, futureId, closedId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  // Ruling 2a-3a: a crashed prior run can leave these functions owned by
  // outdir_owner. Re-own them to vetra FIRST, or DROP OWNED BY tries to drop
  // the definers themselves and the real cause hides behind "role already
  // exists".
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO vetra`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'probe_only' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${OWNER}`);
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO ${OWNER}`);
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Dir')`, [BIZ]);
  const camp = await admin.query(`INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
                                   VALUES ($1,'c','speed_to_lead','solicited','business','active',3) RETURNING id`, [BIZ]);
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900111') RETURNING id`, [BIZ]);
  const mk = async (key, state, next) => (await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key,next_attempt_at)
     VALUES ($1,$2,3,$3,$4,'{}',$5,$6) RETURNING id`, [BIZ, camp.rows[0].id, con.rows[0].id, state, key, next])).rows[0].id;
  outreachId = await mk("dir-1", "dialing", null);
  dueId = await mk("dir-due", "waiting", new Date(Date.now() - 10 * 60_000));
  futureId = await mk("dir-future", "waiting", new Date(Date.now() + 60 * 60_000));
  closedId = await mk("dir-closed", "closed", new Date(Date.now() - 10 * 60_000));

  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  if (!admin) return;
  await app?.end().catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO vetra`).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.end();
});

async function appTx(fn) {
  await app.query("BEGIN");
  try { return await fn(app); } finally { await app.query("ROLLBACK"); }
}

d("outbound directories: honest ownership", () => {
  it("every definer is owned by a role that cannot bypass RLS, like Cloud SQL's postgres", async () => {
    const r = await admin.query(
      `SELECT DISTINCT r.rolbypassrls, r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN ('app_outbound_attempt_by_call_sid','app_outbound_due','app_active_dial_counts')`);
    expect(r.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  it.each(["call_attempt_directory", "outreach_schedule", "dial_registry"])(
    "vetra_app cannot read %s directly -- it cannot enumerate", async (t) => {
      await expect(appTx((c) => c.query(`SELECT 1 FROM ${t} LIMIT 1`))).rejects.toThrow(/permission denied/);
    });
});

d("app_outbound_attempt_by_call_sid", () => {
  it("resolves a CallSid to its tenant and attempt with NO scope set, and adopts the tenant", async () => {
    await admin.query(`INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
                       VALUES ($1,$2,1,'+441372656055','+447700900111','CAdir0001',now())`, [BIZ, outreachId]);
    const r = await appTx(async (c) => {
      const row = (await c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir0001')`)).rows;
      const scope = (await c.query(`SELECT current_setting('app.business_id', true) AS s`)).rows[0].s;
      return { row, scope };
    });
    expect(r.row).toHaveLength(1);
    expect(r.row[0]).toMatchObject({ business_id: BIZ, outreach_id: outreachId, campaign_version: 3 });
    expect(r.scope).toBe(BIZ);
  });

  it("returns nothing for an unknown CallSid", async () => {
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAnope')`));
    expect(r.rows).toEqual([]);
  });
});

d("app_outbound_due", () => {
  it("returns ids only, only for waiting outreach overdue by more than the grace period", async () => {
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_due(100, 120)`));
    expect(r.fields.map((f) => f.name)).toEqual(["business_id", "outreach_id"]);
    const ids = r.rows.map((x) => x.outreach_id);
    expect(ids).toContain(dueId);
    expect(ids).not.toContain(futureId);
    expect(ids).not.toContain(closedId);
  });

  it("follows the outreach row: rescheduling into the future removes it from the due list", async () => {
    await admin.query(`UPDATE outreach SET next_attempt_at = now() + interval '1 day' WHERE id = $1`, [dueId]);
    const r = await appTx((c) => c.query(`SELECT outreach_id FROM app_outbound_due(100, 0)`));
    expect(r.rows.map((x) => x.outreach_id)).not.toContain(dueId);
    await admin.query(`UPDATE outreach SET next_attempt_at = now() - interval '10 minutes' WHERE id = $1`, [dueId]);
  });
});

d("app_active_dial_counts", () => {
  it("counts an open attempt and stops counting it when it ends", async () => {
    const before = await appTx((c) => c.query(`SELECT active FROM app_active_dial_counts() WHERE business_id = $1`, [BIZ]));
    expect(before.rows[0]?.active).toBe(1); // CAdir0001 from above
    await admin.query(`UPDATE call_attempts SET ended_at = now(), result = 'connected' WHERE twilio_call_sid = 'CAdir0001'`);
    const after = await appTx((c) => c.query(`SELECT active FROM app_active_dial_counts() WHERE business_id = $1`, [BIZ]));
    expect(after.rows).toEqual([]);
  });

  it("ignores an attempt older than an hour that never ended (a lost status callback cannot block capacity forever)", async () => {
    await admin.query(`INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
                       VALUES ($1,$2,2,'+441372656055','+447700900111','CAdir-stale', now() - interval '2 hours')`, [BIZ, outreachId]);
    const r = await appTx((c) => c.query(`SELECT active FROM app_active_dial_counts() WHERE business_id = $1`, [BIZ]));
    expect(r.rows).toEqual([]);
  });
});
