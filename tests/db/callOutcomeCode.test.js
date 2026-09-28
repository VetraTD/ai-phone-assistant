// tests/db/callOutcomeCode.test.js
/**
 * setCallOutcomeCode (services/db.js), against real PostgreSQL. Fix round 1,
 * I6: the function used to log-and-return on a DB error OR a missing row,
 * reporting success back to the transfer-result door for a write that never
 * landed. It now throws on anything but exactly one row, the same shape
 * every other single-row outbound writer uses (stampAttemptStatus,
 * stampAttemptAmd, setAttemptCallSid, ...) — see tests/db/callStatusRace.test.js
 * for the sibling pattern this file follows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const BUSINESS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SID = "CA-outcome-code-test-0001";
const MISSING_SID = "CA-outcome-code-test-missing";

let admin;
let db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BUSINESS]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Outcome Code Test Clinic')`, [BUSINESS]);
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
  await admin.query(`DELETE FROM calls WHERE twilio_call_sid IN ($1, $2)`, [SID, MISSING_SID]);
  await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status) VALUES ($1, $2, '+15559876543', 'in-progress')`,
    [BUSINESS, SID]
  );
});

async function row(sid = SID) {
  const { rows } = await admin.query(`SELECT * FROM calls WHERE twilio_call_sid = $1`, [sid]);
  return rows[0] || null;
}

describeDb("setCallOutcomeCode, on real Postgres", () => {
  it("a landed row: writes outcome_code and resolves", async () => {
    await expect(db.setCallOutcomeCode(SID, "callback_requested")).resolves.toBeUndefined();
    expect((await row()).outcome_code).toBe("callback_requested");
  });

  it("a missing calls row: throws rather than silently reporting success", async () => {
    await expect(db.setCallOutcomeCode(MISSING_SID, "callback_requested")).rejects.toThrow(
      /expected 1 row, got 0/
    );
    expect(await row(MISSING_SID)).toBeNull();
  });
});

// S3-3 (spec §12.2, §11's "answers.callback_requested_at" seam):
// schedule_callback's own write. Same file, same harness, same shape as
// setCallOutcomeCode above -- the sibling this function was written beside.
describeDb("mergeCallAnswers, on real Postgres", () => {
  it("a landed row with no prior answers: writes the patch as the whole object", async () => {
    await expect(db.mergeCallAnswers(SID, { callback_requested_at: "2026-10-01T15:00:00.000Z" })).resolves.toBeUndefined();
    expect((await row()).answers).toEqual({ callback_requested_at: "2026-10-01T15:00:00.000Z" });
  });

  it("a SECOND merge adds a key without clobbering the first (shallow JSONB merge, not an overwrite)", async () => {
    await db.mergeCallAnswers(SID, { callback_requested_at: "2026-10-01T15:00:00.000Z" });
    await db.mergeCallAnswers(SID, { another_key: "kept alongside" });
    expect((await row()).answers).toEqual({
      callback_requested_at: "2026-10-01T15:00:00.000Z",
      another_key: "kept alongside",
    });
  });

  it("a later merge for the SAME key overwrites just that key", async () => {
    await db.mergeCallAnswers(SID, { callback_requested_at: "2026-10-01T15:00:00.000Z" });
    await db.mergeCallAnswers(SID, { callback_requested_at: "2026-10-02T09:00:00.000Z" });
    expect((await row()).answers).toEqual({ callback_requested_at: "2026-10-02T09:00:00.000Z" });
  });

  it("a missing calls row: throws rather than silently reporting success", async () => {
    await expect(db.mergeCallAnswers(MISSING_SID, { callback_requested_at: "2026-10-01T15:00:00.000Z" })).rejects.toThrow(
      /expected 1 row, got 0/
    );
    expect(await row(MISSING_SID)).toBeNull();
  });
});
