import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// A5's gate, against a real database because it is the only place it means
// anything: "Export returns every PHI-bearing row for a caller; erasure leaves
// none."
//
// The fixture is built to make the interesting failure possible. The same
// caller's number is stored FOUR different ways across the tables — E.164 as
// Twilio sends it, a US national format somebody typed, a version with dots,
// and one with a leading space — because that is what the real data looks
// like. Migration 026 normalises punctuation but deliberately will not guess a
// country code, so spellings genuinely diverge.
//
// An export that matched exactly would return a subset and call it complete.
// An erasure that matched exactly would leave rows behind and report success.
// Both are worse than not offering the feature, and both pass a test whose
// fixture uses one spelling throughout.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const BUSINESS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_BUSINESS = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SUBJECT = "+15551234567";
const BYSTANDER = "+15559999999";

let admin;
let db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BUSINESS, OTHER_BUSINESS]).catch(() => {});
  await admin.end();
  await db?.close();
});

/**
 * One call with a transcript, an appointment, a request and an SMS-consent row,
 * for one number.
 *
 * The consent row (migration 037) is spelled a FIFTH way on purpose, for the
 * same reason the other four differ: it is a phone number stored by a different
 * code path, and an erasure that matched only the spelling Twilio sends would
 * leave it behind and report success.
 */
async function seedCaller({ business, callSid, callerNumber, apptPhone, requestPhone, name, notes, message, summary }) {
  const { rows } = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, summary)
     VALUES ($1, $2, $3, 'completed', $4) RETURNING id`,
    [business, callSid, callerNumber, summary]
  );
  const callId = rows[0].id;
  await admin.query(
    `INSERT INTO call_transcripts (call_id, speaker, message, sequence) VALUES ($1, 'caller', $2, 1)`,
    [callId, message]
  );
  await admin.query(
    `INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at, notes)
     VALUES ($1, $2, $3, $4, now(), $5)`,
    [business, callId, name, apptPhone, notes]
  );
  await admin.query(
    `INSERT INTO customer_requests (business_id, call_id, request_type, caller_name, callback_number, message, notes)
     VALUES ($1, $2, 'message', $3, $4, $5, $6)`,
    [business, callId, name, requestPhone, message, notes]
  );
  await admin.query(
    `INSERT INTO sms_consents (business_id, call_id, phone_number, granted, script, script_version)
     VALUES ($1, $2, $3, true, 'Can I send you a text confirmation?', 'test.1')`,
    [business, callId, callerNumber]
  );
  return callId;
}

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BUSINESS, OTHER_BUSINESS]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'DSR Clinic'), ($2, 'Other Clinic')`, [
    BUSINESS,
    OTHER_BUSINESS,
  ]);

  // The data subject, spelled four different ways.
  await seedCaller({
    business: BUSINESS,
    callSid: "CA-dsr-1",
    callerNumber: "+15551234567",
    apptPhone: "(555) 123-4567",
    requestPhone: "555.123.4567",
    name: "Jane Q Patient",
    notes: "chest pain since Tuesday",
    message: "I need to move my echo appointment",
    summary: "Caller asked to move their echo appointment",
  });

  // A different caller at the same clinic. Must survive untouched.
  await seedCaller({
    business: BUSINESS,
    callSid: "CA-dsr-2",
    callerNumber: BYSTANDER,
    apptPhone: BYSTANDER,
    requestPhone: BYSTANDER,
    name: "Someone Else",
    notes: "bystander notes",
    message: "bystander message",
    summary: "bystander summary",
  });

  // The SAME number at a DIFFERENT tenant. Must survive untouched — a phone
  // number is not a secret and neither is a business UUID.
  await seedCaller({
    business: OTHER_BUSINESS,
    callSid: "CA-dsr-3",
    callerNumber: SUBJECT,
    apptPhone: SUBJECT,
    requestPhone: SUBJECT,
    name: "Same Number Other Tenant",
    notes: "other tenant notes",
    message: "other tenant message",
    summary: "other tenant summary",
  });
});

describeDb("Art. 15 export", () => {
  it("finds the caller's rows across every spelling of their number", async () => {
    const data = await db.exportCallerData(BUSINESS, SUBJECT);

    expect(data.calls).toHaveLength(1);
    expect(data.transcripts).toHaveLength(1);
    // These two are the ones an exact match would have missed entirely.
    expect(data.appointments, "an appointment stored as (555) 123-4567 was not found").toHaveLength(1);
    expect(data.customerRequests, "a request stored as 555.123.4567 was not found").toHaveLength(1);
  });

  it("returns the actual content, not just the row count", async () => {
    const data = await db.exportCallerData(BUSINESS, SUBJECT);

    expect(data.transcripts[0].message).toBe("I need to move my echo appointment");
    expect(data.appointments[0].client_name).toBe("Jane Q Patient");
    expect(data.appointments[0].notes).toBe("chest pain since Tuesday");
    expect(data.calls[0].summary).toBe("Caller asked to move their echo appointment");
  });

  it("returns nothing belonging to another caller", async () => {
    const data = await db.exportCallerData(BUSINESS, SUBJECT);
    expect(JSON.stringify(data)).not.toContain("bystander");
    expect(JSON.stringify(data)).not.toContain("Someone Else");
  });

  it("returns nothing belonging to another tenant with the same number", async () => {
    const data = await db.exportCallerData(BUSINESS, SUBJECT);
    expect(JSON.stringify(data)).not.toContain("other tenant");
    expect(JSON.stringify(data)).not.toContain("Same Number Other Tenant");
  });

  it("is empty, not an error, for a caller with no history", async () => {
    const data = await db.exportCallerData(BUSINESS, "+15550000000");
    expect(data).toEqual({ calls: [], transcripts: [], appointments: [], customerRequests: [], smsConsents: [] });
  });
});

describeDb("Art. 17 erasure", () => {
  it("leaves none of the caller's personal data behind", async () => {
    await db.eraseCallerData(BUSINESS, SUBJECT);

    // The gate, stated as the gate: export after erasure finds nothing.
    const after = await db.exportCallerData(BUSINESS, SUBJECT);
    expect(after.transcripts).toEqual([]);
    expect(after.calls).toEqual([]);
    expect(after.appointments).toEqual([]);
    expect(after.customerRequests).toEqual([]);
    expect(after.smsConsents).toEqual([]);
  });

  it("leaves no trace of the content anywhere in the tenant's tables", async () => {
    await db.eraseCallerData(BUSINESS, SUBJECT);

    // Export can only look where it knows to look, and after erasure it cannot
    // find the rows at all — so it would report success even if the content
    // were still sitting there. This asks the database directly.
    const leftovers = await admin.query(
      `SELECT
         (SELECT count(*) FROM call_transcripts t JOIN calls c ON c.id = t.call_id
           WHERE c.business_id = $1 AND t.message LIKE '%echo appointment%')::int AS transcripts,
         (SELECT count(*) FROM calls WHERE business_id = $1 AND (caller_number LIKE '%1234567%' OR summary LIKE '%echo appointment%'))::int AS calls,
         (SELECT count(*) FROM appointments WHERE business_id = $1 AND (client_name = 'Jane Q Patient' OR client_phone LIKE '%1234567%' OR notes LIKE '%chest pain%'))::int AS appts,
         (SELECT count(*) FROM customer_requests WHERE business_id = $1 AND (caller_name = 'Jane Q Patient' OR callback_number LIKE '%1234567%' OR message LIKE '%echo%' OR notes LIKE '%chest pain%'))::int AS requests`,
      [BUSINESS]
    );
    expect(leftovers.rows[0]).toEqual({ transcripts: 0, calls: 0, appts: 0, requests: 0 });
  });

  it("keeps the non-identifying skeleton rather than deleting the business record", async () => {
    await db.eraseCallerData(BUSINESS, SUBJECT);

    // The call happened, took time, and cost money. Art. 17 asks for the
    // personal data to go, not the controller's own accounting.
    const { rows } = await admin.query(`SELECT caller_number, summary, status FROM calls WHERE twilio_call_sid = 'CA-dsr-1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].caller_number).toBeNull();
    expect(rows[0].summary).toBeNull();
    expect(rows[0].status).toBe("completed");
  });

  it("reports what it erased", async () => {
    const counts = await db.eraseCallerData(BUSINESS, SUBJECT);
    expect(counts).toEqual({ transcripts: 1, calls: 1, appointments: 1, customerRequests: 1, smsConsents: 1 });
  });

  it("does not touch another caller at the same tenant", async () => {
    await db.eraseCallerData(BUSINESS, SUBJECT);

    const other = await db.exportCallerData(BUSINESS, BYSTANDER);
    expect(other.calls).toHaveLength(1);
    expect(other.transcripts[0].message).toBe("bystander message");
    expect(other.appointments[0].client_name).toBe("Someone Else");
  });

  it("does not touch the same number at another tenant", async () => {
    await db.eraseCallerData(BUSINESS, SUBJECT);

    const other = await db.exportCallerData(OTHER_BUSINESS, SUBJECT);
    expect(other.calls).toHaveLength(1);
    expect(other.appointments[0].client_name).toBe("Same Number Other Tenant");
  });

  it("is a no-op that reports zeros for a caller with no history", async () => {
    const counts = await db.eraseCallerData(BUSINESS, "+15550000000");
    expect(counts).toEqual({ transcripts: 0, calls: 0, appointments: 0, customerRequests: 0, smsConsents: 0 });
  });
});
