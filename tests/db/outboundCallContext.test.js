// tests/db/outboundCallContext.test.js
/**
 * Task 14 against real Postgres, as vetra_app (NOBYPASSRLS):
 *
 *   - `resolveOutboundContext` (lib/outbound/callContext.js) resolves a CallSid
 *     through Task 12's definer and reads everything else under the tenant
 *     that definer found. The definer is re-owned to a NOBYPASSRLS role for the
 *     run (the phoneDirectoryBootstrap / outboundDoorAttempt idiom): with the
 *     local superuser as owner, a broken function stays green.
 *   - the business config built on the OUTBOUND path deep-equals the one built
 *     on the INBOUND path (lookupBusinessByPhone -> loadConfig) for the same
 *     business -- state.config stays the business config.
 *   - `outboundCallContext` is tenant-scoped: another tenant's scope sees
 *     nothing, and it refuses to run unscoped.
 *   - `createCall`'s optional 5th argument lands the outbound row with its
 *     link columns, and the four-argument call still lands an inbound row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "callctx_owner";
const FN = "app_outbound_attempt_by_call_sid(text)";

const BIZ = "0f0f1400-0000-4000-8000-000000000001";
const OTHER_BIZ = "0f0f1400-0000-4000-8000-000000000002";
const BIZ_PHONE = "+441372600014";
const CONTACT_PHONE = "+447700900314";
const SID = "CAcallctx0001";

const CAMPAIGN_CONFIG = {
  persona_name: "Ava",
  caller_id: BIZ_PHONE,
  opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
  topic: "your enquiry",
  objective: "Qualify.",
  capabilities: ["qualification"],
  retries: { schedule: ["+0m"], voicemail_on: [1] },
};

let admin, db, resolveOutboundContext, campaignId, contactId, outreachId, attemptId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  await admin.query(`ALTER FUNCTION ${FN} OWNER TO vetra`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'probe_only' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${OWNER}`);
  await admin.query(`ALTER FUNCTION ${FN} OWNER TO ${OWNER}`);
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM calls WHERE twilio_call_sid = ANY($1::text[])`, [[SID, "CAcallctx-inbound"]]);
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, timezone, live_voice, allowed_tasks)
     VALUES ($1, 'Call Context Co', $2, 'Europe/London', 'Aoede', '["general_question","take_message","book_appointment","check_appointment","cancel_reschedule"]'::jsonb)`,
    [BIZ, BIZ_PHONE]
  );
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Someone Else Co')`, [OTHER_BIZ]);
  await admin.query(
    `INSERT INTO business_capabilities (business_id, capability_id, enabled, config) VALUES
       ($1, 'messages', true, '{}'::jsonb),
       ($1, 'appointments', false, '{}'::jsonb)`,
    [BIZ]
  );

  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',2) RETURNING id`,
    [BIZ]
  );
  campaignId = camp.rows[0].id;
  await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,2,$3)`, [
    campaignId,
    BIZ,
    JSON.stringify(CAMPAIGN_CONFIG),
  ]);
  const con = await admin.query(
    `INSERT INTO contacts (business_id, phone_e164, first_name, timezone) VALUES ($1,$2,'Sam','Europe/London') RETURNING id`,
    [BIZ, CONTACT_PHONE]
  );
  contactId = con.rows[0].id;
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key)
     VALUES ($1,$2,2,$3,'dialing',$4,'callctx-1') RETURNING id`,
    [BIZ, campaignId, contactId, JSON.stringify({ source: "webhook", data: { enquiry: "Clinic software" } })]
  );
  outreachId = out.rows[0].id;
  const att = await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at,opener_audio)
     VALUES ($1,$2,1,$3,$4,$5,now(),'\\x01020304'::bytea) RETURNING id`,
    [BIZ, outreachId, BIZ_PHONE, CONTACT_PHONE, SID]
  );
  attemptId = att.rows[0].id;

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
  ({ resolveOutboundContext } = await import("../../lib/outbound/callContext.js"));
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
  await admin.query(`DELETE FROM calls WHERE twilio_call_sid = ANY($1::text[])`, [[SID, "CAcallctx-inbound"]]).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]).catch(() => {});
  await admin.end();
});

d("resolveOutboundContext, as vetra_app", () => {
  it("the definer is owned by a role that cannot bypass RLS -- otherwise nothing here proves anything", async () => {
    const r = await admin.query(
      `SELECT r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'app_outbound_attempt_by_call_sid'`
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("resolves the CallSid to the attempt, contact, pinned version, trigger and clip, under the right tenant", async () => {
    const ctx = await resolveOutboundContext(SID, { db });
    expect(ctx).toMatchObject({
      businessId: BIZ,
      attemptId,
      outreachId,
      campaignId,
      campaignVersion: 2,
      contactId,
      attemptNo: 1,
      config: CAMPAIGN_CONFIG,
      campaign: { templateKey: "speed_to_lead", complianceClass: "solicited", audience: "business" },
      contact: { firstName: "Sam", timezone: "Europe/London", phone: CONTACT_PHONE },
      triggerSummary: "source: webhook; enquiry: Clinic software",
      openerText: "Hi, is that Sam? It's Ava, an AI assistant from Call Context Co.",
    });
    expect(Buffer.isBuffer(ctx.openerAudio)).toBe(true);
    expect([...ctx.openerAudio]).toEqual([1, 2, 3, 4]);
    expect(ctx.business.id).toBe(BIZ);
    expect(ctx.business.business_capabilities.map((r) => r.capability_id).sort()).toEqual(["appointments", "messages"]);
  });

  it("an unknown CallSid gives null", async () => {
    expect(await resolveOutboundContext("CAcallctx-nobody", { db })).toBeNull();
  });

  it("the outbound business config deep-equals the inbound one for the same business", async () => {
    const ctx = await resolveOutboundContext(SID, { db });
    const inboundRow = await db.lookupBusinessByPhone(BIZ_PHONE);
    expect(inboundRow?.id).toBe(BIZ);
    const outboundConfig = db.loadConfig(ctx.business);
    expect(outboundConfig).toEqual(db.loadConfig(inboundRow));
    // And it is a real config, not two empty defaults agreeing.
    expect(outboundConfig.businessName).toBe("Call Context Co");
    expect(outboundConfig.liveVoice).toBe("Aoede");
    expect(outboundConfig.capabilities).toHaveProperty("messages");
    expect(outboundConfig.allowedTasks).not.toContain("book_appointment");
  });
});

d("outboundCallContext, tenant-scoped", () => {
  it("another tenant's scope sees nothing", async () => {
    const r = await db.withTenant(OTHER_BIZ, () => db.outboundCallContext(attemptId));
    expect(r).toBeNull();
  });

  it("refuses to run outside withTenant (an unscoped read under FORCE RLS would read as 'no such call')", async () => {
    await expect(db.outboundCallContext(attemptId)).rejects.toThrow(/withTenant/);
  });
});

d("createCall's outbound link", () => {
  it("the 5-argument call lands direction='outbound' and the link columns", async () => {
    const id = await db.withTenant(BIZ, () =>
      db.createCall(BIZ, SID, CONTACT_PHONE, BIZ_PHONE, {
        direction: "outbound",
        campaignId,
        campaignVersion: 2,
        outreachId,
        attemptId,
        contactId,
      })
    );
    expect(id).toBeTruthy();
    const row = (await admin.query(`SELECT * FROM calls WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({
      business_id: BIZ,
      twilio_call_sid: SID,
      caller_number: CONTACT_PHONE,
      twilio_number: BIZ_PHONE,
      direction: "outbound",
      campaign_id: campaignId,
      campaign_version: 2,
      outreach_id: outreachId,
      attempt_id: attemptId,
      contact_id: contactId,
    });
  });

  it("the 4-argument call still lands an inbound row with no links", async () => {
    const id = await db.withTenant(BIZ, () => db.createCall(BIZ, "CAcallctx-inbound", "+447700900999", BIZ_PHONE));
    const row = (await admin.query(`SELECT * FROM calls WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ direction: "inbound", campaign_id: null, outreach_id: null, attempt_id: null, contact_id: null });
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (I4): clips are stored one at a time, the moment each is ready,
// and a session that found none at stream start re-reads the opener once.
// ---------------------------------------------------------------------------
d("storeAttemptAudio writes only what it is given; fetchAttemptOpenerAudio", () => {
  it("the opener first, then the voicemail alone: the second write does not null the first", async () => {
    await admin.query(`UPDATE call_attempts SET opener_audio = NULL, voicemail_audio = NULL WHERE id = $1`, [attemptId]);
    await db.withTenant(BIZ, () => db.storeAttemptAudio(attemptId, { opener: Buffer.from([7, 7]) }));
    let row = (await admin.query(`SELECT opener_audio, voicemail_audio FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect([...row.opener_audio]).toEqual([7, 7]);
    expect(row.voicemail_audio).toBeNull();

    await db.withTenant(BIZ, () => db.storeAttemptAudio(attemptId, { voicemail: Buffer.from([9]) }));
    row = (await admin.query(`SELECT opener_audio, voicemail_audio FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect([...row.opener_audio]).toEqual([7, 7]);
    expect([...row.voicemail_audio]).toEqual([9]);
  });

  it("the session's late re-read sees the stored opener, under the tenant scope only", async () => {
    const got = await db.withTenant(BIZ, () => db.fetchAttemptOpenerAudio(attemptId));
    expect([...got]).toEqual([7, 7]);
    expect(await db.withTenant(OTHER_BIZ, () => db.fetchAttemptOpenerAudio(attemptId))).toBeNull();
    await expect(db.fetchAttemptOpenerAudio(attemptId)).rejects.toThrow(/withTenant/);
  });

  // S3-4 (D6, migration 046): transfer_miss_audio, a third independent
  // column -- writing it must not touch opener_audio/voicemail_audio, the
  // SAME "writes only what it is given" property the opener/voicemail pair
  // already proves above.
  it("S3-4: transfer_miss is stored independently of opener/voicemail, and fetchAttemptTransferMissAudio reads it back tenant-scoped", async () => {
    await db.withTenant(BIZ, () => db.storeAttemptAudio(attemptId, { transfer_miss: Buffer.from([3, 1, 4]) }));
    const row = (await admin.query(`SELECT opener_audio, voicemail_audio, transfer_miss_audio FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect([...row.opener_audio]).toEqual([7, 7]); // unchanged by the transfer_miss write
    expect([...row.voicemail_audio]).toEqual([9]); // unchanged by the transfer_miss write
    expect([...row.transfer_miss_audio]).toEqual([3, 1, 4]);

    const got = await db.withTenant(BIZ, () => db.fetchAttemptTransferMissAudio(attemptId));
    expect([...got]).toEqual([3, 1, 4]);
    expect(await db.withTenant(OTHER_BIZ, () => db.fetchAttemptTransferMissAudio(attemptId))).toBeNull();
    await expect(db.fetchAttemptTransferMissAudio(attemptId)).rejects.toThrow(/withTenant/);
  });

  it("the post-call guard still refuses: once post-call started, nothing is written back", async () => {
    await admin.query(`UPDATE call_attempts SET post_call_started_at = now(), opener_audio = NULL WHERE id = $1`, [attemptId]);
    try {
      await expect(db.withTenant(BIZ, () => db.storeAttemptAudio(attemptId, { opener: Buffer.from([1]) }))).rejects.toThrow(/expected 1 row/);
      const row = (await admin.query(`SELECT opener_audio FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
      expect(row.opener_audio).toBeNull();
    } finally {
      await admin.query(`UPDATE call_attempts SET post_call_started_at = NULL WHERE id = $1`, [attemptId]);
    }
  });

  it("another tenant's scope writes nothing (a tenantless write matches zero rows and must not pass)", async () => {
    await expect(db.withTenant(OTHER_BIZ, () => db.storeAttemptAudio(attemptId, { opener: Buffer.from([2]) }))).rejects.toThrow(/expected 1 row/);
  });
});
