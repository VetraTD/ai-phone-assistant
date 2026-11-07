// tests/db/customerRequestDetails.test.js
/**
 * Migration 059 against real Postgres, as the role production runs as.
 *
 * customer_requests gains `details` (the answers a caller gave) and
 * `owner_notice_pending` (a row the call-end hook has not yet told the owner
 * about). The claim is one UPDATE; under FORCE row-level security an unscoped
 * UPDATE matches no row and reports no error, so every claim and release here
 * runs inside db.withTenant as vetra_app, and the admin client reads the
 * result back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const TENANT = "5e1f0a2b-7c3d-4e5f-8a9b-0c1d2e3f4a51";
const OTHER = "5e1f0a2b-7c3d-4e5f-8a9b-0c1d2e3f4a52";
const CALLER = "+15557770511";
const OTHER_CALLER = "+15557770512";
const SID_A = "CA_cr_details_a";
const SID_B = "CA_cr_details_b";

const DETAILS = {
  callerType: "new",
  answers: [
    { label: "Reason for call", answer: "a quote for gutters" },
    { label: "Best time", answer: "mornings" },
  ],
};

let admin;
let db;
let callA;
let callB;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
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
    `INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Details Clinic', '+15558880511'), ($2, 'Details Other', '+15558880512')`,
    [TENANT, OTHER]
  );
  ({ rows: [{ id: callA }] } = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number) VALUES ($1, $2, $3) RETURNING id`,
    [TENANT, SID_A, CALLER]
  ));
  ({ rows: [{ id: callB }] } = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number) VALUES ($1, $2, $3) RETURNING id`,
    [TENANT, SID_B, OTHER_CALLER]
  ));
});

/** A row filed on one call, pending or not, optionally back-dated. */
async function file({ callId = callA, pending = true, details = DETAILS, phone = null, businessId = TENANT, ageMinutes = 0 } = {}) {
  const id = await db.withTenant(businessId, () =>
    db.createCustomerRequest({
      businessId,
      callId,
      requestType: "message",
      callerName: "Jon",
      callbackNumber: phone,
      message: "about the gutters",
      details,
      ownerNoticePending: pending,
    })
  );
  if (ageMinutes) {
    await admin.query(`UPDATE customer_requests SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [
      id,
      ageMinutes,
    ]);
  }
  return id;
}

const stored = async (id) =>
  (await admin.query(`SELECT details, owner_notice_pending FROM customer_requests WHERE id = $1`, [id])).rows[0];

const claim = (businessId, callSid) => db.withTenant(businessId, () => db.claimOwnerNotices({ businessId, callSid }));

describeDb("customer request details and pending owner notices — as vetra_app", () => {
  it("claims a pending row for this call once", async () => {
    const id = await file({ callId: callA });

    const first = await claim(TENANT, SID_A);
    expect(first.map((r) => r.id)).toEqual([id]);
    expect(first[0]).toEqual(
      expect.objectContaining({
        call_id: callA,
        request_type: "message",
        caller_name: "Jon",
        message: "about the gutters",
        details: DETAILS,
        caller_number: CALLER,
        twilio_call_sid: SID_A,
      })
    );
    expect(await claim(TENANT, SID_A)).toEqual([]);
    expect((await stored(id)).owner_notice_pending).toBe(false);
  });

  it("leaves a younger pending row from another call alone", async () => {
    await file({ callId: callB });

    expect(await claim(TENANT, SID_A)).toEqual([]);
  });

  it("claims a pending row from another call once it is older than 15 minutes", async () => {
    const id = await file({ callId: callB, ageMinutes: 16 });

    const got = await claim(TENANT, SID_A);
    expect(got.map((r) => r.id)).toEqual([id]);
    expect((await stored(id)).owner_notice_pending).toBe(false);
  });

  it("does not claim a row whose owner_notice_pending is false", async () => {
    const id = await file({ callId: callA, pending: false });

    expect(await claim(TENANT, SID_A)).toEqual([]);
    expect((await stored(id)).owner_notice_pending).toBe(false);
  });

  it("release makes a row claimable again", async () => {
    const id = await file({ callId: callA });
    const [got] = await claim(TENANT, SID_A);
    expect(got.id).toBe(id);

    const released = await db.withTenant(TENANT, () => db.releaseOwnerNotices({ businessId: TENANT, ids: [id] }));
    expect(released).toBe(1);
    expect((await stored(id)).owner_notice_pending).toBe(true);

    expect((await claim(TENANT, SID_A)).map((r) => r.id)).toEqual([id]);
  });

  it("claim is tenant scoped", async () => {
    const id = await file({ callId: callA });

    // Claiming as the other tenant, naming the other tenant, finds nothing.
    expect(await claim(OTHER, SID_A)).toEqual([]);
    // Naming the right business while scoped to the other one is still nothing.
    expect(await db.withTenant(OTHER, () => db.claimOwnerNotices({ businessId: TENANT, callSid: SID_A }))).toEqual([]);

    expect((await stored(id)).owner_notice_pending).toBe(true);
  });

  it("eraseCallerData nulls details", async () => {
    const id = await file({ callId: callA, phone: CALLER });

    await db.withTenant(TENANT, () => db.eraseCallerData(TENANT, CALLER));

    expect((await stored(id)).details).toBeNull();
  });

  it("exportCallerData returns details", async () => {
    await file({ callId: callA, phone: CALLER });

    const data = await db.withTenant(TENANT, () => db.exportCallerData(TENANT, CALLER));
    expect(data.customerRequests).toHaveLength(1);
    expect(data.customerRequests[0].details).toEqual(DETAILS);
  });

  it("an update without details keeps the stored details", async () => {
    const id = await file({ callId: callA });

    const updated = await db.withTenant(TENANT, () =>
      db.updateCustomerRequest({ id, businessId: TENANT, message: "a corrected message" })
    );
    expect(updated).toBe(id);
    expect((await stored(id)).details).toEqual(DETAILS);
  });

  it("an empty details object does not overwrite the stored details", async () => {
    const id = await file({ callId: callA });

    await db.withTenant(TENANT, () =>
      db.updateCustomerRequest({ id, businessId: TENANT, message: "a corrected message", details: { answers: [] } })
    );
    expect((await stored(id)).details).toEqual(DETAILS);
  });
});
