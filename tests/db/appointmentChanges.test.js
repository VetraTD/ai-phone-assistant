// tests/db/appointmentChanges.test.js
/**
 * Booking moves and cancellations, recorded against the call that made them
 * (dashboard overhaul part 2, stage 6; migration 062).
 *
 * The write is ONE statement: the booking changes and its change row is
 * written together, or neither happens. A change row therefore exists only if
 * the booking really changed. Real database, as vetra_app under FORCE
 * row-level security, the same pattern as tests/db/outboundBooking.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ_A = "0d0d0000-0000-4000-8000-0000000062a0";
const BIZ_B = "0d0d0000-0000-4000-8000-0000000062b0";
const T0 = "2026-12-02T15:00:00.000Z";
const T1 = "2026-12-03T16:30:00.000Z";
const T2 = "2026-12-04T09:00:00.000Z";

let admin, app, db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await app?.end().catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BIZ_A, BIZ_B]).catch(() => {});
  await admin.query(`DELETE FROM phi_access_log WHERE business_id IN ($1, $2)`, [BIZ_A, BIZ_B]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BIZ_A, BIZ_B]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Changes Probe A'), ($2, 'Changes Probe B')`, [BIZ_A, BIZ_B]);
});

let sidSeq = 0;
async function mkCall(biz) {
  sidSeq += 1;
  const r = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, direction) VALUES ($1, $2, 'inbound') RETURNING id`,
    [biz, `CAchanges${Date.now()}${sidSeq}`]
  );
  return r.rows[0].id;
}

async function mkBooking(biz, at = T0, callId = null) {
  const r = await admin.query(
    `INSERT INTO appointments (business_id, call_id, client_name, scheduled_at) VALUES ($1, $2, 'Sample Caller', $3) RETURNING id`,
    [biz, callId, at]
  );
  return r.rows[0].id;
}

const changes = async (appointmentId) =>
  (
    await admin.query(
      `SELECT business_id, call_id, kind, old_scheduled_at, new_scheduled_at
         FROM appointment_changes WHERE appointment_id = $1 ORDER BY created_at, id`,
      [appointmentId]
    )
  ).rows.map((r) => ({
    ...r,
    old_scheduled_at: r.old_scheduled_at.toISOString(),
    new_scheduled_at: r.new_scheduled_at ? r.new_scheduled_at.toISOString() : null,
  }));

const booking = async (id) =>
  (await admin.query(`SELECT scheduled_at, status FROM appointments WHERE id = $1`, [id])).rows[0];

d("appointment_changes: moves and cancellations recorded against the call", () => {
  it("a move records the old and new time against the call", async () => {
    const call = await mkCall(BIZ_A);
    const id = await mkBooking(BIZ_A, T0, call);
    const res = await db.withTenant(BIZ_A, () => db.rescheduleAppointmentRecorded(id, T1, BIZ_A, call));
    expect(res).toEqual({ found: true, recorded: true });
    expect((await booking(id)).scheduled_at.toISOString()).toBe(T1);
    expect(await changes(id)).toEqual([
      { business_id: BIZ_A, call_id: call, kind: "moved", old_scheduled_at: T0, new_scheduled_at: T1 },
    ]);
  });

  it("a cancel records the old time once; cancelling again records nothing", async () => {
    const call = await mkCall(BIZ_A);
    const id = await mkBooking(BIZ_A, T0, call);
    expect(await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(id, BIZ_A, call))).toEqual({ found: true, recorded: true });
    expect((await booking(id)).status).toBe("cancelled");
    // Found, but nothing changed: the caller can be told it is cancelled, and
    // the owner is not emailed about it again.
    expect(await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(id, BIZ_A, call))).toEqual({ found: true, recorded: false });
    expect(await changes(id)).toEqual([
      { business_id: BIZ_A, call_id: call, kind: "cancelled", old_scheduled_at: T0, new_scheduled_at: null },
    ]);
  });

  it("moved then cancelled on one call leaves two rows in order", async () => {
    const call = await mkCall(BIZ_A);
    const id = await mkBooking(BIZ_A, T0, call);
    await db.withTenant(BIZ_A, () => db.rescheduleAppointmentRecorded(id, T1, BIZ_A, call));
    await db.withTenant(BIZ_A, () => db.rescheduleAppointmentRecorded(id, T2, BIZ_A, call));
    await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(id, BIZ_A, call));
    expect((await changes(id)).map((c) => [c.kind, c.old_scheduled_at, c.new_scheduled_at])).toEqual([
      ["moved", T0, T1],
      ["moved", T1, T2],
      ["cancelled", T2, null],
    ]);
  });

  it("a move to the time a booking already has changes nothing and records nothing", async () => {
    const id = await mkBooking(BIZ_A, T0);
    expect(await db.withTenant(BIZ_A, () => db.rescheduleAppointmentRecorded(id, T0, BIZ_A, null))).toEqual({ found: true, recorded: false });
    expect(await changes(id)).toEqual([]);
  });

  it("outside a tenant scope even a named business changes nothing", async () => {
    const id = await mkBooking(BIZ_A, T0);
    expect(await db.cancelAppointmentRecorded(id, BIZ_A, null)).toEqual({ found: false, recorded: false });
    expect((await booking(id)).status).toBe("scheduled");
    expect(await changes(id)).toEqual([]);
  });

  it("a change made outside a call (a script) is recorded with no call", async () => {
    const id = await mkBooking(BIZ_A);
    expect(await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(id, BIZ_A, null))).toEqual({ found: true, recorded: true });
    expect((await changes(id))[0].call_id).toBeNull();
  });

  it("another business's booking is neither changed nor recorded", async () => {
    const call = await mkCall(BIZ_A);
    const theirs = await mkBooking(BIZ_B, T0);
    expect(await db.withTenant(BIZ_A, () => db.rescheduleAppointmentRecorded(theirs, T1, BIZ_A, call))).toEqual({ found: false, recorded: false });
    expect(await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(theirs, BIZ_A, call))).toEqual({ found: false, recorded: false });
    const row = await booking(theirs);
    expect(row.scheduled_at.toISOString()).toBe(T0);
    expect(row.status).toBe("scheduled");
    expect(await changes(theirs)).toEqual([]);
  });

  it("an unknown booking writes no change row", async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM appointment_changes WHERE business_id = $1`, [BIZ_A])).rows[0].n;
    const unknown = "0d0d0000-0000-4000-8000-00000000dead";
    expect(await db.withTenant(BIZ_A, () => db.rescheduleAppointmentRecorded(unknown, T1, BIZ_A, null))).toEqual({ found: false, recorded: false });
    expect(await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(unknown, BIZ_A, null))).toEqual({ found: false, recorded: false });
    const after = (await admin.query(`SELECT count(*)::int AS n FROM appointment_changes WHERE business_id = $1`, [BIZ_A])).rows[0].n;
    expect(after).toBe(before);
  });

  it("business B cannot read business A's changes", async () => {
    const id = await mkBooking(BIZ_A);
    await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(id, BIZ_A, null));
    const countAs = async (biz) => {
      await app.query("BEGIN");
      try {
        await app.query(`SELECT set_config('app.business_id', $1, true)`, [biz]);
        return (await app.query(`SELECT count(*)::int AS n FROM appointment_changes WHERE appointment_id = $1`, [id])).rows[0].n;
      } finally {
        await app.query("COMMIT");
      }
    };
    expect(await countAs(BIZ_A)).toBe(1);
    expect(await countAs(BIZ_B)).toBe(0);
  });

  it("the app role can only add to the change log, never edit or delete it", async () => {
    const id = await mkBooking(BIZ_A);
    await db.withTenant(BIZ_A, () => db.cancelAppointmentRecorded(id, BIZ_A, null));
    for (const sql of [
      `UPDATE appointment_changes SET kind = 'moved' WHERE appointment_id = $1`,
      `DELETE FROM appointment_changes WHERE appointment_id = $1`,
    ]) {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.business_id', $1, true)`, [BIZ_A]);
      await expect(app.query(sql, [id])).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
    }
    expect(await changes(id)).toHaveLength(1);
  });

  it("refuses to run unscoped", async () => {
    const id = await mkBooking(BIZ_A);
    expect(await db.rescheduleAppointmentRecorded(id, T1, null, null)).toEqual({ found: false, recorded: false });
    expect(await db.cancelAppointmentRecorded(id, undefined, null)).toEqual({ found: false, recorded: false });
    const row = await booking(id);
    expect(row.scheduled_at.toISOString()).toBe(T0);
    expect(row.status).toBe("scheduled");
    expect(await changes(id)).toEqual([]);
  });
});
