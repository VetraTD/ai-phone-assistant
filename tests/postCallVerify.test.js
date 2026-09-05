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

function fakeDeps({ booked = [], byId = {}, throws = false, readFails = false } = {}) {
  const notifications = { sendCallerSms: vi.fn(async () => {}) };
  const db = {
    isEnabled: () => true,
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
