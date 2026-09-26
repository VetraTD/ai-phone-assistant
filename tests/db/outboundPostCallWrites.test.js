// tests/db/outboundPostCallWrites.test.js
/**
 * Task 20 fix round 1, item 8: real-DB coverage (as vetra_app, under RLS) for
 * every post-call write services/db.js added: finalizeAttemptResult,
 * finishAttemptSession, setAttemptSilent, setOutreachHold,
 * insertDetectorSuppression and applyOutreachResult -- including the
 * no-double-reschedule guard, on REAL SQL, not the fake-db unit tests
 * (tests/outboundPostCall.test.js).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ = "0d0d0000-0000-4000-8000-000000000005";
let admin, db, campaignId, contactId, outreachId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  // No SECURITY DEFINER function involved -- every write under test is a
  // plain RLS-scoped table write. vetra_app is NOLOGIN between test files
  // (each one's own afterAll restores that); this file needs the LOGIN
  // grant the same way tests/db/outboundPostCallClaim.test.js does.
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Writes Co')`, [BIZ]);
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',1) RETURNING id`,
    [BIZ]
  );
  campaignId = camp.rows[0].id;
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900311') RETURNING id`, [BIZ]);
  contactId = con.rows[0].id;
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,attempts_made,trigger,idempotency_key)
     VALUES ($1,$2,1,$3,'dialing',1,'{}','writes-1') RETURNING id`,
    [BIZ, campaignId, contactId]
  );
  outreachId = out.rows[0].id;

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin.end();
});

/** A fresh call_attempts row under the shared outreach; attempt_no auto-increments so callers never collide. */
async function mkAttempt(sid, overrides = {}) {
  const { openerAudio = null, voicemailAudio = null, result = null } = overrides;
  const att = await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at,opener_audio,voicemail_audio,result)
     VALUES ($1,$2,(SELECT COALESCE(MAX(attempt_no),0)+1 FROM call_attempts WHERE outreach_id=$2),'+441372656055','+447700900311',$3,now(),$4,$5,$6) RETURNING id`,
    [BIZ, outreachId, sid, openerAudio, voicemailAudio, result]
  );
  return att.rows[0].id;
}

d("finalizeAttemptResult: COALESCE-protected, clears the audio clips", () => {
  it("sets result and ended_at when unset, and clears opener/voicemail audio", async () => {
    const id = await mkAttempt("CAwrite-final-1", { openerAudio: Buffer.from([1, 2, 3]), voicemailAudio: Buffer.from([4, 5]) });
    await db.withTenant(BIZ, () => db.finalizeAttemptResult(id, "connected"));
    const row = (await admin.query(`SELECT result, ended_at, opener_audio, voicemail_audio FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(row.result).toBe("connected");
    expect(row.ended_at).not.toBeNull();
    expect(row.opener_audio).toBeNull();
    expect(row.voicemail_audio).toBeNull();
  });

  it("never clobbers an already-set result (AMD or the door landed first) -- idempotent on a retry", async () => {
    const id = await mkAttempt("CAwrite-final-2", { result: "voicemail_left" });
    await db.withTenant(BIZ, () => db.finalizeAttemptResult(id, "connected"));
    const row = (await admin.query(`SELECT result FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(row.result).toBe("voicemail_left");

    // A retry (e.g. after a released post-call claim) is a safe no-op.
    await db.withTenant(BIZ, () => db.finalizeAttemptResult(id, "connected"));
    const again = (await admin.query(`SELECT result FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(again.result).toBe("voicemail_left");
  });
});

d("finishAttemptSession: the controller's own half of post-call", () => {
  it("stamps session_finished_at, first_audio_ms and the session's silent verdict", async () => {
    const id = await mkAttempt("CAwrite-session-1");
    await db.withTenant(BIZ, () => db.finishAttemptSession(id, { firstAudioMs: 1234, silent: true }));
    const row = (await admin.query(`SELECT session_finished_at, first_audio_ms, silent FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(row.session_finished_at).not.toBeNull();
    expect(row.first_audio_ms).toBe(1234);
    expect(row.silent).toBe(true);
  });
});

// I6 (fix wave, checkpoint 2b, = b37): the Live session's own answered_at
// stamp, written when it resolves the outbound context -- a second writer
// for the SAME column stampAttemptStatus (the door) writes from Twilio's own
// "in-progress" callback, for when that callback is lost or arrives late.
d("stampAttemptAnswered: I6's session-side answered stamp (COALESCE-protected)", () => {
  it("sets answered_at when it is still unset", async () => {
    const id = await mkAttempt("CAwrite-answered-1");
    await db.withTenant(BIZ, () => db.stampAttemptAnswered(id));
    const row = (await admin.query(`SELECT answered_at FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(row.answered_at).not.toBeNull();
  });

  it("never moves an already-set answered_at -- idempotent against the door's own stamp, or a retried onStart", async () => {
    const id = await mkAttempt("CAwrite-answered-2");
    await admin.query(`UPDATE call_attempts SET answered_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [id]);
    await db.withTenant(BIZ, () => db.stampAttemptAnswered(id));
    const row = (await admin.query(`SELECT answered_at FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(row.answered_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

d("setAttemptSilent / setOutreachHold: the final silent verdict (spec §13.4)", () => {
  it("setAttemptSilent overwrites whatever the controller left, to the final verdict", async () => {
    const id = await mkAttempt("CAwrite-silent-1");
    await db.withTenant(BIZ, () => db.finishAttemptSession(id, { firstAudioMs: 999, silent: true }));
    await db.withTenant(BIZ, () => db.setAttemptSilent(id, false)); // post-call's machine-exclusion correction
    const row = (await admin.query(`SELECT silent FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(row.silent).toBe(false);
  });

  it("setOutreachHold sets outreach.hold_until", async () => {
    const holdUntil = new Date(Date.now() + 72 * 3600 * 1000);
    await db.withTenant(BIZ, () => db.setOutreachHold(outreachId, holdUntil));
    const row = (await admin.query(`SELECT hold_until FROM outreach WHERE id = $1`, [outreachId])).rows[0];
    expect(row.hold_until.getTime()).toBe(holdUntil.getTime());
    // Un-hold for the tests below.
    await admin.query(`UPDATE outreach SET hold_until = NULL WHERE id = $1`, [outreachId]);
  });
});

d("insertDetectorSuppression: ON CONFLICT DO NOTHING, tenant-scoped", () => {
  const phone = "+447700900399";

  it("inserts a suppression the detector found, and the row actually landed", async () => {
    const inserted = await db.withTenant(BIZ, () => db.insertDetectorSuppression({ phone, sourceCallId: null }));
    expect(inserted).toBe(true);
    const row = (await admin.query(`SELECT reason, created_by FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`, [BIZ, phone])).rows[0];
    expect(row).toEqual({ reason: "opted_out", created_by: "detector" });
  });

  it("a second insert for the SAME phone is a safe no-op -- never a duplicate, never a throw", async () => {
    const inserted = await db.withTenant(BIZ, () => db.insertDetectorSuppression({ phone, sourceCallId: null }));
    expect(inserted).toBe(false);
    const rows = (await admin.query(`SELECT id FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`, [BIZ, phone])).rows;
    expect(rows).toHaveLength(1);
  });
});

d("applyOutreachResult: the state machine + the no-double-reschedule guard, on real SQL", () => {
  it("terminal: closes the outreach with the reason and outcome", async () => {
    const out = (
      await admin.query(
        `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,attempts_made,trigger,idempotency_key)
         VALUES ($1,$2,1,$3,'dialing',2,'{}','writes-terminal') RETURNING id`,
        [BIZ, campaignId, contactId]
      )
    ).rows[0].id;

    const applied = await db.withTenant(BIZ, () =>
      db.applyOutreachResult(out, 2, { terminal: true, closeReason: "terminal_outcome", outcome: "booked", nextAttemptAt: null })
    );
    expect(applied).toBe(true);
    const row = (await admin.query(`SELECT state, close_reason, outcome, closed_at, next_attempt_at FROM outreach WHERE id = $1`, [out])).rows[0];
    expect(row.state).toBe("closed");
    expect(row.close_reason).toBe("terminal_outcome");
    expect(row.outcome).toBe("booked");
    expect(row.closed_at).not.toBeNull();
    expect(row.next_attempt_at).toBeNull();
  });

  it("non-terminal: reschedules (state stays waiting, next_attempt_at set)", async () => {
    const out = (
      await admin.query(
        `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,attempts_made,trigger,idempotency_key)
         VALUES ($1,$2,1,$3,'dialing',1,'{}','writes-reschedule') RETURNING id`,
        [BIZ, campaignId, contactId]
      )
    ).rows[0].id;
    const next = new Date(Date.now() + 10 * 60_000);

    const applied = await db.withTenant(BIZ, () => db.applyOutreachResult(out, 1, { terminal: false, nextAttemptAt: next }));
    expect(applied).toBe(true);
    const row = (await admin.query(`SELECT state, next_attempt_at FROM outreach WHERE id = $1`, [out])).rows[0];
    expect(row.state).toBe("waiting");
    expect(row.next_attempt_at.getTime()).toBe(next.getTime());
  });

  // The explicit scenario (fix round 1, item 8): a dispatch-failed attempt
  // whose OWN failAndReschedule already rescheduled the outreach (state
  // back to 'waiting', a real next_attempt_at) BEFORE a late/duplicate
  // status callback for the SAME attempt reaches post-call. Post-call's own
  // step 5 must NOT reschedule a second time.
  it("no-double-reschedule: an attempt dispatch already failed-and-rescheduled is not rescheduled again by a later status callback's own post-call run", async () => {
    const dispatchRescheduledAt = new Date(Date.now() + 3 * 3600 * 1000); // dispatch's OWN reschedule (e.g. "+3h")
    const out = (
      await admin.query(
        `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,attempts_made,next_attempt_at,trigger,idempotency_key)
         VALUES ($1,$2,1,$3,'waiting',1,$4,'{}','writes-no-double') RETURNING id`,
        [BIZ, campaignId, contactId, dispatchRescheduledAt]
      )
    ).rows[0].id;
    // The attempt dispatch already failed (attempt_no 1, matching attempts_made).
    await admin.query(
      `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,dialed_at,ended_at,result)
       VALUES ($1,$2,1,'+441372656055','+447700900311',now(),now(),'failed')`,
      [BIZ, out]
    );

    // A LATE/duplicate status callback's own post-call run tries to apply
    // the schedule AGAIN for the SAME attempt (attempt_no 1) with a
    // DIFFERENT time -- this must be refused.
    const lateNext = new Date(Date.now() + 10 * 60_000); // "+10m" -- what a fresh nextScheduled(attemptNo=1) would compute
    const applied = await db.withTenant(BIZ, () => db.applyOutreachResult(out, 1, { terminal: false, nextAttemptAt: lateNext }));
    expect(applied).toBe(false);

    const row = (await admin.query(`SELECT state, next_attempt_at FROM outreach WHERE id = $1`, [out])).rows[0];
    expect(row.state).toBe("waiting");
    // UNCHANGED: still dispatch's own reschedule, never overwritten by the late callback's own attempt.
    expect(row.next_attempt_at.getTime()).toBe(dispatchRescheduledAt.getTime());
  });

  it("attempts_made has moved on (a NEWER attempt exists): a stale attempt's own post-call run is refused too", async () => {
    const out = (
      await admin.query(
        `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,attempts_made,trigger,idempotency_key)
         VALUES ($1,$2,1,$3,'dialing',2,'{}','writes-stale-attempt') RETURNING id`,
        [BIZ, campaignId, contactId]
      )
    ).rows[0].id;
    // Attempt #1 is stale; attempts_made is already 2 (attempt #2 is the live one).
    const applied = await db.withTenant(BIZ, () => db.applyOutreachResult(out, 1, { terminal: false, nextAttemptAt: new Date() }));
    expect(applied).toBe(false);
    const row = (await admin.query(`SELECT next_attempt_at FROM outreach WHERE id = $1`, [out])).rows[0];
    expect(row.next_attempt_at).toBeNull(); // untouched
  });
});
