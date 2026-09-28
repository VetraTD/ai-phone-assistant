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
import outcomePack from "../../capabilities/outcome.js";
import qualificationPack from "../../capabilities/qualification.js";

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

// I2 (Important, checkpoint-A review). capabilities/outcome.js's `note`
// used to live only in an in-memory scratchpad (stateEffects.capabilityState),
// never reaching the DB at all. This is the real wire, end to end: the pack's
// own execute() called with the REAL db.js functions as ctx.deps (not a
// mock), against real Postgres, tenant-scoped by twilio_call_sid the same
// way setCallOutcomeCode/mergeCallAnswers already are above.
describeDb("capabilities/outcome.js's note persistence, on real Postgres (I2)", () => {
  it("a note present: persisted under _outcome_note, a key no campaign question can ever collide with", async () => {
    const fc = { id: "fc-i2a", name: "set_call_outcome", args: { outcome: "other", note: "asked to be contacted by email instead" } };
    const ctx = { callSid: SID, callId: null, deps: { setCallOutcomeCode: db.setCallOutcomeCode, mergeCallAnswers: db.mergeCallAnswers } };

    const result = await outcomePack.execute(fc, ctx);

    expect(result.functionResponse.response.success).toBe(true);
    const r = await row();
    expect(r.outcome_code).toBe("other");
    expect(r.answers).toEqual({ _outcome_note: "asked to be contacted by email instead" });
  });

  it("no note: outcome_code still lands, but answers stays untouched (never written to)", async () => {
    const fc = { id: "fc-i2b", name: "set_call_outcome", args: { outcome: "not_interested" } };
    const ctx = { callSid: SID, callId: null, deps: { setCallOutcomeCode: db.setCallOutcomeCode, mergeCallAnswers: db.mergeCallAnswers } };

    const result = await outcomePack.execute(fc, ctx);

    expect(result.functionResponse.response.success).toBe(true);
    const r = await row();
    expect(r.outcome_code).toBe("not_interested");
    expect(r.answers).toBeNull();
  });

  it("a note alongside a campaign-style answer key: both survive (the shallow JSONB merge, not an overwrite)", async () => {
    await db.mergeCallAnswers(SID, { callback_requested_at: "2026-10-01T15:00:00.000Z" });
    const fc = { id: "fc-i2c", name: "set_call_outcome", args: { outcome: "qualified_no_booking", note: "wants a follow-up call" } };
    const ctx = { callSid: SID, callId: null, deps: { setCallOutcomeCode: db.setCallOutcomeCode, mergeCallAnswers: db.mergeCallAnswers } };

    await outcomePack.execute(fc, ctx);

    const r = await row();
    expect(r.answers).toEqual({
      callback_requested_at: "2026-10-01T15:00:00.000Z",
      _outcome_note: "wants a follow-up call",
    });
  });
});

// B2 (review): no DB-real E2E of the wrong_number suppression path existed
// -- tests/db/outboundSuppression.test.js exercises db.insertSuppression
// directly (the primitive), but never through the TOOL's own execute(), the
// must-hold write the file header calls out. Real db.insertSuppression
// requires an active tenant scope (requireTenantScope), so this runs inside
// db.withTenant the same way a live call's executeToolCallGuarded would.
describeDb("capabilities/outcome.js's wrong_number branch, on real Postgres, end to end (B2)", () => {
  const PHONE = "+447700900601";

  async function suppressionRow(phone) {
    const { rows } = await admin.query(`SELECT reason, created_by, phone_e164 FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`, [
      BUSINESS,
      phone,
    ]);
    return rows[0] || null;
  }

  beforeEach(async () => {
    if (!url) return;
    await admin.query(`DELETE FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`, [BUSINESS, PHONE]);
  });

  it("inserts a real suppression row AND records the call's outcome as wrong_person, through the tool's own execute()", async () => {
    const fc = { id: "fc-b2a", name: "set_call_outcome", args: { outcome: "wrong_number" } };
    const ctx = {
      callSid: SID,
      callId: null,
      party: { phone: PHONE, source: "dialed", verified: false },
      deps: { setCallOutcomeCode: db.setCallOutcomeCode, mergeCallAnswers: db.mergeCallAnswers, insertSuppression: db.insertSuppression },
    };

    const result = await db.withTenant(BUSINESS, () => outcomePack.execute(fc, ctx));

    expect(result.functionResponse.response.success).toBe(true);
    // The CALL's own recorded outcome is wrong_person, never the literal
    // suppression reason (the file header's own distinction).
    expect((await row()).outcome_code).toBe("wrong_person");
    expect(await suppressionRow(PHONE)).toEqual({ reason: "wrong_number", created_by: "tool", phone_e164: PHONE });
  });

  it("a second wrong_number report for the SAME number is still a success (ON CONFLICT DO NOTHING), no duplicate row", async () => {
    const fc = { id: "fc-b2b", name: "set_call_outcome", args: { outcome: "wrong_number" } };
    const ctx = {
      callSid: SID,
      callId: null,
      party: { phone: PHONE, source: "dialed", verified: false },
      deps: { setCallOutcomeCode: db.setCallOutcomeCode, mergeCallAnswers: db.mergeCallAnswers, insertSuppression: db.insertSuppression },
    };

    await db.withTenant(BUSINESS, () => outcomePack.execute(fc, ctx));
    const second = await db.withTenant(BUSINESS, () => outcomePack.execute(fc, ctx));

    expect(second.functionResponse.response.success).toBe(true);
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`, [
      BUSINESS,
      PHONE,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("no usable phone on the call: refuses BEFORE any write -- no suppression row, no outcome_code change", async () => {
    const fc = { id: "fc-b2c", name: "set_call_outcome", args: { outcome: "wrong_number" } };
    const ctx = {
      callSid: SID,
      callId: null,
      party: { phone: "anonymous", source: "dialed", verified: false },
      deps: { setCallOutcomeCode: db.setCallOutcomeCode, mergeCallAnswers: db.mergeCallAnswers, insertSuppression: db.insertSuppression },
    };

    const result = await db.withTenant(BUSINESS, () => outcomePack.execute(fc, ctx));

    expect(result.functionResponse.response.success).toBe(false);
    expect(await suppressionRow("anonymous")).toBeNull();
    expect((await row()).outcome_code).toBeNull();
  });
});

// F20 (review): no real-DB test of record_answer's write existed --
// tests/qualificationPack.test.js is unit-level, a fake mergeCallAnswers.
// This is the real wire, the same shape as capabilities/outcome.js's own I2
// coverage above: the pack's execute() called with db.mergeCallAnswers as
// ctx.deps, against real Postgres.
describeDb("capabilities/qualification.js's record_answer, on real Postgres (F20)", () => {
  const QUESTIONS = [{ key: "clinic_name", ask: "What clinic?", required: true, type: "text" }];

  function ctxFor(overrides = {}) {
    return {
      callSid: SID,
      callId: null,
      outboundCall: { config: { capabilities: ["qualification"], questions: QUESTIONS } },
      deps: { mergeCallAnswers: db.mergeCallAnswers },
      ...overrides,
    };
  }

  it("a valid answer lands in calls.answers, under the campaign's own key", async () => {
    const fc = { id: "fc-f20a", name: "record_answer", args: { key: "clinic_name", value: "Riverside Clinic" } };
    const result = await qualificationPack.execute(fc, ctxFor());
    expect(result.functionResponse.response.success).toBe(true);
    expect((await row()).answers).toEqual({ clinic_name: "Riverside Clinic" });
  });

  it("a SECOND answer (a different key) merges alongside the first, not overwriting it", async () => {
    await qualificationPack.execute(
      { id: "fc-f20b1", name: "record_answer", args: { key: "clinic_name", value: "Riverside Clinic" } },
      ctxFor({ outboundCall: { config: { capabilities: ["qualification"], questions: [...QUESTIONS, { key: "urgent", ask: "Urgent?", required: false, type: "text" }] } } })
    );
    await qualificationPack.execute(
      { id: "fc-f20b2", name: "record_answer", args: { key: "urgent", value: "yes" } },
      ctxFor({ outboundCall: { config: { capabilities: ["qualification"], questions: [...QUESTIONS, { key: "urgent", ask: "Urgent?", required: false, type: "text" }] } } })
    );
    expect((await row()).answers).toEqual({ clinic_name: "Riverside Clinic", urgent: "yes" });
  });

  it("an unknown key never reaches the database at all -- refused before any write", async () => {
    const fc = { id: "fc-f20c", name: "record_answer", args: { key: "not_a_real_key", value: "x" } };
    const result = await qualificationPack.execute(fc, ctxFor());
    expect(result.functionResponse.response.success).toBe(false);
    expect((await row()).answers).toBeNull();
  });

  it("a missing mergeCallAnswers wire refuses, real deps object with the key simply absent", async () => {
    const fc = { id: "fc-f20d", name: "record_answer", args: { key: "clinic_name", value: "Riverside Clinic" } };
    const result = await qualificationPack.execute(fc, ctxFor({ deps: {} }));
    expect(result.functionResponse.response.success).toBe(false);
    expect((await row()).answers).toBeNull();
  });
});
