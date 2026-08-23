import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { fileDegradedVoicemail } from "../../lib/degradedVoicemail.js";

// Ledger O32, the half that was a real defect rather than an audit gap.
//
// The degraded voicemail path wrote `customer_requests` with NO TENANT SCOPE.
// Against the local superuser that works, because RLS is inert for a role with
// rolbypassrls. Against Cloud SQL, where there is no superuser and migration
// 029 uses FORCE row-level security, the INSERT is REFUSED — and
// createCustomerRequest logs, returns null, and the route answers Twilio 200.
// A caller's voicemail would have been nowhere, reported as success.
//
// So this file runs as `vetra_app`, which is the only role that can tell the
// two outcomes apart. It also asserts the §164.312(b) half: one audit row per
// unit of work, which the unscoped version could not write either.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const TENANT = "cccccccc-3333-4333-8333-cccccccccccc";
const CALLER = "+15551239876";
const RECORDING = "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1";

let admin;
let db;

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
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Voicemail Clinic', '+15558880001')`, [
    TENANT,
  ]);
  await admin.query(`DELETE FROM phi_access_log WHERE business_id = $1`, [TENANT]);
});

function deps() {
  return {
    db,
    notifications: {
      MESSAGE_SLA_TEXT: "as soon as possible",
      notifyCustomerRequest: vi.fn(async () => {}),
      sendCallerSms: vi.fn(async () => {}),
    },
    log: { error: vi.fn(), info: vi.fn() },
    captureException: vi.fn(),
  };
}

describeDb("degraded voicemail — files against its tenant as the unprivileged role", () => {
  it("writes the row", async () => {
    const d = deps();
    const id = await fileDegradedVoicemail({
      deps: d,
      business: { id: TENANT },
      callerNumber: CALLER,
      recordingUrl: RECORDING,
      callSid: "CA-vm-1",
    });

    expect(id).toBeTruthy();
    const { rows } = await admin.query(
      `SELECT callback_number, message FROM customer_requests WHERE business_id = $1`,
      [TENANT]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].callback_number).toBe(CALLER);
    // The prefix is the erasure path's index into what Twilio still holds
    // (services/twilioRecordings.js), so the exact string is load-bearing.
    expect(rows[0].message).toBe(`Voicemail recording: ${RECORDING}`);
  });

  it("records ONE audit row for the unit of work", async () => {
    await fileDegradedVoicemail({
      deps: deps(),
      business: { id: TENANT },
      callerNumber: CALLER,
      recordingUrl: RECORDING,
      callSid: "CA-vm-2",
    });

    const { rows } = await admin.query(
      `SELECT action, operations, call_sid, actor_type FROM phi_access_log WHERE business_id = $1`,
      [TENANT]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("write");
    expect(rows[0].operations).toContain("createCustomerRequest");
    // A call SID is the actor on the voice path — it identifies the interaction
    // and resolves to a person only through the database.
    expect(rows[0].actor_type).toBe("voice");
    expect(rows[0].call_sid).toBe("CA-vm-2");
  });

  it("notifies the business once the row has actually landed", async () => {
    const d = deps();
    await fileDegradedVoicemail({
      deps: d,
      business: { id: TENANT },
      callerNumber: CALLER,
      recordingUrl: RECORDING,
    });
    expect(d.notifications.notifyCustomerRequest).toHaveBeenCalledTimes(1);
  });

  // The counterpart, and the one that matters: telling a clinic a message was
  // taken when nothing was stored is the failure this capability has.
  it("notifies nobody when the write is refused", async () => {
    const d = deps();
    const id = await fileDegradedVoicemail({
      deps: d,
      business: { id: "99999999-9999-4999-8999-999999999999" },
      callerNumber: CALLER,
      recordingUrl: RECORDING,
    });

    expect(id).toBeNull();
    expect(d.notifications.notifyCustomerRequest).not.toHaveBeenCalled();
    expect(d.notifications.sendCallerSms).not.toHaveBeenCalled();
  });

  it("does nothing at all without a tenant", async () => {
    const d = deps();
    expect(
      await fileDegradedVoicemail({ deps: d, business: null, callerNumber: CALLER, recordingUrl: RECORDING })
    ).toBeNull();
    expect(d.notifications.notifyCustomerRequest).not.toHaveBeenCalled();
  });
});

describeDb("degraded voicemail — the failure it used to have", () => {
  // The proof that the scope is what makes this work, rather than something
  // else happening to be true. The identical INSERT, unscoped, as the same
  // role: refused. If this test ever passes without erroring, RLS is not
  // applying and every other assertion in this file is worthless.
  it("the same INSERT with no scope is REFUSED for this role", async () => {
    const appClient = new pg.Client({ connectionString: APP_URL });
    await appClient.connect();
    try {
      await expect(
        appClient.query(
          `INSERT INTO customer_requests (business_id, request_type, callback_number, message)
           VALUES ($1, 'message', $2, $3)`,
          [TENANT, CALLER, `Voicemail recording: ${RECORDING}`]
        )
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await appClient.end();
    }
  });
});
