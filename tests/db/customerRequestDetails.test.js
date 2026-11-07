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
 *
 * Migration 060 makes the claim a lease: it stamps `owner_notice_claimed_at`
 * and leaves the row pending until completeOwnerNotices, so an instance that
 * dies between the claim and the send leaves a row the next call can take
 * once the lease runs out, instead of a row nobody will ever email.
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
  (
    await admin.query(
      `SELECT details, owner_notice_pending, owner_notice_claimed_at,
              owner_notice_claimed_at > now() - interval '1 minute' AS claimed_just_now
         FROM customer_requests WHERE id = $1`,
      [id]
    )
  ).rows[0];

const claim = (businessId, callSid) => db.withTenant(businessId, () => db.claimOwnerNotices({ businessId, callSid }));
const complete = (businessId, ids) => db.withTenant(businessId, () => db.completeOwnerNotices({ businessId, ids }));

/** Back-date a row's lease and its age, as the admin (superuser) client. */
async function backdate(id, { claimedMinutes = null, createdMinutes = null }) {
  if (claimedMinutes != null) {
    await admin.query(
      `UPDATE customer_requests SET owner_notice_claimed_at = now() - make_interval(mins => $2) WHERE id = $1`,
      [id, claimedMinutes]
    );
  }
  if (createdMinutes != null) {
    await admin.query(`UPDATE customer_requests SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [
      id,
      createdMinutes,
    ]);
  }
}

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
    // 060: a claim is a lease, not a delete. The row stays pending until the
    // send is completed; the lease is what keeps the second claim out.
    expect(await stored(id)).toEqual(expect.objectContaining({ owner_notice_pending: true, claimed_just_now: true }));
  });

  it("leaves a younger pending row from another call alone", async () => {
    await file({ callId: callB });

    expect(await claim(TENANT, SID_A)).toEqual([]);
  });

  it("claims a pending row from another call once it is older than 15 minutes", async () => {
    const id = await file({ callId: callB, ageMinutes: 16 });

    const got = await claim(TENANT, SID_A);
    expect(got.map((r) => r.id)).toEqual([id]);
    expect(await stored(id)).toEqual(expect.objectContaining({ owner_notice_pending: true, claimed_just_now: true }));
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
    // 060: release clears the lease, so the row is free at once, not in 2 minutes.
    expect(await stored(id)).toEqual(expect.objectContaining({ owner_notice_pending: true, owner_notice_claimed_at: null }));

    const again = await claim(TENANT, SID_A);
    expect(again.map((r) => r.id)).toEqual([id]);
    // A released row is not a lease that ran out.
    expect(again[0].reclaimed).toBe(false);
  });

  it("claim is tenant scoped", async () => {
    const id = await file({ callId: callA });

    // Claiming as the other tenant, naming the other tenant, finds nothing.
    expect(await claim(OTHER, SID_A)).toEqual([]);
    // Naming the right business while scoped to the other one is still nothing.
    expect(await db.withTenant(OTHER, () => db.claimOwnerNotices({ businessId: TENANT, callSid: SID_A }))).toEqual([]);

    expect(await stored(id)).toEqual(expect.objectContaining({ owner_notice_pending: true, owner_notice_claimed_at: null }));
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

describeDb("owner notice lease (migration 060) — as vetra_app", () => {
  it("a second claim inside the lease gets nothing, even from the 15-minute sweep", async () => {
    const id = await file({ callId: callA });

    const first = await claim(TENANT, SID_A);
    expect(first.map((r) => r.id)).toEqual([id]);
    expect(first[0].reclaimed).toBe(false);

    // Twilio retrying the same callback, inside the lease.
    expect(await claim(TENANT, SID_A)).toEqual([]);
    // Another call's sweep: the row is old enough, but its lease is live.
    await backdate(id, { claimedMinutes: 1, createdMinutes: 16 });
    expect(await claim(TENANT, SID_B)).toEqual([]);
    expect((await stored(id)).owner_notice_pending).toBe(true);
  });

  it("an expired lease is claimed by the business's next call, and says it was reclaimed", async () => {
    const id = await file({ callId: callA });
    expect((await claim(TENANT, SID_A)).map((r) => r.id)).toEqual([id]);

    // The instance that claimed it died: no send, no release, no complete.
    await backdate(id, { claimedMinutes: 3, createdMinutes: 16 });

    const got = await claim(TENANT, SID_B);
    expect(got.map((r) => r.id)).toEqual([id]);
    expect(got[0].reclaimed).toBe(true);
    expect(await stored(id)).toEqual(expect.objectContaining({ owner_notice_pending: true, claimed_just_now: true }));
  });

  it("a completed row is never claimed again", async () => {
    const id = await file({ callId: callA });
    expect((await claim(TENANT, SID_A)).map((r) => r.id)).toEqual([id]);

    expect(await complete(TENANT, [id])).toBe(1);
    expect(await stored(id)).toEqual(expect.objectContaining({ owner_notice_pending: false, owner_notice_claimed_at: null }));

    await backdate(id, { createdMinutes: 16 });
    expect(await claim(TENANT, SID_A)).toEqual([]);
    expect(await claim(TENANT, SID_B)).toEqual([]);
  });

  it("complete is scoped by business and refuses an unscoped call", async () => {
    const id = await file({ callId: callA });
    expect((await claim(TENANT, SID_A)).map((r) => r.id)).toEqual([id]);

    expect(await db.completeOwnerNotices({ businessId: null, ids: [id] })).toBe(0);
    expect(await db.withTenant(OTHER, () => db.completeOwnerNotices({ businessId: TENANT, ids: [id] }))).toBe(0);
    expect(await complete(OTHER, [id])).toBe(0);
    expect(await complete(TENANT, [])).toBe(0);

    expect(await stored(id)).toEqual(expect.objectContaining({ owner_notice_pending: true, claimed_just_now: true }));
  });

  it("a claim that waited on another claim's row lock re-checks the lease and gets nothing", async () => {
    // Two status callbacks for one call. The first has stamped the lease but
    // not committed; the second's UPDATE reads the old row in its snapshot,
    // blocks on the row lock, and after the commit must re-check the lease on
    // the row as it now stands. A lease tested only in a snapshot (a CTE or a
    // sub-select) would pass the second claim through and send twice.
    const id = await file({ callId: callA });
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`UPDATE customer_requests SET owner_notice_claimed_at = now() WHERE id = $1`, [id]);

      const racing = claim(TENANT, SID_A);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        ({
          rows: [{ waiting }],
        } = await admin.query(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%owner_notice_claimed_at%' AND pid <> pg_backend_pid()`
        ));
      }
      expect(waiting, "the second claim never reached the row lock").toBe(1);

      await holder.query("COMMIT");
      expect(await racing).toEqual([]);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  });
});
