/**
 * The shared capability-effect dispatcher.
 *
 * Both voice pipelines run this: lib/voice/session.js (v2, the default) and
 * lib/mediaStream.js (v1, reachable via PIPELINE_V2=false). It is shared
 * precisely because it was NOT before — the appointment side effects were
 * duplicated in both files, and migrating one while forgetting the other left
 * the rollback path silently not notifying owners about bookings and not
 * persisting messages at all.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mergeCapabilityState,
  dispatchCapabilityEffects,
} from "../lib/capabilities/effects.js";

function makeEngine() {
  const log = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const captureException = vi.fn();
  return {
    engine: { STEPS: { CONFIRM: "confirm" }, deps: { log, captureException } },
    log,
    captureException,
  };
}

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


describe("mergeCapabilityState", () => {
  it("creates the container on first write", () => {
    const state = {};
    mergeCapabilityState(state, { appointments: { selectedAppointmentId: "a1" } });
    expect(state.capabilityState).toEqual({ appointments: { selectedAppointmentId: "a1" } });
  });

  it("merges within a capability rather than replacing it", () => {
    // Two tools from the same capability in one turn both contribute — a lookup
    // sets the selected appointment, then a cancel adds the verified identity.
    const state = { capabilityState: { appointments: { selectedAppointmentId: "a1" } } };
    mergeCapabilityState(state, { appointments: { identityVerifiedApptId: "a1" } });
    expect(state.capabilityState.appointments).toEqual({
      selectedAppointmentId: "a1",
      identityVerifiedApptId: "a1",
    });
  });

  it("keeps capabilities isolated from each other", () => {
    const state = { capabilityState: { appointments: { lastBooked: { x: 1 } } } };
    mergeCapabilityState(state, { quotes: { lastRequested: "water heater" } });
    expect(state.capabilityState.appointments).toEqual({ lastBooked: { x: 1 } });
    expect(state.capabilityState.quotes).toEqual({ lastRequested: "water heater" });
  });

  it("a null VALUE clears one key", () => {
    // How a cancel kills the booking anchor: "cancel that, actually put me back
    // in at the same time" must perform a real insert, not short-circuit to
    // "already booked".
    const state = {
      capabilityState: { appointments: { lastBooked: { x: 1 }, identityVerifiedApptId: "a1" } },
    };
    mergeCapabilityState(state, { appointments: { lastBooked: null } });
    expect(state.capabilityState.appointments.lastBooked).toBeNull();
    expect(state.capabilityState.appointments.identityVerifiedApptId).toBe("a1");
  });

  it("a null CAPABILITY drops the whole slot", () => {
    const state = { capabilityState: { appointments: { lastBooked: { x: 1 } } } };
    mergeCapabilityState(state, { appointments: null });
    expect(state.capabilityState.appointments).toBeUndefined();
  });

  it("tolerates missing state or patch", () => {
    expect(() => mergeCapabilityState(null, { a: {} })).not.toThrow();
    expect(() => mergeCapabilityState({}, null)).not.toThrow();
  });
});

describe("dispatchCapabilityEffects", () => {
  it("returns no notes for an empty or missing list", () => {
    const { engine } = makeEngine();
    expect(dispatchCapabilityEffects([], engine)).toEqual([]);
    expect(dispatchCapabilityEffects(undefined, engine)).toEqual([]);
    expect(dispatchCapabilityEffects(null, engine)).toEqual([]);
  });

  it("routes an effect to its owning pack and collects its note", () => {
    const { engine } = makeEngine();
    const notes = dispatchCapabilityEffects(
      [
        {
          capability: "quotes",
          type: "requested",
          data: { service_description: "water heater" },
        },
      ],
      {
        ...engine,
        setStep: vi.fn(),
        call: { businessId: "b1", callerNumber: "+15551234567", config: {} },
        deps: {
          ...engine.deps,
          db: { createCustomerRequest: vi.fn().mockResolvedValue(null) },
          notifications: { notifyCustomerRequest: vi.fn(), sendCallerSms: vi.fn() },
        },
      }
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("water heater");
  });

  it("collects notes from several effects in one turn", () => {
    const { engine } = makeEngine();
    const notes = dispatchCapabilityEffects(
      [
        { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db" } },
        { capability: "appointments", type: "changed", data: { tool: "reschedule_appointment_db" } },
      ],
      { ...engine, setStep: vi.fn(), call: { businessId: "b1" } }
    );
    expect(notes).toEqual([
      "cancel_appointment_db succeeded",
      "reschedule_appointment_db succeeded",
    ]);
  });

  it("warns rather than throwing on an effect nobody owns", () => {
    const { engine, log } = makeEngine();
    expect(() =>
      dispatchCapabilityEffects([{ capability: "no_such_pack", type: "x" }], engine)
    ).not.toThrow();
    // lib/logger.js has no warn level; the convention is error + severity.
    expect(log.error).toHaveBeenCalledWith(
      "capability_effect_unhandled",
      expect.objectContaining({ capability: "no_such_pack", severity: "warn" })
    );
  });

  it("one failing capability does not stop the others", async () => {
    // The caller is mid-call. A pack that throws must not cost the turn its
    // remaining effects — especially not a booking notification.
    const { log, captureException } = makeEngine();
    const boom = new Error("pack exploded");
    const engine = {
      STEPS: { CONFIRM: "confirm" },
      deps: { log, captureException },
      setStep: vi.fn(() => {
        if (engine.setStep.mock.calls.length === 1) throw boom;
      }),
      call: { businessId: "b1" },
    };

    const notes = dispatchCapabilityEffects(
      [
        { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db" } },
        { capability: "appointments", type: "changed", data: { tool: "reschedule_appointment_db" } },
      ],
      engine
    );

    expect(log.error).toHaveBeenCalledWith(
      "capability_effect_failed",
      expect.objectContaining({ capability: "appointments" })
    );
    expect(captureException).toHaveBeenCalledWith(boom);
    // The second effect still ran.
    expect(notes).toEqual(["reschedule_appointment_db succeeded"]);
  });
});

// ---------------------------------------------------------------------------
// Keeping the call-start caller snapshot honest.
//
// The snapshot is fetched once, before turn 1. Left alone it is wrong the
// moment the call books or cancels anything: CALLER CONTEXT goes on reciting an
// appointment that no longer exists, and book_appointment's guard refuses a
// second booking on the strength of one this very call just cancelled.
// ---------------------------------------------------------------------------
describe("appointments.onEffect — the caller snapshot follows what the call did", () => {
  const CTX = (upcoming) => ({ callCount: 2, lastCallSummary: "asked about hours", upcomingAppointments: upcoming });

  function engineWith(callerContext) {
    const setCallerContext = vi.fn();
    return {
      setCallerContext,
      engine: {
        STEPS: { CONFIRM: "confirm" },
        setStep: vi.fn(),
        addHistoryNote: vi.fn(),
        setCallerContext,
        call: {
          callSid: "CA1",
          businessId: "biz-1",
          callerNumber: "+15551112222",
          twilioNumber: null,
          config: { timezone: "America/Chicago" },
          callerContext,
        },
        deps: {
          log: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
          captureException: vi.fn(),
          notifications: { notifyAppointmentBooked: vi.fn(async () => {}), sendCallerSms: vi.fn(async () => {}) },
          db: {},
        },
      },
    };
  }

  it("a booking appends to the snapshot, in time order", async () => {
    const { engine, setCallerContext } = engineWith(CTX([{ id: "a1", scheduled_at: "2026-09-10T15:00:00.000Z" }]));
    const appointments = (await import("../capabilities/appointments.js")).default;

    appointments.onEffect(
      { capability: "appointments", type: "booked", data: { scheduled_at: "2026-09-05T15:00:00.000Z", client_name: "Jane" } },
      engine
    );

    const next = setCallerContext.mock.calls[0][0].upcomingAppointments;
    expect(next.map((a) => a.scheduled_at)).toEqual([
      "2026-09-05T15:00:00.000Z",
      "2026-09-10T15:00:00.000Z",
    ]);
    // No id on the fresh row: nothing reads it, and an appointment id is
    // something the model must never be handed.
    expect(next[0].id).toBeNull();
    // The rest of the snapshot survives.
    expect(setCallerContext.mock.calls[0][0].callCount).toBe(2);
  });

  it("a cancel removes the row it cancelled", async () => {
    const { engine, setCallerContext } = engineWith(
      CTX([{ id: "a1", scheduled_at: "2026-09-10T15:00:00.000Z" }, { id: "a2", scheduled_at: "2026-09-11T15:00:00.000Z" }])
    );
    const appointments = (await import("../capabilities/appointments.js")).default;

    appointments.onEffect(
      { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db", appointmentId: "a1" } },
      engine
    );

    expect(setCallerContext.mock.calls[0][0].upcomingAppointments.map((a) => a.id)).toEqual(["a2"]);
  });

  it("a reschedule re-times the row rather than dropping it", async () => {
    const { engine, setCallerContext } = engineWith(CTX([{ id: "a1", scheduled_at: "2026-09-10T15:00:00.000Z" }]));
    const appointments = (await import("../capabilities/appointments.js")).default;

    appointments.onEffect(
      {
        capability: "appointments",
        type: "changed",
        data: { tool: "reschedule_appointment_db", appointmentId: "a1", newScheduledAt: "2026-09-12T15:00:00.000Z" },
      },
      engine
    );

    expect(setCallerContext.mock.calls[0][0].upcomingAppointments).toEqual([
      { id: "a1", scheduled_at: "2026-09-12T15:00:00.000Z" },
    ]);
  });

  // Part 6: the rows past the five listed follow the call too, so a day's
  // booking count (bookingsFitting) sees a moved or cancelled sixth booking.
  it("a cancel or move of a row past the five listed updates upcomingBeyond", async () => {
    const appointments = (await import("../capabilities/appointments.js")).default;
    const ctx = () => ({
      ...CTX([{ id: "a1", scheduled_at: "2026-09-10T15:00:00.000Z" }]),
      upcomingOverflow: 2,
      upcomingBeyond: [
        { id: "b1", client_name: "Jane", scheduled_at: "2026-09-20T15:00:00.000Z" },
        { id: "b2", client_name: "Jane", scheduled_at: "2026-09-21T15:00:00.000Z" },
      ],
    });

    const cancel = engineWith(ctx());
    appointments.onEffect(
      { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db", appointmentId: "b1" } },
      cancel.engine
    );
    const afterCancel = cancel.setCallerContext.mock.calls[0][0];
    expect(afterCancel.upcomingBeyond.map((a) => a.id)).toEqual(["b2"]);
    expect(afterCancel.upcomingOverflow).toBe(1);

    const move = engineWith(ctx());
    appointments.onEffect(
      {
        capability: "appointments",
        type: "changed",
        data: { tool: "reschedule_appointment_db", appointmentId: "b2", newScheduledAt: "2026-09-25T15:00:00.000Z" },
      },
      move.engine
    );
    expect(move.setCallerContext.mock.calls[0][0].upcomingBeyond[1].scheduled_at).toBe("2026-09-25T15:00:00.000Z");
  });

  it("does nothing on an engine that has no setCallerContext (the v1 pipeline)", async () => {
    // lib/mediaStream.js is a rollback escape hatch and deliberately not at
    // parity. It must keep working, not throw.
    const { engine } = engineWith(CTX([]));
    delete engine.setCallerContext;
    const appointments = (await import("../capabilities/appointments.js")).default;

    expect(() =>
      appointments.onEffect(
        { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db", appointmentId: "a1" } },
        engine
      )
    ).not.toThrow();
  });

  it("handles a call that had no caller context at all", async () => {
    const { engine, setCallerContext } = engineWith(null);
    const appointments = (await import("../capabilities/appointments.js")).default;

    appointments.onEffect(
      { capability: "appointments", type: "booked", data: { scheduled_at: "2026-09-05T15:00:00.000Z" } },
      engine
    );

    expect(setCallerContext.mock.calls[0][0].upcomingAppointments).toHaveLength(1);
  });

  it("leaves the snapshot alone when a change carries no appointment id", async () => {
    // Nothing can be said about which row moved, so guessing would be worse
    // than staying stale.
    const { engine, setCallerContext } = engineWith(CTX([{ id: "a1", scheduled_at: "2026-09-10T15:00:00.000Z" }]));
    const appointments = (await import("../capabilities/appointments.js")).default;

    appointments.onEffect(
      { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db" } },
      engine
    );

    expect(setCallerContext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LVX33. Three cancellations in one turn only forgot the last one.
//
// The dispatcher built its engine once per BATCH, so every removal recomputed
// from the same starting list and the last write won — two of the three
// appointments survived in the snapshot. The caller was then told they still
// had appointments they had just cancelled, and the existing-appointment guard
// refused to book anything for the rest of the call.
//
// These tests drive dispatchCapabilityEffects with a batch, which is what both
// pipelines actually pass it. The single-effect tests above cannot see this:
// they call onEffect directly, so there is never a second iteration to be
// stale.
// ---------------------------------------------------------------------------
describe("dispatchCapabilityEffects — several appointment effects in one turn", () => {
  /**
   * The shape all four drivers build (lib/voice/session.js:3462,
   * lib/voice/live/index.js:801, and the two harnesses): a `call` literal whose
   * callerContext is a VALUE copied at dispatch time, and a setter that rebinds
   * the session's own reference without touching that copy.
   */
  function driver(upcoming) {
    let callerContext = { callCount: 1, lastCallSummary: null, upcomingAppointments: upcoming };
    const engine = {
      STEPS: { CONFIRM: "confirm" },
      setStep: vi.fn(),
      setCallerContext(next) {
        callerContext = next || null;
      },
      call: {
        callSid: "CA1",
        businessId: "biz-1",
        callerNumber: "+15551112222",
        twilioNumber: null,
        config: { timezone: "America/Chicago" },
        callerContext,
      },
      deps: {
        log: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
        captureException: vi.fn(),
        notifications: { notifyAppointmentBooked: vi.fn(async () => {}), sendCallerSms: vi.fn(async () => {}) },
        db: {},
      },
    };
    return { engine, current: () => callerContext };
  }

  const cancel = (id) => ({
    capability: "appointments",
    type: "changed",
    data: { tool: "cancel_appointment_db", appointmentId: id },
  });

  const THREE = [
    { id: "a1", scheduled_at: "2026-09-11T16:30:00.000Z" },
    { id: "a2", scheduled_at: "2026-09-14T15:00:00.000Z" },
    { id: "a3", scheduled_at: "2026-09-15T15:00:00.000Z" },
  ];

  it("three cancellations in one turn leave none of them in the snapshot", () => {
    const { engine, current } = driver([...THREE]);

    dispatchCapabilityEffects([cancel("a1"), cancel("a2"), cancel("a3")], engine);

    // The observed failure left exactly [a1, a2] here -- the pair the assistant
    // then read back to the caller as still booked.
    expect(current().upcomingAppointments).toEqual([]);
  });

  it("the snapshot the booking guard reads is empty, so a new booking is allowed", () => {
    // upcomingForCaller() reads callerContext.upcomingAppointments and
    // book_appointment refuses while it is non-empty. This is the half the
    // caller actually felt: phantom appointments meant "it was unable to book".
    const { engine, current } = driver([...THREE]);

    dispatchCapabilityEffects([cancel("a1"), cancel("a2"), cancel("a3")], engine);

    const future = (current().upcomingAppointments || []).filter(
      (a) => Date.parse(a.scheduled_at) > Date.parse("2026-09-10T00:00:00.000Z")
    );
    expect(future).toHaveLength(0);
  });

  it("a cancel and a booking in the same turn both land", () => {
    const { engine, current } = driver([...THREE]);

    dispatchCapabilityEffects(
      [
        cancel("a2"),
        {
          capability: "appointments",
          type: "booked",
          data: { scheduled_at: "2026-09-16T15:00:00.000Z", client_name: "Jane" },
        },
      ],
      engine
    );

    expect(current().upcomingAppointments.map((a) => a.id ?? "new")).toEqual(["a1", "a3", "new"]);
  });

  it("still does nothing when the driver has no setCallerContext", () => {
    // The text harness is deliberately not at parity and keeps the call-start
    // snapshot. It must not throw when a batch arrives.
    const { engine } = driver([...THREE]);
    delete engine.setCallerContext;

    expect(() => dispatchCapabilityEffects([cancel("a1"), cancel("a2")], engine)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 4 (Ilija inbound): the message and quote packs stop emailing at save.
// A row filed on a call is saved PENDING and the owner's email is sent once, at
// call end (Tasks 5 and 6). record_customer_request also takes a caller's
// answers. The only email path left in onEffect is a save with no call row.
// ---------------------------------------------------------------------------
function requestSaveEngine({ callId = "call-1", callerNumber = "+442071234567", config = {} } = {}) {
  const created = [];
  const notifyCustomerRequest = vi.fn(async () => true);
  return {
    created,
    notifyCustomerRequest,
    engine: {
      STEPS: { CONFIRM: "confirm" },
      setStep: vi.fn(),
      addHistoryNote: vi.fn(),
      call: { callSid: "CA1", businessId: "biz-1", callId, callerNumber, config, party: null },
      deps: {
        db: {
          withTenantSafe: async (_id, fn) => fn(),
          listCallCustomerRequests: vi.fn(async () => []),
          updateCustomerRequest: vi.fn(async () => null),
          createCustomerRequest: vi.fn(async (r) => {
            created.push(r);
            return "req-1";
          }),
        },
        notifications: { notifyCustomerRequest, sendCallerSms: vi.fn(async () => {}), MESSAGE_SLA_TEXT: "soon" },
        log: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
        captureException: vi.fn(),
      },
    },
  };
}
const settleWrites = () => new Promise((r) => setTimeout(r, 30));

describe("messages pack: pending at save, answers in the tool", () => {
  const ARGS = {
    request_type: "message",
    caller_name: "Jane",
    callback_number: "214 555 0123",
    message: "about the invoice",
  };

  it("record_customer_request saves pending and sends no email at save", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    const { engine, created, notifyCustomerRequest } = requestSaveEngine();
    messages.onEffect({ capability: "messages", type: "recorded", data: ARGS }, engine);
    await settleWrites();
    expect(created).toHaveLength(1);
    expect(created[0].ownerNoticePending).toBe(true);
    expect(notifyCustomerRequest).not.toHaveBeenCalled();
  });

  it("a save with no call id still notifies at once", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    const { engine, created, notifyCustomerRequest } = requestSaveEngine({ callId: null });
    messages.onEffect({ capability: "messages", type: "recorded", data: ARGS }, engine);
    await settleWrites();
    expect(created[0].ownerNoticePending).toBe(false);
    expect(notifyCustomerRequest).toHaveBeenCalledTimes(1);
  });

  it("the answers and caller type are stored on the row", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    const { engine, created } = requestSaveEngine();
    messages.onEffect(
      {
        capability: "messages",
        type: "recorded",
        data: { ...ARGS, caller_type: "new_enquiry", details: [{ label: "Company", answer: "Acme" }] },
      },
      engine
    );
    await settleWrites();
    expect(created[0].details).toEqual({ callerType: "new_enquiry", answers: [{ label: "Company", answer: "Acme" }] });
  });

  it("a withheld caller number is never stored as the callback number", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    const { engine, created } = requestSaveEngine({ callerNumber: "+266696687" });
    messages.onEffect(
      { capability: "messages", type: "recorded", data: { ...ARGS, callback_number: undefined } },
      engine
    );
    await settleWrites();
    expect(created).toHaveLength(1);
    expect(created[0].callbackNumber).toBeNull();
  });

  it("a real caller number still fills a missing callback number", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    const { engine, created } = requestSaveEngine({ callerNumber: "+442071234567" });
    messages.onEffect(
      { capability: "messages", type: "recorded", data: { ...ARGS, callback_number: undefined } },
      engine
    );
    await settleWrites();
    expect(created[0].callbackNumber).toBe("+442071234567");
  });

  it("the declaration offers caller_type and details", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    const { CALLER_TYPES } = await import("../lib/capabilities/customerRequests.js");
    const props = messages.tools({}).find((d) => d.name === "record_customer_request").parameters.properties;
    expect(props.caller_type.enum).toEqual(CALLER_TYPES);
    expect(props.details.type).toBe("array");
    expect(props.details.items.type).toBe("object");
    expect(props.details.items.required).toEqual(["label", "answer"]);
    expect(props.details.items.properties.label.type).toBe("string");
    expect(props.details.items.properties.answer.type).toBe("string");
  });

  it("a business with messages notes gets next in the reply; spoken message unchanged", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    const ctx = { config: { capabilities: { messages: { notes: "Ask which service they need." } } } };
    const out = await messages.execute({ id: "f1", name: "record_customer_request", args: ARGS }, ctx);
    expect(out.functionResponse.response.next).toMatch(/^\[not caller speech\]/);
    expect(out.functionResponse.response.message).toBe("I'll make sure they get your message.");
    expect(out.stateEffects.toolResult).toEqual({
      name: "record_customer_request",
      success: true,
      message: "I'll make sure they get your message.",
      callerSafe: true,
    });
    expect(JSON.stringify(out.stateEffects)).not.toContain("not caller speech");
  });

  it("a business without notes gets no next", async () => {
    const messages = (await import("../capabilities/messages.js")).default;
    for (const config of [
      {},
      { capabilities: { messages: { notes: "   " } } },
      { capabilities: { messages: { notes: 5 } } },
    ]) {
      const out = await messages.execute({ id: "f1", name: "record_customer_request", args: ARGS }, { config });
      expect("next" in out.functionResponse.response).toBe(false);
    }
    const bare = await messages.execute({ id: "f1", name: "record_customer_request", args: ARGS });
    expect("next" in bare.functionResponse.response).toBe(false);
  });
});

describe("quotes pack: pending at save", () => {
  const Q = { service_description: "replace a water heater", caller_name: "Ann" };

  it("a quote saved on a call is pending and sends no email", async () => {
    const quotes = (await import("../capabilities/quotes.js")).default;
    const { engine, created, notifyCustomerRequest } = requestSaveEngine();
    quotes.onEffect({ capability: "quotes", type: "requested", data: Q }, engine);
    await settleWrites();
    expect(created[0].ownerNoticePending).toBe(true);
    expect(notifyCustomerRequest).not.toHaveBeenCalled();
  });

  it("a quote with no call id still notifies at once, without a withheld number", async () => {
    const quotes = (await import("../capabilities/quotes.js")).default;
    const { engine, created, notifyCustomerRequest } = requestSaveEngine({
      callId: null,
      callerNumber: "+266696687",
    });
    quotes.onEffect({ capability: "quotes", type: "requested", data: Q }, engine);
    await settleWrites();
    expect(created[0].callbackNumber).toBeNull();
    expect(notifyCustomerRequest).toHaveBeenCalledTimes(1);
    expect(notifyCustomerRequest.mock.calls[0][0].customerRequest.callback_number).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dashboard overhaul part 2, stage 6: owner alerts link to the call, and a
// booking the call moved or cancelled emails the owner like a new booking.
// ---------------------------------------------------------------------------
describe("appointments.onEffect — owner alerts for a booking and its changes", () => {
  const CALL_ID = "1c2021e1-f44f-4066-8d8d-86cd089d8e04";

  function engineFor() {
    const notifications = {
      notifyAppointmentBooked: vi.fn(async () => {}),
      notifyAppointmentChanged: vi.fn(async () => {}),
      sendCallerSms: vi.fn(async () => {}),
    };
    return {
      notifications,
      engine: {
        STEPS: { CONFIRM: "confirm" },
        setStep: vi.fn(),
        addHistoryNote: vi.fn(),
        setCallerContext: vi.fn(),
        call: {
          callSid: "CA1",
          callId: CALL_ID,
          businessId: "biz-1",
          callerNumber: "+15551112222",
          twilioNumber: null,
          config: { timezone: "America/Chicago" },
          callerContext: null,
        },
        deps: { log: { error: vi.fn(), info: vi.fn(), debug: vi.fn() }, captureException: vi.fn(), notifications, db: {} },
      },
    };
  }

  it("the new-booking alert carries the call that booked it", async () => {
    const { engine, notifications } = engineFor();
    const appointments = (await import("../capabilities/appointments.js")).default;
    appointments.onEffect(
      { capability: "appointments", type: "booked", data: { scheduled_at: "2026-09-05T15:00:00.000Z", client_name: "Jane" } },
      engine
    );
    expect(notifications.notifyAppointmentBooked).toHaveBeenCalledTimes(1);
    expect(notifications.notifyAppointmentBooked.mock.calls[0][0].appointment.call_id).toBe(CALL_ID);
  });

  it("a successful cancel or move emails the owner once; a failed one sends nothing", async () => {
    const { engine, notifications } = engineFor();
    const appointments = (await import("../capabilities/appointments.js")).default;

    appointments.onEffect(
      { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db", appointmentId: "a1" } },
      engine
    );
    appointments.onEffect(
      {
        capability: "appointments",
        type: "changed",
        data: { tool: "reschedule_appointment_db", appointmentId: "a2", newScheduledAt: "2026-09-12T15:00:00.000Z" },
      },
      engine
    );
    // A rename and a note are changes too, but not ones the owner is told about.
    appointments.onEffect(
      { capability: "appointments", type: "changed", data: { tool: "update_appointment_name", appointmentId: "a1", newClientName: "Jane" } },
      engine
    );
    expect(notifications.notifyAppointmentChanged.mock.calls.map(([a]) => a)).toEqual([
      { businessId: "biz-1", kind: "cancelled", callId: CALL_ID },
      { businessId: "biz-1", kind: "moved", callId: CALL_ID },
    ]);

    // A cancel or move the booking system found but that changed nothing
    // (already cancelled, same time) tells the caller it is done and emails no one.
    appointments.onEffect(
      { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db", appointmentId: "a1", unchanged: true } },
      engine
    );
    expect(notifications.notifyAppointmentChanged).toHaveBeenCalledTimes(2);

    // A failed cancel returns no "changed" effect at all, so onEffect never runs.
    const failed = await appointments.execute(
      { id: "1", name: "cancel_appointment_db", args: { appointment_id: "missing" } },
      {
        businessId: "biz-1",
        callId: CALL_ID,
        callerPhone: "+15551112222",
        config: { timezone: "America/Chicago" },
        integrations: [],
        capabilityState: {},
        deps: {
          getAppointmentById: vi.fn(async () => null),
          cancelAppointmentRecorded: vi.fn(async () => false),
          listAppointmentsByCaller: vi.fn(async () => []),
        },
      }
    );
    expect(failed.stateEffects?.capabilityEffects || []).toEqual([]);
  });
});

describe("appointments cancel: the effect says whether the booking really changed", () => {
  it("a cancel the internal calendar found but did not change carries unchanged, so no email follows", async () => {
    const appointments = (await import("../capabilities/appointments.js")).default;
    const run = (recorded) =>
      appointments.execute(
        { id: "1", name: "cancel_appointment_db", args: { appointment_id: "a1" } },
        {
          businessId: "biz-1",
          callId: "1c2021e1-f44f-4066-8d8d-86cd089d8e04",
          callerPhone: "+15551112222",
          config: { timezone: "America/Chicago" },
          integrations: [],
          capabilityState: { appointments: { identityVerifiedApptId: "a1", selectedAppointmentId: "a1" } },
          callerContext: { upcomingAppointments: [{ id: "a1", scheduled_at: "2026-09-10T15:00:00.000Z" }] },
          deps: {
            getAppointmentById: vi.fn(async () => ({ id: "a1", client_phone: "+15551112222", scheduled_at: "2026-09-10T15:00:00.000Z", status: "scheduled" })),
            listAppointmentsByCaller: vi.fn(async () => [{ id: "a1", scheduled_at: "2026-09-10T15:00:00.000Z", status: "scheduled" }]),
            cancelAppointmentRecorded: vi.fn(async () => ({ found: true, recorded })),
          },
        }
      );
    const changed = await run(true);
    const unchanged = await run(false);
    expect(changed.functionResponse.response.success).toBe(true);
    expect(unchanged.functionResponse.response.success).toBe(true);
    expect(changed.stateEffects.capabilityEffects[0].data.unchanged).toBeUndefined();
    expect(unchanged.stateEffects.capabilityEffects[0].data.unchanged).toBe(true);
  });
});
