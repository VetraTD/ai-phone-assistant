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

/** A fresh call_attempts row under the shared outreach, for tests that must
 * not share mutable state with each other. */
async function mkAttempt(sid, attemptNo) {
  const att = await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
     VALUES ($1,$2,$3,'+441372656055','+447700900199',$4,now()) RETURNING id`,
    [BIZ, outreachId, attemptNo, sid]
  );
  return att.rows[0].id;
}

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

  // Fix round 1, item 6. Every case above reuses the SAME `attemptId`
  // fixture, which by this point has already been stamped `answered: true`
  // (the very first test in this block). `no-answer` on a real attempt is
  // never answered, and nothing above proves that path lands correctly.
  it("no-answer on a FRESH attempt sets result='no_answer', stamps status_completed_at, and never sets answered_at", async () => {
    const freshId = await mkAttempt("CAdoorattempt-noanswer", 2);
    const outcome = await db.withTenant(BIZ, () =>
      db.stampAttemptStatus(freshId, { twilioStatus: "no-answer", answered: false, terminal: true, result: "no_answer" })
    );
    expect(outcome).toEqual({ firstTerminalStamp: true, answered: false });

    const row = (await admin.query(
      `SELECT twilio_status, result, status_completed_at, ended_at, answered_at FROM call_attempts WHERE id = $1`,
      [freshId]
    )).rows[0];
    expect(row.twilio_status).toBe("no-answer");
    expect(row.result).toBe("no_answer");
    expect(row.status_completed_at).not.toBeNull();
    expect(row.ended_at).not.toBeNull();
    expect(row.answered_at).toBeNull();
  });
});

// Fix round 1, items 5 and 9: covered separately from the block above, on
// FRESH attempts each time, so the sequencing (which status landed first)
// is unambiguous and not entangled with the don't-overwrite tests' own
// mutations of the shared `attemptId` fixture.
d("stampAttemptStatus: twilio_status freezes after a terminal stamp unless the new status is itself terminal (item 5); firstTerminalStamp/answered report the real state transition (item 9)", () => {
  it("an answered call's first terminal stamp reports {firstTerminalStamp:true, answered:true}; the in-progress stamp before it does not", async () => {
    const id = await mkAttempt("CAdoorattempt-seq1", 3);

    const inProgress = await db.withTenant(BIZ, () =>
      db.stampAttemptStatus(id, { twilioStatus: "in-progress", answered: true, terminal: false, result: null })
    );
    // Not terminal, so firstTerminalStamp is false regardless; "answered"
    // reports the state BEFORE this call, which had never been answered yet.
    expect(inProgress).toEqual({ firstTerminalStamp: false, answered: false });

    const completed = await db.withTenant(BIZ, () =>
      db.stampAttemptStatus(id, { twilioStatus: "completed", answered: false, terminal: true, result: null })
    );
    expect(completed).toEqual({ firstTerminalStamp: true, answered: true });

    const duplicate = await db.withTenant(BIZ, () =>
      db.stampAttemptStatus(id, { twilioStatus: "completed", answered: false, terminal: true, result: null })
    );
    expect(duplicate).toEqual({ firstTerminalStamp: false, answered: true });
  });

  it("a late out-of-order NON-terminal status after a terminal stamp does not move twilio_status backwards", async () => {
    const id = await mkAttempt("CAdoorattempt-seq2", 4);
    await db.withTenant(BIZ, () => db.stampAttemptStatus(id, { twilioStatus: "completed", answered: false, terminal: true, result: null }));

    // A reordered "ringing" arriving after "completed" -- must be frozen out.
    await db.withTenant(BIZ, () => db.stampAttemptStatus(id, { twilioStatus: "ringing", answered: false, terminal: false, result: null }));
    const afterStrayRinging = (await admin.query(`SELECT twilio_status FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(afterStrayRinging.twilio_status).toBe("completed");

    // A SECOND terminal status (a duplicate/retry spelling a different word)
    // still writes twilio_status through -- only non-terminal is frozen out.
    await db.withTenant(BIZ, () => db.stampAttemptStatus(id, { twilioStatus: "canceled", answered: false, terminal: true, result: null }));
    const afterDuplicateTerminal = (await admin.query(`SELECT twilio_status FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(afterDuplicateTerminal.twilio_status).toBe("canceled");

    // And a non-terminal arriving after THAT is frozen out too.
    await db.withTenant(BIZ, () => db.stampAttemptStatus(id, { twilioStatus: "ringing", answered: false, terminal: false, result: null }));
    const afterSecondStrayRinging = (await admin.query(`SELECT twilio_status FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(afterSecondStrayRinging.twilio_status).toBe("canceled");
  });
});

// Fix round 2 (Critical, found on the re-review). The single-statement CTE
// above (`WITH before AS (SELECT ... FROM call_attempts WHERE id = $1)
// UPDATE ...`) evaluates `before` ONCE, from the snapshot at statement
// START -- BEFORE the UPDATE blocks on the row lock. Under READ COMMITTED,
// when a second concurrent stamp blocks behind an uncommitted first one,
// Postgres's EvalPlanQual recheck (once the lock is free) refreshes bare
// `a.<column>` references but does NOT re-evaluate a materialized CTE. So a
// second, genuinely concurrent call sees the FIRST call's PRE-write state in
// `before`, not its post-commit state -- reproduced below on two real
// connections (the shared pool naturally hands out two: `db.withTenant`
// calls `pool.connect()` per unit of work).
//
// This uses a manual gate (a Promise held open inside the first
// `db.withTenant` unit) to force tx2's write to arrive and block WHILE tx1's
// write is done but not yet committed -- the exact window the bug lives in.
d("stampAttemptStatus: race-safety under two genuinely concurrent connections (fix round 2, Critical)", () => {
  /**
   * Starts tx1: stamps `first`, signals once the write has happened (lock
   * held), then blocks on `gate` before committing. Returns
   * { result: Promise<outcome>, locked: Promise<void>, release: () => void }.
   */
  function startHeldStamp(id, stamp) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    // `db.withTenant`'s callback receives the checked-out client (services/
    // db.js's `fn(client)`), so tx1 can read ITS OWN write back on the SAME,
    // still-open transaction before signalling and waiting on the gate --
    // that is what "the value tx1 committed" means: not a second read after
    // the fact (racing tx2's own completion), and not the host's Date.now()
    // (container/host clock skew plus load flaked this once under load;
    // controller Ruling, session 2b "Pulled in").
    const result = db.withTenant(BIZ, async (client) => {
      const outcome = await db.stampAttemptStatus(id, stamp);
      const row = await client.query(`SELECT status_completed_at FROM call_attempts WHERE id = $1`, [id]);
      const committedStatusCompletedAt = row.rows[0].status_completed_at;
      signalLocked();
      await gate;
      return { ...outcome, committedStatusCompletedAt };
    });
    return { result, locked, release };
  }

  it("(a) two concurrent terminal stamps: exactly ONE reports firstTerminalStamp=true, and status_completed_at is NOT moved by the second (blocked) one", async () => {
    const id = await mkAttempt("CAdoorattempt-race-a", 5);

    const tx1 = startHeldStamp(id, { twilioStatus: "completed", answered: false, terminal: true, result: null });
    await tx1.locked; // tx1 has written and holds the row lock, uncommitted

    // Start tx2 -- its own SELECT/UPDATE will now block on tx1's lock. Give
    // it time to actually reach Postgres and enter the wait before we hold
    // tx1 open a good while longer -- if tx2's write lands AFTER a long
    // enough hold, its own now() would be measurably later than tx1's.
    const tx2 = db.withTenant(BIZ, () =>
      db.stampAttemptStatus(id, { twilioStatus: "canceled", answered: false, terminal: true, result: null })
    );
    await new Promise((r) => setTimeout(r, 150)); // let tx2's statement actually block

    await new Promise((r) => setTimeout(r, 900)); // hold tx1 open well past tx2's own now(), if the bug lets it write
    tx1.release();

    const [outcome1, outcome2] = await Promise.all([tx1.result, tx2]);

    // tx1 wrote first and holds the lock throughout -- it is deterministically
    // the FIRST terminal stamp, not a coin flip.
    expect(outcome1).toMatchObject({ firstTerminalStamp: true, answered: false });
    // THE BUG: on the CTE version this also came back {firstTerminalStamp:true},
    // because `before` was captured before tx1 even wrote.
    expect(outcome2).toEqual({ firstTerminalStamp: false, answered: false });

    const row = (await admin.query(`SELECT status_completed_at FROM call_attempts WHERE id = $1`, [id])).rows[0];
    // status_completed_at must be EXACTLY what tx1 itself committed -- proof
    // tx2 (blocked, then unblocked by tx1's commit) never moved it, without
    // depending on the host clock at all.
    expect(row.status_completed_at.getTime()).toBe(outcome1.committedStatusCompletedAt.getTime());
  });

  it("(b) a non-terminal status blocked behind an uncommitted terminal stamp does not move twilio_status backwards once it lands", async () => {
    const id = await mkAttempt("CAdoorattempt-race-b", 6);

    const tx1 = startHeldStamp(id, { twilioStatus: "completed", answered: false, terminal: true, result: null });
    await tx1.locked;

    const tx2 = db.withTenant(BIZ, () =>
      db.stampAttemptStatus(id, { twilioStatus: "ringing", answered: false, terminal: false, result: null })
    );
    await new Promise((r) => setTimeout(r, 150));

    tx1.release();
    await Promise.all([tx1.result, tx2]);

    const row = (await admin.query(`SELECT twilio_status FROM call_attempts WHERE id = $1`, [id])).rows[0];
    // THE BUG: on the CTE version this came back "ringing" -- tx2's `before`
    // CTE was captured before tx1 committed, so it never saw
    // status_completed_at as set and the freeze condition never engaged.
    expect(row.twilio_status).toBe("completed");
  });
});
