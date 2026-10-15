// tests/db/customerRequestCorrection.test.js
/**
 * Round A1 S3 (I3) against real Postgres, as the role production runs as.
 *
 * A same-call correction is an UPDATE of a customer_requests row
 * (lib/capabilities/customerRequests.js). Under FORCE row-level security an
 * UPDATE that runs outside its tenant's scope matches no row and reports no
 * error -- the correction would vanish while the caller hears it was passed
 * on. The root suites fake the db, so this file is where the write is proven:
 * vetra_app (NOBYPASSRLS), real SQL, row values read back by the admin.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const TENANT = "a1a1a1a1-cccc-4ccc-8ccc-a1a1a1a1a1a1";
const OTHER = "a1a1a1a1-dddd-4ddd-8ddd-a1a1a1a1a1a1";

let admin;
let db;
let saveCustomerRequest;
let callId;
let otherCallId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
  ({ saveCustomerRequest } = await import("../../lib/capabilities/customerRequests.js"));
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT, OTHER]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT, OTHER]);
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'S3 Clinic', '+15558880301'), ($2, 'S3 Other', '+15558880302')`,
    [TENANT, OTHER]
  );
  ({ rows: [{ id: callId }] } = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number) VALUES ($1, 'CA_s3_db_1', '+15559870001') RETURNING id`,
    [TENANT]
  ));
  ({ rows: [{ id: otherCallId }] } = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number) VALUES ($1, 'CA_s3_db_2', '+15559870002') RETURNING id`,
    [TENANT]
  ));
});

const rowsOf = async (cid) =>
  (
    await admin.query(
      `SELECT request_type, caller_name, callback_number, message FROM customer_requests WHERE call_id = $1 ORDER BY created_at`,
      [cid]
    )
  ).rows;

const MESSAGE = {
  requestType: "message",
  callerName: "Jon",
  callbackNumber: "214 555 0123",
  message: "about the invoice",
  preferredTime: null,
};

describeDb("a same-call correction as vetra_app (I3)", () => {
  it("a correction updates the row in place: one row, the corrected number, the rest kept", async () => {
    const first = await saveCustomerRequest({ db, businessId: TENANT, callId, row: MESSAGE });
    expect(first).toEqual({ id: expect.any(String), corrected: false });

    // A re-record that names only the fixed number must not blank the message.
    const second = await saveCustomerRequest({
      db,
      businessId: TENANT,
      callId,
      row: { ...MESSAGE, callbackNumber: "214 555 0124", message: null },
    });
    expect(second).toEqual({ id: first.id, corrected: true });

    expect(await rowsOf(callId)).toEqual([
      { request_type: "message", caller_name: "Jon", callback_number: "214 555 0124", message: "about the invoice" },
    ]);
  });

  it("a different reason, a different request type, or another call files its own row", async () => {
    await saveCustomerRequest({ db, businessId: TENANT, callId, row: MESSAGE });
    await saveCustomerRequest({ db, businessId: TENANT, callId, row: { ...MESSAGE, message: "running late for Thursday" } });
    await saveCustomerRequest({ db, businessId: TENANT, callId, row: { ...MESSAGE, requestType: "quote" } });
    await saveCustomerRequest({ db, businessId: TENANT, callId: otherCallId, row: MESSAGE });

    expect((await rowsOf(callId)).map((r) => r.request_type).sort()).toEqual(["message", "message", "quote"]);
    expect(await rowsOf(otherCallId)).toHaveLength(1);
  });

  it("lists only this call's rows of this type, newest first", async () => {
    await saveCustomerRequest({ db, businessId: TENANT, callId, row: MESSAGE });
    await saveCustomerRequest({ db, businessId: TENANT, callId, row: { ...MESSAGE, message: "running late for Thursday" } });
    await saveCustomerRequest({ db, businessId: TENANT, callId, row: { ...MESSAGE, requestType: "quote" } });

    const listed = await db.withTenant(TENANT, () => db.listCallCustomerRequests(callId, TENANT, "message"));
    expect(listed.map((r) => r.message)).toEqual(["running late for Thursday", "about the invoice"]);
  });

  it("another tenant's scope can neither see nor correct the row", async () => {
    const { id } = await saveCustomerRequest({ db, businessId: TENANT, callId, row: MESSAGE });

    const listed = await db.withTenant(OTHER, () => db.listCallCustomerRequests(callId, OTHER, "message"));
    expect(listed).toEqual([]);
    // Claiming the right business in the WHERE does not help: the scope is OTHER's.
    const spoofed = await db.withTenant(OTHER, () =>
      db.updateCustomerRequest({ id, businessId: TENANT, callbackNumber: "000 000 0000" })
    );
    expect(spoofed).toBeNull();

    expect((await rowsOf(callId))[0].callback_number).toBe("214 555 0123");
  });

  it("an unscoped update changes nothing and says so", async () => {
    const { id } = await saveCustomerRequest({ db, businessId: TENANT, callId, row: MESSAGE });

    // No withTenant: under FORCE RLS this matches zero rows. The null is the
    // only evidence; the helper then files the correction as new, never drops it.
    const unscoped = await db.updateCustomerRequest({ id, businessId: TENANT, callbackNumber: "000 000 0000" });
    expect(unscoped).toBeNull();
    expect((await rowsOf(callId))[0].callback_number).toBe("214 555 0123");
  });
});
