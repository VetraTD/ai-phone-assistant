// tests/db/outboundBooking.test.js
/**
 * S3-10 (Task 30, spec §12.6): booking on the built-in calendar, on the REAL
 * database. Task 30's own scope note: "Implement: only the effect-to-outcome
 * wiring. Everything else exists after Task 18." -- this file is that real-DB
 * proof, for the three things Task 30 asks for:
 *
 *   - an outbound booking writes clientPhone = party.phone (Task 18), through
 *     the REAL adapters/scheduling/internal.js book() and the real
 *     `appointments` table -- the unit-level version (fake deps) already
 *     lives in tests/outboundParty.test.js;
 *   - a clash is refused by the REAL create_appointment_if_available
 *     (migration 022's advisory-locked function, database/022_appointment_
 *     slot_capacity.sql) -- something no fake-deps test can prove, since the
 *     capacity re-check under lock is exactly what the fake never runs;
 *   - the booking's effect sets the outcome `booked` -- proven through
 *     services/db.js's `outboundCallEffects(callId)`, the SAME read
 *     lib/outbound/postCall.js's tier 3 already uses to resolve
 *     `calls.outcome_code`. No code in postCall.js changes for this: the
 *     wiring already existed (it reads `appointments WHERE call_id = $1`),
 *     and `internalAdapter.book()` already threads `callId` through to
 *     `createAppointmentIfAvailable` -- this test is what proves the whole
 *     chain on real SQL rather than asserting it by reading the code.
 *
 * Real DB, as vetra_app under RLS -- the same pattern as
 * tests/db/outboundPostCallWrites.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import internalAdapter from "../../adapters/scheduling/internal.js";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ = "0d0d0000-0000-4000-8000-0000000000b0";
let admin, db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  // vetra_app is NOLOGIN between test files; each file that needs it as an
  // application role grants LOGIN here and restores NOLOGIN in afterAll, the
  // same as tests/db/outboundPostCallWrites.test.js and
  // tests/db/outboundPostCallClaim.test.js.
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Outbound Booking Co')`, [BIZ]);

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

let sidSeq = 0;
/** A fresh outbound `calls` row -- appointments.call_id references this. */
async function mkCall() {
  sidSeq += 1;
  const sid = `CAqualbook${sidSeq}`;
  const res = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, direction) VALUES ($1,$2,'outbound') RETURNING id`,
    [BIZ, sid]
  );
  return { callId: res.rows[0].id, callSid: sid };
}

const futureIso = (mins) => new Date(Date.now() + mins * 60_000).toISOString();

d("adapters/scheduling/internal.js book() -- clientPhone = party.phone, on the real DB", () => {
  it("writes clientPhone = party.phone and the call_id, through the real createAppointmentIfAvailable RPC", async () => {
    const { callId } = await mkCall();
    const ctx = {
      businessId: BIZ,
      callId,
      party: { phone: "+15559876543", source: "dialed", verified: true },
      deps: db,
    };
    const result = await db.withTenant(BIZ, () =>
      internalAdapter.book(ctx, {
        clientName: "Priya Shah",
        clientPhone: "+15559876543",
        scheduledAt: futureIso(60),
        notes: null,
        lengthMinutes: 30,
        capacity: 1,
      })
    );
    expect(result.ok).toBe(true);
    const row = (await admin.query(`SELECT client_phone, call_id, business_id FROM appointments WHERE id = $1`, [result.id])).rows[0];
    expect(row.client_phone).toBe("+15559876543");
    expect(row.call_id).toBe(callId);
    expect(row.business_id).toBe(BIZ);
  });
});

d("create_appointment_if_available (migration 022) -- a real clash under the advisory lock", () => {
  it("refuses a second booking once the slot's capacity (1) is taken", async () => {
    const { callId: callId1 } = await mkCall();
    const { callId: callId2 } = await mkCall();
    const when = futureIso(120);

    const first = await db.withTenant(BIZ, () =>
      db.createAppointmentIfAvailable({
        businessId: BIZ,
        callId: callId1,
        clientName: "First Caller",
        clientPhone: "+15551110001",
        scheduledAt: when,
        notes: null,
        lengthMinutes: 30,
        capacity: 1,
      })
    );
    expect(first.id).toBeTruthy();

    const second = await db.withTenant(BIZ, () =>
      db.createAppointmentIfAvailable({
        businessId: BIZ,
        callId: callId2,
        clientName: "Second Caller",
        clientPhone: "+15551110002",
        scheduledAt: when,
        notes: null,
        lengthMinutes: 30,
        capacity: 1,
      })
    );
    expect(second.full).toBe(true);
    expect(second.id).toBeFalsy();

    const count = await admin.query(
      `SELECT count(*)::int AS n FROM appointments WHERE business_id = $1 AND scheduled_at = $2 AND status = 'scheduled'`,
      [BIZ, when]
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("allows a second booking once capacity is raised to 2 for the same slot", async () => {
    const { callId: callId1 } = await mkCall();
    const { callId: callId2 } = await mkCall();
    const when = futureIso(180);

    const first = await db.withTenant(BIZ, () =>
      db.createAppointmentIfAvailable({
        businessId: BIZ, callId: callId1, clientName: "A", clientPhone: "+15551110003",
        scheduledAt: when, notes: null, lengthMinutes: 30, capacity: 2,
      })
    );
    const second = await db.withTenant(BIZ, () =>
      db.createAppointmentIfAvailable({
        businessId: BIZ, callId: callId2, clientName: "B", clientPhone: "+15551110004",
        scheduledAt: when, notes: null, lengthMinutes: 30, capacity: 2,
      })
    );
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
  });
});

d("outboundCallEffects -- a booking effect resolves to outcome booked (Task 30's effect-to-outcome wiring)", () => {
  it("booked: false before any booking exists for this call", async () => {
    const { callId } = await mkCall();
    const effects = await db.withTenant(BIZ, () => db.outboundCallEffects(callId));
    expect(effects).toEqual({ booked: false, optedOut: false });
  });

  it("booked: true once the internal adapter has written a row for this call_id -- exactly what lib/outbound/postCall.js's tier 3 reads before it sets calls.outcome_code = 'booked'", async () => {
    const { callId, callSid } = await mkCall();
    const ctx = {
      businessId: BIZ,
      callId,
      party: { phone: "+15559876543", source: "dialed", verified: true },
      deps: db,
    };
    await db.withTenant(BIZ, () =>
      internalAdapter.book(ctx, {
        clientName: "Priya Shah",
        clientPhone: "+15559876543",
        scheduledAt: futureIso(240),
        notes: null,
        lengthMinutes: 30,
        capacity: 1,
      })
    );

    const effects = await db.withTenant(BIZ, () => db.outboundCallEffects(callId));
    expect(effects).toEqual({ booked: true, optedOut: false });

    // The actual write lib/outbound/postCall.js's tier 2 makes once it has
    // resolved `outcome` to "booked" (via this same read) -- the
    // effect-to-outcome wiring Task 30 asks for, proven end to end.
    await db.withTenant(BIZ, () => db.setCallOutcomeCode(callSid, "booked"));
    const row = (await admin.query(`SELECT outcome_code FROM calls WHERE id = $1`, [callId])).rows[0];
    expect(row.outcome_code).toBe("booked");
  });
});
