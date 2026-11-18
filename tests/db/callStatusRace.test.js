import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// The transferred-status clobber guard, against a real PostgreSQL.
//
// This used to live in tests/supabase-calls.test.js, where a hand-written mock
// simulated `UPDATE ... WHERE status <> 'transferred'` in JavaScript so the
// guard could be exercised without a database. That proved the mock implements
// the rule. Whether POSTGRES implements it — and whether the SQL the data layer
// actually emits triggers it — is a different question, and only a database can
// answer it.
//
// The bug being guarded, in order:
//
//   1. A caller asks for a human. markCallTransferred sets status='transferred'.
//   2. Twilio's status callback for the same (now redialed) leg arrives and
//      calls completeCall(..., 'completed', 42).
//   3. If step 2 overwrites status, the call is recorded as completed and the
//      transfer disappears from the record — a call that was handed to a person
//      looks like one the assistant finished.
//
// Timing fields must be written in BOTH orderings: a transferred call still
// ended, and still had a duration.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const BUSINESS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SID = "CA-race-test-0001";

let admin;
let db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BUSINESS]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Race Test Clinic')`, [BUSINESS]);
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BUSINESS]).catch(() => {});
  await admin.end();
  await db?.close();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM calls WHERE twilio_call_sid = $1`, [SID]);
  await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status) VALUES ($1, $2, '+15551110000', 'in-progress')`,
    [BUSINESS, SID]
  );
});

async function row() {
  const { rows } = await admin.query(`SELECT * FROM calls WHERE twilio_call_sid = $1`, [SID]);
  return rows[0];
}

describeDb("completeCall vs markCallTransferred, on real Postgres", () => {
  it("transfer THEN completeCall: the guard prevents the clobber", async () => {
    await db.markCallTransferred(SID);
    expect((await row()).status).toBe("transferred");

    await db.completeCall(SID, "completed", 42);

    const r = await row();
    expect(r.status).toBe("transferred");
    expect(r.ended_at).not.toBeNull();
    expect(r.duration_seconds).toBe(42);
  });

  it("completeCall THEN transfer: status ends up transferred", async () => {
    // markCallTransferred has no reason to guard — a transfer landing after a
    // completion is a real, later event.
    await db.completeCall(SID, "completed", 10);
    expect((await row()).status).toBe("completed");

    await db.markCallTransferred(SID);

    expect((await row()).status).toBe("transferred");
  });

  it("sets status normally when the call was never transferred", async () => {
    await db.completeCall(SID, "completed", 10);

    const r = await row();
    expect(r.status).toBe("completed");
    expect(r.duration_seconds).toBe(10);
  });

  it("writes ended_at without duration when Twilio sends none", async () => {
    await db.completeCall(SID, "failed", null);

    const r = await row();
    expect(r.ended_at).not.toBeNull();
    expect(r.duration_seconds).toBeNull();
    expect(r.status).toBe("failed");
  });

  // Why the guard is `IS DISTINCT FROM` and not `<>`, stated accurately after
  // the database corrected the first version of this test.
  //
  // The worry was that bare SQL `status <> 'transferred'` evaluates to NULL —
  // and so not true — when status is NULL, silently skipping the update.
  // PostgREST's .neq() had excluded NULLs for you. But `calls.status` is NOT
  // NULL with a default, so that state is unreachable and the two operators are
  // equivalent here. `IS DISTINCT FROM` stays because it is free and it stops
  // being equivalent the moment somebody drops the constraint; this test pins
  // the constraint that makes the question moot, which is the fact that would
  // actually change.
  it("calls.status is NOT NULL, which is what makes <> and IS DISTINCT FROM equivalent", async () => {
    await expect(
      admin.query(`UPDATE calls SET status = NULL WHERE twilio_call_sid = $1`, [SID])
    ).rejects.toThrow(/not-null constraint/);
  });

  it("concurrent transfer and completion cannot both win", async () => {
    // Both statements against the same row, issued together. Postgres
    // serialises them; whichever commits second sees the other's committed
    // value rather than a stale snapshot. The only acceptable outcome is
    // 'transferred', in either arrival order.
    await Promise.all([db.markCallTransferred(SID), db.completeCall(SID, "completed", 7)]);

    expect((await row()).status).toBe("transferred");
  });
});
