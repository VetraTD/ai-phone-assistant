import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { postCallMode, verifyCall } from "../lib/postCallVerify.js";

// ---------------------------------------------------------------------------
// LVX29. The model is the voice, so nothing can stop it saying a sentence.
// What CAN be stopped is the sentence outliving the call: the confirmation is
// built from the appointment ROW, and a call that wrote no row sends nothing.
//
// The assertions that matter here are the negative ones. A module that texted
// on every call would pass most of this file; the tests that separate it from
// one that actually reads the database are `claim_without_row` sending
// nothing, and the reschedule case where the ROW time and the CLAIMED time
// disagree and the row wins.
// ---------------------------------------------------------------------------

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const CALL_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const CONFIG = {
  businessId: BUSINESS_ID,
  businessName: "Digile Media",
  timezone: "Europe/London",
  locale: "en-GB",
  smsFollowupEnabled: true,
};

const row = (over = {}) => ({
  id: "row-1",
  client_name: "Marcus Bell",
  client_phone: "+447700900123",
  scheduled_at: "2026-09-07T09:00:00.000Z",
  status: "scheduled",
  notes: null,
  ...over,
});

function fakeDeps({
  booked = [],
  byId = {},
  throws = false,
  readFails = false,
  requestId = "req-1",
} = {}) {
  const notifications = {
    sendCallerSms: vi.fn(async () => {}),
    notifyUnconfirmedClaim: vi.fn(async () => {}),
  };
  const db = {
    isEnabled: () => true,
    // LVX97's reconciliation. `requestId: null` is the RLS failure mode made
    // reachable: the service runs as vetra_app NOBYPASSRLS, so an unscoped
    // insert matches no policy, writes nothing and reports success.
    createCustomerRequest: vi.fn(async () => requestId),
    // Mirrors the real withTenantSafe, which CATCHES and returns the fallback
    // (services/db.js:2239). A fake that rethrows would hide the exact bug this
    // module has to survive.
    withTenantSafe: async (_businessId, fn, { fallback = null } = {}) => {
      try {
        return await fn();
      } catch {
        return fallback;
      }
    },
    listAppointmentsByCallId: vi.fn(async () => {
      if (throws) throw new Error("db down");
      return readFails ? null : booked;
    }),
    getAppointmentById: vi.fn(async (id) => byId[id] || null),
  };
  const log = { info: vi.fn(), error: vi.fn() };
  return { db, notifications, log };
}

const input = (over = {}) => ({
  businessId: BUSINESS_ID,
  callId: CALL_ID,
  config: CONFIG,
  callerNumber: "+447700900123",
  writes: [],
  claims: [],
  mode: "send",
  ...over,
});

// ---------------------------------------------------------------------------
// THE CLOCK IS FROZEN. See tests/whichAppointment.test.js for what happens
// otherwise: its fixture held an appointment at 15:00Z on 5 September 2026, and
// at 15:00Z on 5 September 2026 that row stopped being "upcoming". Ten tests
// went red mid-session on a change that touched nothing they import.
//
// Every file carrying a hard-coded date near today has the same shape, so they
// all get the same guard rather than waiting to find out one at a time. Friday
// 4 September 2026 sits before every fixture date in this repository.
// ---------------------------------------------------------------------------
const FROZEN_NOW = new Date("2026-09-04T12:00:00Z");

beforeAll(() => {
  // shouldAdvanceTime, NOT a bare useFakeTimers(). Several of these files settle
  // async work with a real setTimeout, and a frozen timer queue never fires it:
  // the run hangs rather than failing, which is the worst way for a test to be
  // wrong. This pins the DATE while leaving timers working.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});


describe("postCallMode", () => {
  it("is off unless explicitly asked for", () => {
    expect(postCallMode({})).toBe("off");
    expect(postCallMode({ POSTCALL_VERIFY: "" })).toBe("off");
    expect(postCallMode({ POSTCALL_VERIFY: "yes" })).toBe("off");
  });

  it("reads the two live modes", () => {
    expect(postCallMode({ POSTCALL_VERIFY: "count" })).toBe("count");
    expect(postCallMode({ POSTCALL_VERIFY: "SEND" })).toBe("send");
  });
});

describe("verifyCall - a note is a change, but not one to text anybody about", () => {
  // A REGRESSION INTRODUCED BY add_appointment_note, 2026-09-05, caught by
  // reading the first real call rather than by a test.
  //
  // The note tool emits {type:"changed"}, because the row genuinely did change.
  // That is correct for counting. It is wrong for CONFIRMING: changedRows feeds
  // `confirmable`, so a caller who merely annotated an existing appointment
  // became eligible for an "appointment_confirmation" text about a booking that
  // did not move.
  //
  // Latent rather than observed: the verification call ran POSTCALL_VERIFY=count
  // so nothing was sent, and the note happened to land on the row booked in the
  // same call, where the id collision hid it anyway. Neither of those is a
  // property of the design.
  beforeEach(() => clearStats());

  it("does not text a caller who only added a note to an existing appointment", async () => {
    const existing = row({ id: "row-old", notes: "Strategy Call \u2014 in renewables" });
    const deps = fakeDeps({ booked: [], byId: { "row-old": existing } });

    const out = await verifyCall(
      input({
        writes: [{ type: "changed", tool: "add_appointment_note", appointmentId: "row-old" }],
      }),
      deps
    );

    expect(deps.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(out.sent).toHaveLength(0);
    // Still COUNTED as a changed row: the row did change, and a counter that
    // lied about that would be the opposite mistake.
    expect(getLatencyStats().turnTaking.postcall_changed_rows).toBe(1);
  });

  it("still texts when the appointment really moved and was also noted", async () => {
    // The note must not SUPPRESS a confirmation either. A reschedule plus a note
    // on the same row is a real change the caller should hear about.
    const moved = row({ id: "row-old", scheduled_at: "2026-09-08T09:00:00.000Z" });
    const deps = fakeDeps({ booked: [], byId: { "row-old": moved } });

    await verifyCall(
      input({
        writes: [
          { type: "changed", tool: "reschedule_appointment_db", appointmentId: "row-old" },
          { type: "changed", tool: "add_appointment_note", appointmentId: "row-old" },
        ],
      }),
      deps
    );

    expect(deps.notifications.sendCallerSms).toHaveBeenCalledTimes(1);
  });
});

describe("verifyCall - the fabrication case", () => {
  beforeEach(() => clearStats());

  it("sends NOTHING when the assistant claimed a booking and no row exists", async () => {
    const deps = fakeDeps({ booked: [] });
    const out = await verifyCall(input({ claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(out.verdict).toBe("claim_without_row");
    expect(deps.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.postcall_claim_without_row).toBe(1);
  });

  // -------------------------------------------------------------------------
  // LVX97. THE FABRICATION REACHES A HUMAN, WITHOUT THE MODEL'S COOPERATION.
  //
  // The claim note works by asking, and asking is not reliable: on 2026-09-09
  // the same tenant, same config and same tools produced a retracted claim and
  // a real booking on one call, and a fabricated consultation denied to the
  // caller's face on another. This path does not consult the model at all --
  // it compares what the call said against what the database holds and writes
  // the disagreement down.
  // -------------------------------------------------------------------------
  it("writes a row and notifies the business when a claim has no record behind it", async () => {
    const deps = fakeDeps({ booked: [] });

    await verifyCall(input({ claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(deps.db.createCustomerRequest).toHaveBeenCalledTimes(1);
    const written = deps.db.createCustomerRequest.mock.calls[0][0];
    expect(written.requestType).toBe("unconfirmed_claim");
    expect(written.callId).toBe(CALL_ID);
    // No caller speech in the row. LVX24 was a sanitizer logging the text it
    // caught, and the sentence that triggered this carries the caller's name
    // and their appointment time.
    expect(written.message).toBeUndefined();
    expect(deps.notifications.notifyUnconfirmedClaim).toHaveBeenCalledTimes(1);
    expect(getLatencyStats().turnTaking.postcall_claim_reconciled).toBe(1);
  });

  it("reconciles regardless of mode, because this one goes to the business", async () => {
    // `send` governs messages to the CALLER. Telling a caller their booking may
    // have been imagined is not something to do automatically; telling the
    // business is the entire point.
    const deps = fakeDeps({ booked: [] });

    await verifyCall(input({ mode: "verify", claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(deps.db.createCustomerRequest).toHaveBeenCalledTimes(1);
    expect(getLatencyStats().turnTaking.postcall_claim_reconciled).toBe(1);
  });

  it("counts an insert that wrote nothing as a FAILURE, not as nothing to report", async () => {
    // The RLS failure mode: a tenantless write matches zero rows and returns
    // success. A reconciliation that silently did not happen must not read the
    // same as a call with nothing to reconcile.
    const deps = fakeDeps({ booked: [], requestId: null });

    await verifyCall(input({ claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(getLatencyStats().turnTaking.postcall_claim_reconcile_failed).toBe(1);
    expect(getLatencyStats().turnTaking.postcall_claim_reconciled).toBeFalsy();
    expect(deps.notifications.notifyUnconfirmedClaim).not.toHaveBeenCalled();
  });

  it("does not reconcile a clean call", async () => {
    // The control. A reconciliation that fired on every call would pass every
    // assertion above and tell the business nothing worth reading.
    const deps = fakeDeps({ booked: [row()] });

    await verifyCall(input({ claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(deps.db.createCustomerRequest).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.postcall_claim_reconciled).toBeFalsy();
  });

  it("counts a booked effect whose row is not in the database", async () => {
    const deps = fakeDeps({ booked: [] });
    const out = await verifyCall(
      input({ writes: [{ type: "booked" }], claims: [{ turn: 4, kind: "claim" }] }),
      deps
    );

    expect(out.verdict).toBe("row_mismatch");
    expect(deps.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.postcall_row_mismatch).toBe(1);
  });
});

describe("verifyCall - confirming from the row", () => {
  beforeEach(() => clearStats());

  it("texts the caller using the ROW, and marks it transactional", async () => {
    const deps = fakeDeps({ booked: [row()] });
    const out = await verifyCall(input({ writes: [{ type: "booked" }] }), deps);

    expect(out.verdict).toBe("row_without_claim");
    expect(deps.notifications.sendCallerSms).toHaveBeenCalledTimes(1);
    const [cfg, to, kind, vars, opts] = deps.notifications.sendCallerSms.mock.calls[0];
    expect(cfg).toBe(CONFIG);
    expect(to).toBe("+447700900123");
    expect(kind).toBe("appointment_confirmation");
    expect(vars.name).toBe("Marcus Bell");
    expect(vars.business).toBe("Digile Media");
    expect(vars.datetime).toMatch(/September/);
    expect(opts).toEqual({ transactional: true });
    expect(getLatencyStats().turnTaking.postcall_confirm_sent).toBe(1);
  });

  it("reads the row's number, not the number the caller rang from", async () => {
    const deps = fakeDeps({ booked: [row({ client_phone: "+447426704500" })] });
    await verifyCall(input({ callerNumber: "+15551234567" }), deps);

    expect(deps.notifications.sendCallerSms.mock.calls[0][1]).toBe("+447426704500");
  });

  it("does not fall back to caller ID when the row has no usable number", async () => {
    const deps = fakeDeps({ booked: [row({ client_phone: null })] });
    const out = await verifyCall(input(), deps);

    expect(deps.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe("no_phone");
    expect(getLatencyStats().turnTaking.postcall_confirm_skipped_no_phone).toBe(1);
  });

  it("confirms a cancellation from the row's status", async () => {
    const deps = fakeDeps({ byId: { "row-9": row({ id: "row-9", status: "cancelled" }) } });
    await verifyCall(
      input({ writes: [{ type: "changed", tool: "cancel_appointment_db", appointmentId: "row-9" }] }),
      deps
    );

    expect(deps.notifications.sendCallerSms.mock.calls[0][2]).toBe("appointment_cancelled");
  });

  it("confirms a reschedule at the ROW's time, not the time that was claimed", async () => {
    const deps = fakeDeps({
      byId: { "row-9": row({ id: "row-9", scheduled_at: "2026-09-08T14:00:00.000Z" }) },
    });
    await verifyCall(
      input({
        writes: [{ type: "changed", tool: "reschedule_appointment_db", appointmentId: "row-9" }],
        claims: [{ turn: 6, kind: "claim" }],
      }),
      deps
    );

    const [, , kind, vars] = deps.notifications.sendCallerSms.mock.calls[0];
    expect(kind).toBe("appointment_confirmation");
    expect(vars.datetime).toMatch(/8/);
  });

  it("sends one message when a call books and then reschedules the same row", async () => {
    const moved = row({ scheduled_at: "2026-09-08T14:00:00.000Z" });
    const deps = fakeDeps({ booked: [row()], byId: { "row-1": moved } });
    await verifyCall(
      input({
        writes: [
          { type: "booked" },
          { type: "changed", tool: "reschedule_appointment_db", appointmentId: "row-1" },
        ],
      }),
      deps
    );

    expect(deps.notifications.sendCallerSms).toHaveBeenCalledTimes(1);
    expect(deps.notifications.sendCallerSms.mock.calls[0][3].datetime).toMatch(/8/);
  });
});

describe("verifyCall - the count ladder", () => {
  beforeEach(() => clearStats());

  it("reconciles but texts nobody in count mode", async () => {
    const deps = fakeDeps({ booked: [row()] });
    const out = await verifyCall(input({ mode: "count", claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(out.verdict).toBe("ok");
    expect(deps.db.listAppointmentsByCallId).toHaveBeenCalled();
    expect(deps.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.postcall_verify_runs).toBe(1);
    expect(getLatencyStats().turnTaking.postcall_confirm_sent).toBe(0);
  });

  it("does nothing at all when off", async () => {
    const deps = fakeDeps({ booked: [row()] });
    const out = await verifyCall(input({ mode: "off" }), deps);

    expect(out.verdict).toBe("skipped");
    expect(deps.db.listAppointmentsByCallId).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.postcall_verify_runs).toBe(0);
  });
});

describe("verifyCall - never throws into a teardown", () => {
  beforeEach(() => clearStats());

  it("survives a database failure", async () => {
    const deps = fakeDeps({ throws: true });
    const out = await verifyCall(input({ claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(out.verdict).toBe("error");
    expect(deps.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // The failure mode this module could most easily have shipped with.
  //
  // withTenantSafe CATCHES and returns its fallback, and most of
  // services/db.js returns [] for both "found nothing" and "query failed".
  // Collapsed together, a database outage would report that the assistant
  // fabricated a booking -- accusing the model of lying every time the
  // database hiccups, and suppressing a confirmation the caller should have
  // had. listAppointmentsByCallId returns null on failure precisely so the two
  // stay distinguishable.
  // ------------------------------------------------------------------
  it("does not read a failed lookup as a fabrication", async () => {
    const deps = fakeDeps({ readFails: true });
    const out = await verifyCall(input({ claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(out.verdict).toBe("error");
    expect(getLatencyStats().turnTaking.postcall_claim_without_row).toBe(0);
    expect(deps.notifications.sendCallerSms).not.toHaveBeenCalled();
  });

  it("does not read a swallowed throw as a fabrication either", async () => {
    // The real withTenantSafe turns this into the fallback rather than letting
    // it propagate, so the module never sees the exception at all.
    const deps = fakeDeps({ throws: true });
    const out = await verifyCall(input({ claims: [{ turn: 4, kind: "claim" }] }), deps);

    expect(out.verdict).toBe("error");
    expect(getLatencyStats().turnTaking.postcall_claim_without_row).toBe(0);
  });

  it("does not accuse a call whose changed row cannot be read back", async () => {
    const deps = fakeDeps({ byId: {} });
    const out = await verifyCall(
      input({
        writes: [{ type: "changed", tool: "cancel_appointment_db", appointmentId: "row-9" }],
        claims: [{ turn: 6, kind: "claim" }],
      }),
      deps
    );

    // A tool ran and reported success. That is a different failure from a
    // model that called nothing, and it gets a different name.
    expect(out.verdict).toBe("row_mismatch");
    expect(getLatencyStats().turnTaking.postcall_claim_without_row).toBe(0);
  });

  it("refuses an unscoped read", async () => {
    const deps = fakeDeps({ booked: [row()] });
    const out = await verifyCall(input({ businessId: null }), deps);

    expect(out.verdict).toBe("skipped");
    expect(deps.db.listAppointmentsByCallId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CALL CA422f58, REPRODUCED. The call this whole effort exists to catch.
//
// From its own production log line:
//
//   postcall_verify  verdict=ok  booked_rows=0  changed_rows=1  claims=2  mode=count
//
// The caller was read back "I'm booking a 30 minute strategy call for you on
// Monday, September 14th at 4 00 PM. Does that sound right?", said "Yes.", and
// book_appointment was never called once. The assistant then invented a
// technical glitch. No row exists, and the safety net reported the call CLEAN --
// because `claims` was 2 and `wroteAnything` was true thanks to the CANCELLATION
// that also happened, so `claimed && !wroteAnything` was false and every branch
// fell through to ok.
//
// Nobody was told. That is the defect: not the fabrication, which cannot be
// prevented on this front-end, but the silence afterwards.
//
// reconcile() cannot be made to see it without per-capability claim vocabulary,
// because the claim ledger records one generic kind. These tests assert the
// structural route instead, and the first one is the regression test for the
// verdict staying `ok` -- it must, because that is what reconcile honestly
// reports; what must change is that a human now hears about it anyway.
// ---------------------------------------------------------------------------
describe("a booking owed with no row reaches a human, whatever the verdict says", () => {
  beforeEach(() => clearStats());

  const ca422f58 = {
    businessId: BUSINESS_ID,
    callId: CALL_ID,
    config: CONFIG,
    callerNumber: "+447700900123",
    // The cancellation that actually happened on that call.
    writes: [{ type: "changed", tool: "cancel_appointment_db", appointmentId: "row-9" }],
    claims: [
      { turn: 3, kind: "claim", step: "gather_details" },
      { turn: 7, kind: "claim", step: "confirm" },
    ],
    abandoned: [],
    // A point availability check came back OPEN, and the caller affirmed a
    // read-back. Both are tool traffic and caller audio; neither is prose.
    bookingOwed: { agreed: true, pointVerified: 1 },
    mode: "count",
    callSid: "CA422f58",
  };

  it("still reports verdict ok, and escalates anyway", async () => {
    const d = fakeDeps({
      byId: { "row-9": row({ id: "row-9", status: "cancelled" }) },
    });
    const out = await verifyCall(ca422f58, d);

    // Unchanged, and deliberately so: this is what reconcile honestly concludes
    // from a claim ledger that cannot tell a booking claim from a cancellation.
    expect(out.verdict).toBe("ok");

    // The fact, computed beside the verdict rather than competing with it.
    expect(out.bookingOwedNoRow).toBe(true);
    expect(getLatencyStats().turnTaking.postcall_booking_owed_no_row).toBe(1);

    // THE ASSERTION THIS FILE EXISTS FOR. Before this, zero of these fired on
    // that call.
    expect(d.db.createCustomerRequest).toHaveBeenCalledTimes(1);
    expect(d.notifications.notifyUnconfirmedClaim).toHaveBeenCalledTimes(1);
    // And the human is told what actually happened, not the fabrication story.
    expect(d.db.createCustomerRequest.mock.calls[0][0].notes).toMatch(/caller agreed to an appointment/i);
  });

  it("says nothing when the booking it owed actually exists", async () => {
    // The same call with the row present. This is the test that separates the
    // check from one that simply escalates whenever a caller agreed to anything.
    const d = fakeDeps({ booked: [row()] });
    const out = await verifyCall(ca422f58, d);

    expect(out.bookingOwed).toBe(true);
    expect(out.bookingOwedNoRow).toBe(false);
    expect(d.db.createCustomerRequest).not.toHaveBeenCalled();
    expect(d.notifications.notifyUnconfirmedClaim).not.toHaveBeenCalled();
  });

  it("says nothing when no time the caller was asked about was ever confirmed", async () => {
    // Browsing. A caller shown a list of times and agreeing to something, with no
    // point check behind it, is not a booking that was owed -- it is a
    // conversation. pointVerified is the discriminator, and it is why the
    // availability verdict had to be recorded before this could be written.
    const d = fakeDeps({
      byId: { "row-9": row({ id: "row-9", status: "cancelled" }) },
    });
    const out = await verifyCall({ ...ca422f58, bookingOwed: { agreed: true, pointVerified: 0 } }, d);

    expect(out.bookingOwedNoRow).toBe(false);
    expect(d.db.createCustomerRequest).not.toHaveBeenCalled();
  });

  it("says nothing when the caller never agreed to anything", async () => {
    const d = fakeDeps({
      byId: { "row-9": row({ id: "row-9", status: "cancelled" }) },
    });
    const out = await verifyCall({ ...ca422f58, bookingOwed: { agreed: false, pointVerified: 2 } }, d);

    expect(out.bookingOwedNoRow).toBe(false);
    expect(d.db.createCustomerRequest).not.toHaveBeenCalled();
  });

  it("accuses nobody when the database read failed", async () => {
    // A read that failed and a read that found nothing are opposite conclusions:
    // an outage versus a missing booking. listAppointmentsByCallId returns null
    // rather than [] for exactly this, and an outage must not wake a human with
    // an accusation.
    const d = fakeDeps({ readFails: true });
    const out = await verifyCall(ca422f58, d);

    expect(out.verdict).toBe("error");
    expect(d.db.createCustomerRequest).not.toHaveBeenCalled();
  });

  it("is inert for every caller that passes no structural facts", async () => {
    // The cascade will never pass bookingOwed. Absent means absent, not false
    // positives for every existing call site.
    const d = fakeDeps({ booked: [] });
    const out = await verifyCall({ ...ca422f58, bookingOwed: undefined }, d);

    expect(out.bookingOwed).toBe(false);
    expect(out.bookingOwedNoRow).toBe(false);
    expect(d.db.createCustomerRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TWO MESSAGES ABOUT ONE APPOINTMENT. Restored from 68f0585, reverted the next
// day, and the thing that made POSTCALL_VERIFY=send unsafe to turn on:
// capabilities/appointments.js already texts a confirmation at booking time, so
// without this every successful booking is lined up for a second one.
//
// The negatives are the load-bearing half. A suppression that fired on everything
// would pass the first test here and silence the messages the other three protect.
// ---------------------------------------------------------------------------
describe("the post-call confirmation does not duplicate the booking-time one", () => {
  beforeEach(() => clearStats());

  const CALLER = "+447700900123";

  it("says nothing when the caller was already told at booking time", async () => {
    const d = fakeDeps({ booked: [row({ client_phone: CALLER })] });
    const out = await verifyCall(
      input({
        callerNumber: CALLER,
        writes: [{ type: "booked", tool: "book_appointment", appointmentId: "row-1" }],
        claims: [{ turn: 1, kind: "claim" }],
      }),
      d
    );

    expect(out.sent).toHaveLength(0);
    expect(out.skipped.map((x) => x.reason)).toContain("already_confirmed");
    expect(d.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.postcall_confirm_skipped_already_confirmed).toBe(1);
  });

  it("still texts the client when the caller booked for somebody else", async () => {
    // The booking-time sender uses the number that RANG US; this one uses the
    // number on the row. When they differ, the caller has been told and the client
    // has not -- so suppressing here would silence the only message that was ever
    // going to reach them.
    const d = fakeDeps({ booked: [row({ client_phone: "+447700900999" })] });
    const out = await verifyCall(
      input({
        callerNumber: CALLER,
        writes: [{ type: "booked", tool: "book_appointment", appointmentId: "row-1" }],
        claims: [{ turn: 1, kind: "claim" }],
      }),
      d
    );

    expect(out.sent).toHaveLength(1);
    expect(d.notifications.sendCallerSms).toHaveBeenCalledTimes(1);
  });

  it("texts nothing at all when a verdict impugns the row", async () => {
    // write_abandoned is LVX72's shape: the booking exists, the name-correction
    // tool was refused and never retried, so the row carries a name the caller did
    // not give. A confirmation is a promise that the row is RIGHT.
    const d = fakeDeps({ booked: [row({ client_phone: CALLER })] });
    const out = await verifyCall(
      input({ callerNumber: CALLER, writes: [], abandoned: ["correct_appointment_name"] }),
      d
    );

    expect(out.verdict).toBe("write_abandoned");
    expect(out.sent).toHaveLength(0);
    expect(d.notifications.sendCallerSms).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.postcall_confirm_skipped_verdict).toBe(1);
  });

  it("cannot suppress anything when the booked write carries no row id", async () => {
    // Documents the dependency rather than hiding it. This is exactly the state
    // the code was in before the id was restored: the set is empty, nothing
    // matches, and the caller gets both messages. A test that only covered the
    // working case would have called that fixed.
    const d = fakeDeps({ booked: [row({ client_phone: CALLER })] });
    const out = await verifyCall(
      input({
        callerNumber: CALLER,
        writes: [{ type: "booked", tool: "book_appointment", appointmentId: null }],
        claims: [{ turn: 1, kind: "claim" }],
      }),
      d
    );

    expect(out.sent).toHaveLength(1);
    expect(out.skipped.map((x) => x.reason)).not.toContain("already_confirmed");
  });
});
