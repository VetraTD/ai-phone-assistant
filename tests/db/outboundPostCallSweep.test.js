// tests/db/outboundPostCallSweep.test.js
/**
 * Migration 045 (spec §6.3, §11, owner decision O-5): the sweep's one entry
 * point for every stale outbound attempt across every tenant --
 * app_outbound_stale_attempts -- and the postcall_pending directory that
 * backs its `postcall_pending` kind. Same shape as tests/db/
 * outboundDirectories.test.js (044): re-own the definers to a NOBYPASSRLS
 * role first, so a broken function cannot hide behind the local superuser.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "postcall_sweep_owner";
const BIZ = "05450000-0000-4000-8000-000000000001";
const BIZ2 = "05450000-0000-4000-8000-000000000002";
const FNS = ["app_outbound_stale_attempts(integer,integer,integer,integer)", "app_sync_postcall_pending()"];

let admin, app, campaignId, contactId, outreachId;

async function mkAttempt(sid, { dialedAt, statusCompletedAt = null, postCallStartedAt = null, business = BIZ } = {}) {
  const r = await admin.query(
    `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, twilio_call_sid, dialed_at, status_completed_at, post_call_started_at)
     VALUES ($1,$2,(SELECT COALESCE(MAX(attempt_no),0)+1 FROM call_attempts WHERE outreach_id=$2),'+441372656055','+447700900111',$3,$4,$5,$6)
     RETURNING id`,
    [business, outreachId, sid, dialedAt, statusCompletedAt, postCallStartedAt]
  );
  return r.rows[0].id;
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

  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, BIZ2]]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Sweep'), ($2,'Sweep2')`, [BIZ, BIZ2]);
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',1) RETURNING id`,
    [BIZ]
  );
  campaignId = camp.rows[0].id;
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900111') RETURNING id`, [BIZ]);
  contactId = con.rows[0].id;
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key)
     VALUES ($1,$2,1,$3,'dialing','{}','sweep-1') RETURNING id`,
    [BIZ, campaignId, contactId]
  );
  outreachId = out.rows[0].id;

  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  if (!admin) return;
  await app?.end().catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, BIZ2]]).catch(() => {});
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
  try {
    return await fn(app);
  } finally {
    await app.query("ROLLBACK");
  }
}

async function stale(opts = {}) {
  const { limit = 100, sidlessMinutes = 10, lostMinutes = 15, postcallSeconds = 120 } = opts;
  const r = await appTx((c) =>
    c.query(`SELECT * FROM app_outbound_stale_attempts($1,$2,$3,$4)`, [limit, sidlessMinutes, lostMinutes, postcallSeconds])
  );
  return r;
}

d("outbound postcall sweep: honest ownership", () => {
  it("every definer is owned by a role that cannot bypass RLS, like Cloud SQL's postgres", async () => {
    const r = await admin.query(
      `SELECT DISTINCT r.rolbypassrls, r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN ('app_outbound_stale_attempts','app_sync_postcall_pending')`
    );
    expect(r.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  it("vetra_app cannot read postcall_pending directly -- it cannot enumerate", async () => {
    await expect(appTx((c) => c.query(`SELECT 1 FROM postcall_pending LIMIT 1`))).rejects.toThrow(/permission denied/);
  });

  it("carries a routing-only COMMENT (the 033/039/044 idiom)", async () => {
    const r = await admin.query(`SELECT obj_description('public.postcall_pending'::regclass, 'pg_class') AS c`);
    expect(r.rows[0].c).toMatch(/^Routing only:/);
    expect(r.rows[0].c).toMatch(/never carry a phone number or a name/);
  });
});

d("app_outbound_stale_attempts: ids only, per kind", () => {
  it("returns exactly business_id, attempt_id, kind -- ids only", async () => {
    const r = await stale();
    expect(r.fields.map((f) => f.name)).toEqual(["business_id", "attempt_id", "kind"]);
  });

  it("sidless: a dial_registry row with no directory SID, older than the threshold", async () => {
    const fresh = await mkAttempt("CAsweep-sidless-fresh", { dialedAt: new Date() }); // no twilio_call_sid stamped yet -- still fresh
    await admin.query(`UPDATE call_attempts SET twilio_call_sid = NULL WHERE id = $1`, [fresh]);
    const staleOld = await admin.query(
      `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, dialed_at)
       VALUES ($1,$2,(SELECT COALESCE(MAX(attempt_no),0)+1 FROM call_attempts WHERE outreach_id=$2),'+441372656055','+447700900111', now() - interval '20 minutes')
       RETURNING id`,
      [BIZ, outreachId]
    );
    const oldId = staleOld.rows[0].id;

    const r = await stale({ sidlessMinutes: 10 });
    const sidlessRows = r.rows.filter((x) => x.kind === "sidless");
    const ids = sidlessRows.map((x) => x.attempt_id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(fresh);

    await admin.query(`DELETE FROM call_attempts WHERE id = ANY($1::uuid[])`, [[fresh, oldId]]);
  });

  it("lost_callback: a dial_registry row that HAS a directory SID, older than the threshold", async () => {
    const recent = await mkAttempt("CAsweep-lost-recent", { dialedAt: new Date() });
    const old = await admin.query(
      `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, twilio_call_sid, dialed_at)
       VALUES ($1,$2,(SELECT COALESCE(MAX(attempt_no),0)+1 FROM call_attempts WHERE outreach_id=$2),'+441372656055','+447700900111','CAsweep-lost-old', now() - interval '20 minutes')
       RETURNING id`,
      [BIZ, outreachId]
    );
    const oldId = old.rows[0].id;

    const r = await stale({ lostMinutes: 15 });
    const lostRows = r.rows.filter((x) => x.kind === "lost_callback");
    const ids = lostRows.map((x) => x.attempt_id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(recent);

    await admin.query(`DELETE FROM call_attempts WHERE id = ANY($1::uuid[])`, [[recent, oldId]]);
  });

  it("postcall_pending: an attempt whose status completed but post-call never started, older than the threshold", async () => {
    const recent = await mkAttempt("CAsweep-pcp-recent", { dialedAt: new Date(), statusCompletedAt: new Date() });
    const old = await mkAttempt("CAsweep-pcp-old", { dialedAt: new Date(), statusCompletedAt: new Date(Date.now() - 5 * 60_000) });
    // a claimed one (post_call_started_at set) must NOT appear, even if old.
    const claimed = await mkAttempt("CAsweep-pcp-claimed", {
      dialedAt: new Date(),
      statusCompletedAt: new Date(Date.now() - 5 * 60_000),
      postCallStartedAt: new Date(),
    });

    const r = await stale({ postcallSeconds: 120 });
    const ids = r.rows.filter((x) => x.kind === "postcall_pending").map((x) => x.attempt_id);
    expect(ids).toContain(old);
    expect(ids).not.toContain(recent);
    expect(ids).not.toContain(claimed);

    await admin.query(`DELETE FROM call_attempts WHERE id = ANY($1::uuid[])`, [[recent, old, claimed]]);
  });

  // b39 (fix wave, checkpoint 2b): the OLD version of this test could never
  // fail below 500 real rows -- rowCount <= 500 and "resolves to something
  // truthy" both pass on zero rows. Seeded so p_limit really is the only
  // thing deciding what comes back, and (b34/O-18) that it is the OLDEST.
  it("b39/b34: p_limit=1 and p_limit=-5 both return exactly one row -- the OLDEST of several qualifying rows", async () => {
    const mk = async (minutesAgo) =>
      (
        await admin.query(
          `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, dialed_at)
           VALUES ($1,$2,(SELECT COALESCE(MAX(attempt_no),0)+1 FROM call_attempts WHERE outreach_id=$2),'+441372656055','+447700900111', now() - make_interval(mins => $3))
           RETURNING id`,
          [BIZ, outreachId, minutesAgo]
        )
      ).rows[0].id;

    // Inserted NEWEST first, oldest LAST -- deliberately the opposite of
    // insertion/physical order, so a plan with no explicit ORDER BY (the
    // sabotage) is not accidentally bailed out by matching insertion order.
    const newestId = await mk(20);
    const middleId = await mk(30);
    const oldestId = await mk(40);

    try {
      const r1 = await stale({ limit: 1, sidlessMinutes: 10 });
      expect(r1.rowCount).toBe(1);
      expect(r1.rows[0].attempt_id).toBe(oldestId); // b34/O-18: oldest first, not whatever Postgres's plan happened to produce

      const rNeg = await stale({ limit: -5, sidlessMinutes: 10 });
      expect(rNeg.rowCount).toBe(1);
      expect(rNeg.rows[0].attempt_id).toBe(oldestId);
    } finally {
      await admin.query(`DELETE FROM call_attempts WHERE id = ANY($1::uuid[])`, [[oldestId, middleId, newestId]]);
    }
  });

  it("crosses tenants: a second business's stale attempt is returned too (no tenant scope)", async () => {
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ2]).catch(() => {});
    await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Sweep2') ON CONFLICT (id) DO NOTHING`, [BIZ2]);
    const camp2 = (
      await admin.query(
        `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
         VALUES ($1,'c2','speed_to_lead','solicited','business','active',1) RETURNING id`,
        [BIZ2]
      )
    ).rows[0].id;
    const con2 = (await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900222') RETURNING id`, [BIZ2])).rows[0].id;
    const out2 = (
      await admin.query(
        `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key)
         VALUES ($1,$2,1,$3,'dialing','{}','sweep-2') RETURNING id`,
        [BIZ2, camp2, con2]
      )
    ).rows[0].id;
    const oldId = (
      await admin.query(
        `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, dialed_at)
         VALUES ($1,$2,1,'+441372656055','+447700900222', now() - interval '20 minutes')
         RETURNING id`,
        [BIZ2, out2]
      )
    ).rows[0].id;

    const r = await stale({ sidlessMinutes: 10 });
    const row = r.rows.find((x) => x.attempt_id === oldId);
    expect(row).toMatchObject({ business_id: BIZ2, kind: "sidless" });

    await admin.query(`DELETE FROM outreach WHERE id = $1`, [out2]);
    await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ2]);
  });
});

d("postcall_pending stays true through stamp, claim and delete", () => {
  it("a fresh attempt: no row", async () => {
    const id = await mkAttempt("CAsweep-life-1", { dialedAt: new Date() });
    const r = await admin.query(`SELECT * FROM postcall_pending WHERE attempt_id = $1`, [id]);
    expect(r.rows).toHaveLength(0);
    await admin.query(`DELETE FROM call_attempts WHERE id = $1`, [id]);
  });

  it("stamping status_completed_at creates the row; claiming (post_call_started_at) removes it; deleting the attempt removes it too", async () => {
    const id = await mkAttempt("CAsweep-life-2", { dialedAt: new Date() });

    await admin.query(`UPDATE call_attempts SET status_completed_at = now() WHERE id = $1`, [id]);
    let r = await admin.query(`SELECT business_id, status_completed_at FROM postcall_pending WHERE attempt_id = $1`, [id]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].business_id).toBe(BIZ);

    await admin.query(`UPDATE call_attempts SET post_call_started_at = now() WHERE id = $1`, [id]);
    r = await admin.query(`SELECT * FROM postcall_pending WHERE attempt_id = $1`, [id]);
    expect(r.rows).toHaveLength(0);

    // Re-stamping (a duplicate status callback, or a re-claim attempt) must not
    // resurrect the row once post_call_started_at is set.
    await admin.query(`UPDATE call_attempts SET status_completed_at = now() WHERE id = $1`, [id]);
    r = await admin.query(`SELECT * FROM postcall_pending WHERE attempt_id = $1`, [id]);
    expect(r.rows).toHaveLength(0);

    await admin.query(`DELETE FROM call_attempts WHERE id = $1`, [id]);
  });

  it("deleting an attempt whose row exists removes it from postcall_pending", async () => {
    const id = await mkAttempt("CAsweep-life-3", { dialedAt: new Date(), statusCompletedAt: new Date() });
    let r = await admin.query(`SELECT * FROM postcall_pending WHERE attempt_id = $1`, [id]);
    expect(r.rows).toHaveLength(1);

    await admin.query(`DELETE FROM call_attempts WHERE id = $1`, [id]);
    r = await admin.query(`SELECT * FROM postcall_pending WHERE attempt_id = $1`, [id]);
    expect(r.rows).toHaveLength(0);
  });
});
