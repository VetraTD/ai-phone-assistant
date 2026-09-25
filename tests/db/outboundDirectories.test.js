import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "outdir_owner";
const BIZ = "0d0d0000-0000-4000-8000-000000000001";
const BIZ2 = "0d0d0000-0000-4000-8000-000000000002"; // F3's second tenant
const FNS = [
  "app_outbound_attempt_by_call_sid(text)",
  "app_outbound_due(integer, integer)",
  "app_active_dial_counts(uuid)",
  "app_sync_outbound_directories()",
  "app_sync_outreach_schedule()",
];
let admin, app, outreachId, dueId, futureId, closedId, campaignId, contactId;

// Module scope (not beforeAll-local) so the "stays true" block can mint its
// own outreach rows with campaignId/contactId already set by beforeAll.
async function mk(key, state, next) {
  return (await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key,next_attempt_at)
     VALUES ($1,$2,3,$3,$4,'{}',$5,$6) RETURNING id`, [BIZ, campaignId, contactId, state, key, next])).rows[0].id;
}

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

  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, BIZ2]]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Dir')`, [BIZ]);
  const camp = await admin.query(`INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
                                   VALUES ($1,'c','speed_to_lead','solicited','business','active',3) RETURNING id`, [BIZ]);
  campaignId = camp.rows[0].id;
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900111') RETURNING id`, [BIZ]);
  contactId = con.rows[0].id;
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
  try { return await fn(app); } finally { await app.query("ROLLBACK"); }
}

/** This business's live dial count, as vetra_app sees it through the definer (F3: one row, always). */
async function businessActive(biz) {
  const r = await appTx((c) => c.query(`SELECT business_active FROM app_active_dial_counts($1)`, [biz]));
  expect(r.rows).toHaveLength(1);
  return r.rows[0].business_active;
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

  // IMPORTANT 1: the "never repoint" rule (033's rule, reused here) was only
  // backed by reading the code -- nothing exercised a transaction already
  // scoped to a DIFFERENT tenant asking for this tenant's CallSid.
  it("never repoints a transaction already scoped to a different tenant", async () => {
    const OTHER = "0d0d0000-0000-4000-8000-000000000099";
    const r = await appTx(async (c) => {
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [OTHER]);
      const row = (await c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir0001')`)).rows;
      const scope = (await c.query(`SELECT current_setting('app.business_id', true) AS s`)).rows[0].s;
      return { row, scope };
    });
    expect(r.row).toEqual([]);
    expect(r.scope).toBe(OTHER);
  });

  it("returns nothing for an unknown CallSid, and does not touch an unset scope", async () => {
    const r = await appTx(async (c) => {
      const row = (await c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAnope')`)).rows;
      const scope = (await c.query(`SELECT current_setting('app.business_id', true) AS s`)).rows[0].s;
      return { row, scope };
    });
    expect(r.row).toEqual([]);
    expect(r.scope || "").toBe("");
  });

  // MINOR 2: every other write here goes through the superuser admin client,
  // which never exercises the trigger under RLS as the actual application
  // role. Production's writer is vetra_app.
  it("a vetra_app write, not just admin's, fires the directory sync trigger", async () => {
    const r = await appTx(async (c) => {
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ]);
      await c.query(`UPDATE call_attempts SET twilio_call_sid = 'CAdir-renamed' WHERE twilio_call_sid = 'CAdir0001'`);
      const renamed = (await c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir-renamed')`)).rows;
      const old = (await c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir0001')`)).rows;
      return { renamed, old };
    });
    expect(r.renamed).toHaveLength(1);
    expect(r.old).toEqual([]);
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
    expect(await businessActive(BIZ)).toBe(1); // CAdir0001 from above
    await admin.query(`UPDATE call_attempts SET ended_at = now(), result = 'connected' WHERE twilio_call_sid = 'CAdir0001'`);
    expect(await businessActive(BIZ)).toBe(0);
  });

  it("ignores an attempt older than an hour that never ended (a lost status callback cannot block capacity forever)", async () => {
    await admin.query(`INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
                       VALUES ($1,$2,2,'+441372656055','+447700900111','CAdir-stale', now() - interval '2 hours')`, [BIZ, outreachId]);
    expect(await businessActive(BIZ)).toBe(0);
  });
});

// MINOR 3: mirrors phoneDirectoryBootstrap.test.js:147-192's "stays true"
// block. Own outreach/attempt rows and keys throughout, so nothing here
// shifts outreachId/dueId/futureId/closedId or CAdir0001/CAdir-stale's state
// for the describes above.
d("the directories stay true to call_attempts / outreach", () => {
  it("an attempt inserted with no CallSid, then given one by UPDATE, resolves (production's write order)", async () => {
    const oid = await mk("dir-sync-new", "dialing", null);
    const attemptId = (await admin.query(
      `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,dialed_at)
       VALUES ($1,$2,1,'+441372656055','+447700900111',now()) RETURNING id`, [BIZ, oid])).rows[0].id;

    // insertCallAttempt happens before Twilio ever hands back a CallSid --
    // nothing should be resolvable yet.
    expect((await appTx((c) => c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir-sync-new')`))).rows).toEqual([]);

    await admin.query(`UPDATE call_attempts SET twilio_call_sid = 'CAdir-sync-new' WHERE id = $1`, [attemptId]);
    const r = await appTx((c) => c.query(`SELECT attempt_id FROM app_outbound_attempt_by_call_sid('CAdir-sync-new')`));
    expect(r.rows).toEqual([{ attempt_id: attemptId }]);

    await admin.query(`DELETE FROM call_attempts WHERE id = $1`, [attemptId]);
    await admin.query(`DELETE FROM outreach WHERE id = $1`, [oid]);
  });

  it("deleting an attempt removes it from resolution and from the active dial count", async () => {
    const oid = await mk("dir-sync-del", "dialing", null);
    const attemptId = (await admin.query(
      `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
       VALUES ($1,$2,1,'+441372656055','+447700900111','CAdir-sync-del',now()) RETURNING id`, [BIZ, oid])).rows[0].id;

    expect(await businessActive(BIZ)).toBe(1);
    expect((await appTx((c) => c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir-sync-del')`))).rows).toHaveLength(1);

    await admin.query(`DELETE FROM call_attempts WHERE id = $1`, [attemptId]);

    expect((await appTx((c) => c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir-sync-del')`))).rows).toEqual([]);
    expect(await businessActive(BIZ)).toBe(0);

    await admin.query(`DELETE FROM outreach WHERE id = $1`, [oid]);
  });

  it("closing an outreach removes it from the due list", async () => {
    const oid = await mk("dir-sync-closed", "waiting", new Date(Date.now() - 10 * 60_000));
    const before = await appTx((c) => c.query(`SELECT outreach_id FROM app_outbound_due(100, 0)`));
    expect(before.rows.map((x) => x.outreach_id)).toContain(oid);

    await admin.query(`UPDATE outreach SET state = 'closed' WHERE id = $1`, [oid]);
    const after = await appTx((c) => c.query(`SELECT outreach_id FROM app_outbound_due(100, 0)`));
    expect(after.rows.map((x) => x.outreach_id)).not.toContain(oid);

    await admin.query(`DELETE FROM outreach WHERE id = $1`, [oid]);
  });
});

// F3 (Checkpoint 2a, owner-approved). The zero-arg function returned one row
// per tenant with a live dial -- every such tenant's business_id -- to ANY
// vetra_app caller. The capacity check needs two numbers, not that list.
d("app_active_dial_counts(p_business) is tenant-private (F3)", () => {
  it("returns exactly [global_active, business_active] -- one row, no business_id column", async () => {
    const r = await appTx((c) => c.query(`SELECT * FROM app_active_dial_counts($1)`, [BIZ]));
    expect(r.fields.map((f) => f.name)).toEqual(["global_active", "business_active"]);
    expect(r.rows).toHaveLength(1);
  });

  it("the zero-arg overload is gone: the only signature takes the business", async () => {
    const r = await admin.query(
      `SELECT pg_get_function_identity_arguments(oid) AS args FROM pg_proc WHERE proname = 'app_active_dial_counts'`);
    expect(r.rows).toEqual([{ args: "p_business uuid" }]);
  });

  it("counts right for two tenants: each sees its own number and the same global total", async () => {
    await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Dir2')`, [BIZ2]);
    const camp2 = (await admin.query(`INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
                                       VALUES ($1,'c2','speed_to_lead','solicited','business','active',1) RETURNING id`, [BIZ2])).rows[0].id;
    const con2 = (await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900222') RETURNING id`, [BIZ2])).rows[0].id;
    const o2 = (await admin.query(`INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key)
                                    VALUES ($1,$2,1,$3,'dialing','{}','dir2-1') RETURNING id`, [BIZ2, camp2, con2])).rows[0].id;
    const o1 = await mk("dir-f3", "dialing", null);
    const live = (biz, outreach, n) => admin.query(
      `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,dialed_at) VALUES ($1,$2,$3,'+441372656055','+447700900000',now())`,
      [biz, outreach, n]);
    await live(BIZ, o1, 1);        // BIZ: one live dial (CAdir0001 ended, CAdir-stale is 2 h old)
    await live(BIZ2, o2, 1);       // BIZ2: two
    await live(BIZ2, o2, 2);

    const a = (await appTx((c) => c.query(`SELECT * FROM app_active_dial_counts($1)`, [BIZ]))).rows[0];
    const b = (await appTx((c) => c.query(`SELECT * FROM app_active_dial_counts($1)`, [BIZ2]))).rows[0];
    const truth = (await admin.query(`SELECT count(*)::int AS n FROM dial_registry WHERE dialed_at > now() - interval '1 hour'`)).rows[0].n;

    expect(a.business_active).toBe(1);
    expect(b.business_active).toBe(2);
    expect(a.global_active).toBe(truth);
    expect(b.global_active).toBe(truth);
    expect(truth).toBeGreaterThanOrEqual(3);

    await admin.query(`DELETE FROM outreach WHERE id = $1`, [o1]);
  });

  it("an unknown business sees zero for itself and still the global total", async () => {
    const r = (await appTx((c) => c.query(`SELECT * FROM app_active_dial_counts($1)`, ["0d0d0000-0000-4000-8000-0000000000ff"]))).rows[0];
    const truth = (await admin.query(`SELECT count(*)::int AS n FROM dial_registry WHERE dialed_at > now() - interval '1 hour'`)).rows[0].n;
    expect(r).toEqual({ global_active: truth, business_active: 0 });
  });

  it.each(["call_attempt_directory", "dial_registry", "outreach_schedule"])(
    "%s carries a routing-only COMMENT (the 033/039 idiom)", async (t) => {
      const r = await admin.query(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [`public.${t}`]);
      expect(r.rows[0].c).toMatch(/^Routing only:/);
      expect(r.rows[0].c).toMatch(/never carry a phone number or a name/);
    });
});
