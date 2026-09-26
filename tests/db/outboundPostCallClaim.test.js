// tests/db/outboundPostCallClaim.test.js
/**
 * services/db.js's `claimPostCall` -- the plan's single atomic UPDATE (spec
 * §11, Task 20): whichever of the status door's terminal callback and the
 * Live session's `finish()` arrives SECOND claims the run, exactly once,
 * however many callers try. Run as vetra_app (NOBYPASSRLS) inside
 * `db.withTenant`, the same pattern as tests/db/outboundDoorAttempt.test.js.
 *
 * The race (reproduced on two REAL connections, the outboundDoorAttempt.test.js
 * "startHeldStamp" technique): two clients race to claim the SAME attempt at
 * the same instant. Whichever gets the row lock first wins; the other's
 * concurrent UPDATE blocks, then -- once unblocked by the first's COMMIT --
 * re-evaluates its WHERE clause against the now-current row (`post_call_
 * started_at` no longer NULL) and affects zero rows. A dedicated counter row
 * (never a JS-side count, which cannot see a double UPDATE either side never
 * awaited) is incremented only by a caller whose claim actually returned a
 * row, so "runPostCall executes once" is asserted the way a real caller of
 * `claimPostCall` would experience it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ = "0c0c0000-0000-4000-8000-000000000001";
let admin, db, campaignId, contactId, outreachId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Claim Co')`, [BIZ]);
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',1) RETURNING id`,
    [BIZ]
  );
  campaignId = camp.rows[0].id;
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900211') RETURNING id`, [BIZ]);
  contactId = con.rows[0].id;
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key)
     VALUES ($1,$2,1,$3,'dialing','{}','claim-race-1') RETURNING id`,
    [BIZ, campaignId, contactId]
  );
  outreachId = out.rows[0].id;

  // A scratch table for THIS test file only -- not part of the application
  // schema, dropped in afterAll. "runPostCall executes once" is asserted by
  // counting how many callers' claim actually landed a row, the same way a
  // real caller would find out (claimPostCall's own return value), never by
  // a JS-side variable that cannot observe two connections racing.
  await admin.query(`CREATE TABLE IF NOT EXISTS postcall_claim_race_counter (attempt_id uuid PRIMARY KEY, n int NOT NULL DEFAULT 0)`);

  // No SECURITY DEFINER function involved here (claimPostCall is a plain
  // RLS-scoped UPDATE) -- but vetra_app is NOLOGIN between test files (each
  // one's afterAll restores that), so this file needs the same LOGIN grant
  // the 044/045 tests' owner dance leaves as a side effect.
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`DROP TABLE IF EXISTS postcall_claim_race_counter`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin.end();
});

/** A fresh call_attempts row under the shared outreach; attempt_no auto-increments so callers never collide. */
async function mkAttempt(sid, overrides = {}) {
  const { answeredAt = new Date(), statusCompletedAt = null, sessionFinishedAt = null } = overrides;
  const att = await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at,answered_at,status_completed_at,session_finished_at)
     VALUES ($1,$2,(SELECT COALESCE(MAX(attempt_no),0)+1 FROM call_attempts WHERE outreach_id=$2),'+441372656055','+447700900211',$3,now(),$4,$5,$6) RETURNING id`,
    [BIZ, outreachId, sid, answeredAt, statusCompletedAt, sessionFinishedAt]
  );
  await admin.query(`INSERT INTO postcall_claim_race_counter (attempt_id, n) VALUES ($1, 0)`, [att.rows[0].id]);
  return att.rows[0].id;
}

/**
 * What a real caller does: claim, and only on a real claim, run its
 * "post-call" (the counter bump). `claimPostCall` returns the claimed
 * TIMESTAMP (or null), not a bare boolean (fix round 1, Owner O-15:
 * `releasePostCallClaim` needs the exact value) -- coerced to boolean here
 * so every existing `.toBe(true)/.toBe(false)` assertion below stays exact.
 */
async function claimAndCount(attemptId) {
  const claimed = await db.withTenant(BIZ, () => db.claimPostCall(attemptId));
  if (claimed) await admin.query(`UPDATE postcall_claim_race_counter SET n = n + 1 WHERE attempt_id = $1`, [attemptId]);
  return claimed != null;
}

d("claimPostCall: the guard conditions", () => {
  it("neither input has arrived (status_completed_at NULL) -- refuses", async () => {
    const id = await mkAttempt("CAclaim-guard-1", { statusCompletedAt: null, sessionFinishedAt: null });
    expect(await claimAndCount(id)).toBe(false);
  });

  it("status-completed only, answered, under 2 minutes old -- refuses (neither disjunct holds)", async () => {
    const id = await mkAttempt("CAclaim-guard-2", { statusCompletedAt: new Date(), sessionFinishedAt: null });
    expect(await claimAndCount(id)).toBe(false);
  });

  it("status-completed + session-finished -- claims", async () => {
    const id = await mkAttempt("CAclaim-guard-3", { statusCompletedAt: new Date(), sessionFinishedAt: new Date() });
    expect(await claimAndCount(id)).toBe(true);
  });

  it("status-completed, never answered (answered_at NULL) -- claims even with no session (an unanswered attempt has none)", async () => {
    const id = await mkAttempt("CAclaim-guard-4", { answeredAt: null, statusCompletedAt: new Date(), sessionFinishedAt: null });
    expect(await claimAndCount(id)).toBe(true);
  });

  it("status-completed more than 2 minutes ago, no session -- claims (the sweep's postcall_pending backstop)", async () => {
    const id = await mkAttempt("CAclaim-guard-5", {
      statusCompletedAt: new Date(Date.now() - 3 * 60_000),
      sessionFinishedAt: null,
    });
    expect(await claimAndCount(id)).toBe(true);
  });

  it("status-completed less than 2 minutes ago, answered, no session -- refuses (too soon for the backstop)", async () => {
    const id = await mkAttempt("CAclaim-guard-6", {
      statusCompletedAt: new Date(Date.now() - 30_000),
      sessionFinishedAt: null,
    });
    expect(await claimAndCount(id)).toBe(false);
  });

  it("already claimed -- a second attempt refuses", async () => {
    const id = await mkAttempt("CAclaim-guard-7", { statusCompletedAt: new Date(), sessionFinishedAt: new Date() });
    expect(await claimAndCount(id)).toBe(true);
    expect(await claimAndCount(id)).toBe(false);
    const row = (await admin.query(`SELECT n FROM postcall_claim_race_counter WHERE attempt_id = $1`, [id])).rows[0];
    expect(row.n).toBe(1);
  });
});

d("releasePostCallClaim: fix round 1, Owner O-15 -- a failed run must not strand the attempt", () => {
  it("releases to NULL, and the attempt is claimable again afterwards", async () => {
    const id = await mkAttempt("CArelease-1", { statusCompletedAt: new Date(), sessionFinishedAt: new Date() });
    const claimedAt = await db.withTenant(BIZ, () => db.claimPostCall(id));
    expect(claimedAt).toBeInstanceOf(Date);

    // A second claim attempt refuses while it's held (the exactly-once guard).
    expect(await db.withTenant(BIZ, () => db.claimPostCall(id))).toBeNull();

    const released = await db.withTenant(BIZ, () => db.releasePostCallClaim(id));
    expect(released).toBe(true);

    const row = (await admin.query(`SELECT post_call_started_at FROM call_attempts WHERE id = $1`, [id])).rows[0];
    expect(row.post_call_started_at).toBeNull();

    // Claimable again -- exactly what lets a retried caller (or the sweep's
    // postcall_pending listing, which the 045 trigger restores the moment
    // this UPDATE commits) complete the run.
    const reclaimedAt = await db.withTenant(BIZ, () => db.claimPostCall(id));
    expect(reclaimedAt).toBeInstanceOf(Date);
  });

  it("releasing an attempt that was never claimed (post_call_started_at already NULL) is a safe no-op", async () => {
    const id = await mkAttempt("CArelease-2", { statusCompletedAt: new Date(), sessionFinishedAt: new Date() });
    // Never claimed at all.
    expect(await db.withTenant(BIZ, () => db.releasePostCallClaim(id))).toBe(false);

    // Claim, then release once -- a SECOND release (nothing reclaimed it in
    // between) must not error, just report that there was nothing to do.
    await db.withTenant(BIZ, () => db.claimPostCall(id));
    expect(await db.withTenant(BIZ, () => db.releasePostCallClaim(id))).toBe(true);
    expect(await db.withTenant(BIZ, () => db.releasePostCallClaim(id))).toBe(false);
  });
});

d("claimPostCall: two genuinely concurrent connections race for the SAME attempt (fix round 2 technique)", () => {
  /**
   * Starts a claim in its OWN transaction and its OWN connection: runs
   * `claimPostCall`'s UPDATE, signals once the statement has executed (the
   * row lock is held from this point), then blocks on `gate` before
   * committing.
   */
  function startHeldClaim(id) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let signalLocked;
    const locked = new Promise((resolve) => {
      signalLocked = resolve;
    });
    const result = db.withTenant(BIZ, async () => {
      const claimed = await db.claimPostCall(id);
      signalLocked();
      await gate;
      return claimed != null; // coerce the claimed TIMESTAMP to a boolean
    });
    return { result, locked, release };
  }

  it("both inputs already landed: two concurrent claimants -- exactly ONE claims, the counter reads 1", async () => {
    const id = await mkAttempt("CAclaim-race-1", { statusCompletedAt: new Date(), sessionFinishedAt: new Date() });

    const tx1 = startHeldClaim(id);
    await tx1.locked; // tx1 has the row lock, uncommitted

    const tx2 = db.withTenant(BIZ, () => db.claimPostCall(id)).then((v) => v != null);
    await new Promise((r) => setTimeout(r, 150)); // let tx2's UPDATE actually reach Postgres and block

    tx1.release();
    const [claimed1, claimed2] = await Promise.all([tx1.result, tx2]);

    // tx1 held the lock and committed first: deterministically the winner.
    expect(claimed1).toBe(true);
    expect(claimed2).toBe(false);

    // Bump the counter exactly the way a real caller would -- only the
    // winner's own post-call ever runs.
    if (claimed1) await admin.query(`UPDATE postcall_claim_race_counter SET n = n + 1 WHERE attempt_id = $1`, [id]);
    if (claimed2) await admin.query(`UPDATE postcall_claim_race_counter SET n = n + 1 WHERE attempt_id = $1`, [id]);

    const row = (await admin.query(`SELECT n, post_call_started_at FROM postcall_claim_race_counter c JOIN call_attempts a ON a.id = c.attempt_id WHERE c.attempt_id = $1`, [id])).rows[0];
    expect(row.n).toBe(1);
    expect(row.post_call_started_at).not.toBeNull();
  });

  it("status-completed and session-finished land concurrently from two clients, THEN two claimants race: exactly one counter bump", async () => {
    const id = await mkAttempt("CAclaim-race-2", { statusCompletedAt: null, sessionFinishedAt: null });

    // The two inputs, from two independent connections, landing at the same
    // moment -- as the status door and the Live session's finish() would.
    await Promise.all([
      admin.query(`UPDATE call_attempts SET status_completed_at = now() WHERE id = $1`, [id]),
      admin.query(`UPDATE call_attempts SET session_finished_at = now() WHERE id = $1`, [id]),
    ]);

    const tx1 = startHeldClaim(id);
    await tx1.locked;
    const tx2 = db.withTenant(BIZ, () => db.claimPostCall(id)).then((v) => v != null);
    await new Promise((r) => setTimeout(r, 150));
    tx1.release();
    const [claimed1, claimed2] = await Promise.all([tx1.result, tx2]);

    expect([claimed1, claimed2].filter(Boolean)).toHaveLength(1);
    for (const claimed of [claimed1, claimed2]) {
      if (claimed) await admin.query(`UPDATE postcall_claim_race_counter SET n = n + 1 WHERE attempt_id = $1`, [id]);
    }
    const row = (await admin.query(`SELECT n FROM postcall_claim_race_counter WHERE attempt_id = $1`, [id])).rows[0];
    expect(row.n).toBe(1);
  });
});
