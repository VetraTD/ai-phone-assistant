// tests/db/outboundDoorAttempt.test.js
/**
 * Ruling P-0 (Task 12, session 2b). services/db.js's `outboundAttemptByCallSid`
 * is the wrapper the three outbound door routes (answer, status, signed
 * media) all resolve their tenant through -- BEFORE the tenant is known. It
 * reads app_outbound_attempt_by_call_sid (migration 044), a SECURITY DEFINER
 * function. FORCE RLS binds a definer's OWNER too (033/044's rule), so this
 * only proves anything when the function is owned by a role that cannot
 * bypass RLS, the same as Cloud SQL's `postgres` -- the
 * phoneDirectoryBootstrap.test.js / outboundDirectories.test.js idiom.
 *
 * stampAttemptStatus and fetchAttemptVoicemailAudio are plain RLS-scoped
 * reads/writes (no SECURITY DEFINER involved) -- covered here too, run as
 * vetra_app inside db.withTenant, asserting the row actually landed
 * (services/db.js's own rule for every tenant-scoped write).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "doorattempt_owner";
const FN = "app_outbound_attempt_by_call_sid(text)";

const BIZ = "0f0f0000-0000-4000-8000-000000000001";
const OTHER_BIZ = "0f0f0000-0000-4000-8000-000000000002";

let admin, db, campaignId, contactId, outreachId, attemptId;
const SID = "CAdoorattempt0001";

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  // Ruling 2a-3a: a crashed prior run can leave the function owned by
  // doorattempt_owner. Re-own to vetra FIRST, or DROP OWNED BY tries to drop
  // the definer itself and the real cause hides behind "role already exists".
  await admin.query(`ALTER FUNCTION ${FN} OWNER TO vetra`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'probe_only' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${OWNER}`);
  await admin.query(`ALTER FUNCTION ${FN} OWNER TO ${OWNER}`);
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Door Attempt Co')`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Someone Else Co')`, [OTHER_BIZ]);

  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',5) RETURNING id`,
    [BIZ]
  );
  campaignId = camp.rows[0].id;
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900199') RETURNING id`, [BIZ]);
  contactId = con.rows[0].id;
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key)
     VALUES ($1,$2,5,$3,'dialing','{}','door-attempt-1') RETURNING id`,
    [BIZ, campaignId, contactId]
  );
  outreachId = out.rows[0].id;
  const att = await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
     VALUES ($1,$2,1,'+441372656055','+447700900199',$3,now()) RETURNING id`,
    [BIZ, outreachId, SID]
  );
  attemptId = att.rows[0].id;

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER FUNCTION ${FN} OWNER TO vetra`).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]).catch(() => {});
  await admin.end();
});

d("outboundAttemptByCallSid", () => {
  it("the definer is owned by a role that cannot bypass RLS, like Cloud SQL's postgres -- otherwise nothing here proves anything", async () => {
    const r = await admin.query(
      `SELECT r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'app_outbound_attempt_by_call_sid'`
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("a hit returns the right tenant's attempt, read as vetra_app under RLS", async () => {
    const r = await db.outboundAttemptByCallSid(SID);
    expect(r).toEqual({
      businessId: BIZ,
      attemptId,
      outreachId,
      campaignId,
      campaignVersion: 5,
    });
  });

  it("an unknown SID gives null", async () => {
    expect(await db.outboundAttemptByCallSid("CAdoesnotexist")).toBeNull();
  });

  it("an empty or null SID gives null rather than throwing", async () => {
    expect(await db.outboundAttemptByCallSid("")).toBeNull();
    expect(await db.outboundAttemptByCallSid(null)).toBeNull();
  });

  it("the application role cannot read call_attempt_directory directly -- it cannot enumerate", async () => {
    const probe = new pg.Client({ connectionString: APP_URL });
    await probe.connect();
    try {
      await expect(probe.query(`SELECT 1 FROM call_attempt_directory LIMIT 1`)).rejects.toThrow(/permission denied/i);
    } finally {
      await probe.end();
    }
  });
});

d("stampAttemptStatus and fetchAttemptVoicemailAudio, as vetra_app inside withTenant", () => {
  it("stamps twilio_status/answered_at and the row actually lands", async () => {
    await db.withTenant(BIZ, () => db.stampAttemptStatus(attemptId, { twilioStatus: "in-progress", answered: true, terminal: false, result: null }));
    const row = (await admin.query(`SELECT twilio_status, answered_at, result FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect(row.twilio_status).toBe("in-progress");
    expect(row.answered_at).not.toBeNull();
    expect(row.result).toBeNull();
  });

  it("never overwrites an existing result, and a duplicate terminal stamp does not move ended_at again", async () => {
    await db.withTenant(BIZ, () => db.stampAttemptStatus(attemptId, { twilioStatus: "completed", answered: false, terminal: true, result: null }));
    const first = (await admin.query(`SELECT ended_at, status_completed_at, result FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect(first.ended_at).not.toBeNull();
    expect(first.result).toBeNull();

    // A stray result arriving after a real one must not clobber it.
    await admin.query(`UPDATE call_attempts SET result = 'connected' WHERE id = $1`, [attemptId]);
    await db.withTenant(BIZ, () => db.stampAttemptStatus(attemptId, { twilioStatus: "completed", answered: false, terminal: true, result: "failed" }));
    const second = (await admin.query(`SELECT ended_at, status_completed_at, result FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect(second.result).toBe("connected"); // NOT overwritten by the duplicate's "failed"
    expect(second.ended_at.getTime()).toBe(first.ended_at.getTime()); // not moved
    expect(second.status_completed_at.getTime()).toBe(first.status_completed_at.getTime());
  });

  it("stores and reads back the voicemail clip, scoped to the right tenant", async () => {
    const clip = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    await admin.query(`UPDATE call_attempts SET voicemail_audio = $2 WHERE id = $1`, [attemptId, clip]);
    const read = await db.withTenant(BIZ, () => db.fetchAttemptVoicemailAudio(attemptId));
    expect(Buffer.compare(read, clip)).toBe(0);
  });

  it("a different tenant's scope cannot read this attempt's audio (RLS, not the query, is what protects it)", async () => {
    await expect(db.withTenant(OTHER_BIZ, () => db.fetchAttemptVoicemailAudio(attemptId))).resolves.toBeNull();
  });
});
