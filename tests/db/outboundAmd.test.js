// tests/db/outboundAmd.test.js
/**
 * Task 13 (session 2b), spec §9.4. `stampAttemptAmd` and `outboundAmdContext`
 * (services/db.js) are plain RLS-scoped reads/writes on call_attempts (no
 * SECURITY DEFINER involved) -- the same pattern
 * tests/db/outboundDoorAttempt.test.js already covers for stampAttemptStatus
 * and fetchAttemptVoicemailAudio. A new, separate file rather than extending
 * that one: it is Task 12's own frozen file, and the session rules only
 * authorise extending tests/outboundDispatch.test.js for this task.
 *
 * Run as `vetra_app` inside `db.withTenant`, asserting the row actually
 * lands (plan §0.1: the service runs as vetra_app NOBYPASSRLS, so a
 * tenantless write matches zero rows and reports success unless the test
 * checks).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ = "1a1a0000-0000-4000-8000-000000000001";
const OTHER_BIZ = "1a1a0000-0000-4000-8000-000000000002";

let admin, db, campaignId, contactId, outreachId, attemptId;
const SID = "CAamddbtest00001";

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`).catch(() => {});

  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'AMD DB Co')`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'AMD Other Co')`, [OTHER_BIZ]);

  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',3) RETURNING id`,
    [BIZ]
  );
  campaignId = camp.rows[0].id;
  await admin.query(
    `INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,3,$3::jsonb)`,
    [campaignId, BIZ, JSON.stringify({ retries: { voicemail_on: [1, 5] }, caller_id: "+441372656055" })]
  );
  // O-26/C17 fix round 1: a version NEWER than the one this outreach is
  // pinned to (version 3), with a DIFFERENT caller_id -- current_version
  // moves to 4, but outreach.campaign_version stays 3. Proves
  // outboundAmdContext reads the PINNED version's config, not whatever the
  // campaign's current_version happens to be.
  await admin.query(
    `INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,4,$3::jsonb)`,
    [campaignId, BIZ, JSON.stringify({ retries: { voicemail_on: [1, 5] }, caller_id: "+18176011171" })]
  );
  await admin.query(`UPDATE campaigns SET current_version = 4 WHERE id = $1`, [campaignId]);
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900299') RETURNING id`, [BIZ]);
  contactId = con.rows[0].id;
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key)
     VALUES ($1,$2,3,$3,'dialing','{}','amd-db-1') RETURNING id`,
    [BIZ, campaignId, contactId]
  );
  outreachId = out.rows[0].id;
  const att = await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
     VALUES ($1,$2,1,'+441372656055','+447700900299',$3,now()) RETURNING id`,
    [BIZ, outreachId, SID]
  );
  attemptId = att.rows[0].id;

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]).catch(() => {});
  await admin.end();
});

d("stampAttemptAmd, as vetra_app inside withTenant", () => {
  it("writes answered_by/amd_duration_ms and, when result is currently NULL, the result too", async () => {
    await db.withTenant(BIZ, () =>
      db.stampAttemptAmd(attemptId, { answeredBy: "machine_end_beep", amdDurationMs: 3200, result: "voicemail_left" })
    );
    const row = (await admin.query(`SELECT answered_by, amd_duration_ms, result FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect(row.answered_by).toBe("machine_end_beep");
    expect(row.amd_duration_ms).toBe(3200);
    expect(row.result).toBe("voicemail_left");
  });

  it("never overwrites an existing result, but always overwrites answered_by/amd_duration_ms", async () => {
    await db.withTenant(BIZ, () => db.stampAttemptAmd(attemptId, { answeredBy: "human", amdDurationMs: null, result: "failed" }));
    const row = (await admin.query(`SELECT answered_by, amd_duration_ms, result FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect(row.answered_by).toBe("human"); // overwritten -- every verdict records what Twilio observed
    expect(row.amd_duration_ms).toBeNull(); // overwritten
    expect(row.result).toBe("voicemail_left"); // NOT clobbered by the later "failed"
  });

  it("a result:null call is a safe no-op for the result column (doorRoutes.js's own first write, before it has decided anything)", async () => {
    const before = (await admin.query(`SELECT result FROM call_attempts WHERE id = $1`, [attemptId])).rows[0].result;
    await db.withTenant(BIZ, () => db.stampAttemptAmd(attemptId, { answeredBy: "unknown", amdDurationMs: null, result: null }));
    const after = (await admin.query(`SELECT result, answered_by FROM call_attempts WHERE id = $1`, [attemptId])).rows[0];
    expect(after.result).toBe(before);
    expect(after.answered_by).toBe("unknown");
  });

  it("throws under the wrong tenant scope rather than silently matching zero rows (RLS, not the query, is what protects it)", async () => {
    await expect(
      db.withTenant(OTHER_BIZ, () => db.stampAttemptAmd(attemptId, { answeredBy: "fax", amdDurationMs: null, result: "failed" }))
    ).rejects.toThrow();
  });
});

// Real Hold call 2026-10-01 (defect B): the AMD door ignores a machine verdict
// once the call has had a real exchange -- a caller transcript row AFTER the
// first AI row (the AI's first reply was heard AND the person answered it).
// Rows land per turn from lib/voice/live/index.js persistTurnTranscript:
// caller at sequence n, the heard AI half at n+1.
d("outboundCallHadExchange, as vetra_app inside withTenant", () => {
  let callId;
  async function rows(list) {
    await admin.query(`DELETE FROM calls WHERE twilio_call_sid = $1`, [SID]);
    const c = await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, direction, attempt_id) VALUES ($1,$2,'outbound',$3) RETURNING id`,
      [BIZ, SID, attemptId]
    );
    callId = c.rows[0].id;
    for (const [speaker, message, sequence] of list) {
      await admin.query(`INSERT INTO call_transcripts (call_id, speaker, message, sequence) VALUES ($1,$2,$3,$4)`, [
        callId,
        speaker,
        message,
        sequence,
      ]);
    }
  }

  it("the real Hold call's shape (greeting, intro, 'let me check', 'Sure, thank you') -> true", async () => {
    await rows([
      ["caller", "Reception, this is John. How can I help you?", 0],
      ["ai", "Hi, this is Ava, an AI assistant calling from Digile Media. Could I speak to Nithin, please?", 1],
      ["caller", "Let me go check. One sec.", 2],
      ["ai", "Sure, thank you.", 3],
    ]);
    expect(await db.withTenant(BIZ, () => db.outboundCallHadExchange(SID))).toBe(true);
  });

  it("a greeting and the AI's first reply only (a voicemail box at its beep) -> false", async () => {
    await rows([
      ["caller", "Hi, you've reached John, leave a message.", 0],
      ["ai", "Hi, this is Ava, an AI assistant calling from Digile Media.", 1],
    ]);
    expect(await db.withTenant(BIZ, () => db.outboundCallHadExchange(SID))).toBe(false);
  });

  it("the AI spoke twice with no answer between (intro, then a silence nudge -- a turn with no caller text) -> false", async () => {
    await rows([
      ["caller", "Hi, you've reached John.", 0],
      ["ai", "Hi, this is Ava, an AI assistant calling from Digile Media.", 1],
      ["ai", "Are you still there?", 3],
    ]);
    expect(await db.withTenant(BIZ, () => db.outboundCallHadExchange(SID))).toBe(false);
  });

  it("caller rows only (the AI half never heard, e.g. muted) -> false", async () => {
    await rows([
      ["caller", "Hello?", 0],
      ["caller", "Hello, anyone there?", 2],
    ]);
    expect(await db.withTenant(BIZ, () => db.outboundCallHadExchange(SID))).toBe(false);
  });

  it("no calls row at all (session never opened) -> false", async () => {
    await admin.query(`DELETE FROM calls WHERE twilio_call_sid = $1`, [SID]);
    expect(await db.withTenant(BIZ, () => db.outboundCallHadExchange(SID))).toBe(false);
  });

  it("another tenant's scope sees no exchange (RLS), never another tenant's transcript", async () => {
    await rows([
      ["caller", "Reception?", 0],
      ["ai", "Hi, this is Ava.", 1],
      ["caller", "One sec.", 2],
    ]);
    expect(await db.withTenant(OTHER_BIZ, () => db.outboundCallHadExchange(SID))).toBe(false);
  });

  it("outside a tenant scope it THROWS (the door route treats a throw as 'keep the call up')", async () => {
    await expect(db.outboundCallHadExchange(SID)).rejects.toThrow();
  });
});

d("outboundAmdContext, as vetra_app inside withTenant", () => {
  it("reads attempt_no, compliance_class, voicemail_on and caller_id from the PINNED campaign version", async () => {
    const ctx = await db.withTenant(BIZ, () => db.outboundAmdContext(attemptId));
    expect(ctx).toEqual({ attemptNo: 1, complianceClass: "solicited", voicemailOn: [1, 5], callerId: "+441372656055" });
  });

  // O-26/C17 fix round 1: explicit proof callerId comes from the PINNED
  // version (3), not the campaign's current_version (4, seeded with a
  // DIFFERENT caller_id in beforeAll above).
  it("callerId comes from the PINNED version's config, not the campaign's current_version", async () => {
    const current = (await admin.query(`SELECT current_version FROM campaigns WHERE id = $1`, [campaignId])).rows[0].current_version;
    expect(current).toBe(4); // current_version has moved past this outreach's pinned version
    const ctx = await db.withTenant(BIZ, () => db.outboundAmdContext(attemptId));
    expect(ctx.callerId).toBe("+441372656055"); // version 3's caller_id, never version 4's "+18176011171"
  });

  it("a different tenant's scope cannot read this attempt's context (RLS)", async () => {
    const ctx = await db.withTenant(OTHER_BIZ, () => db.outboundAmdContext(attemptId));
    expect(ctx).toBeNull();
  });
});
