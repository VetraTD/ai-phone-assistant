// ---------------------------------------------------------------------------
// LVX71 — a caller with two appointments could not reschedule, because the
// refusal was two words.
//
// Observed on call 4 of the verification round, 2026-09-04, and reproduced
// against the same database:
//
//   reschedule_appointment_db { new_scheduled_at: "2026-09-08T14:00:00" }
//     -> success: false, message: "Which appointment?"
//   reschedule_appointment_db { appointment_id: <monday>, new_scheduled_at }
//     -> success: true,  message: "Rescheduled."
//
// `appointment_id` is documented as "optional if caller has one appointment",
// so the contract depends on data the model cannot see. That part is arguable.
// What is not arguable is the refusal: "Which appointment?" does not say the
// request is still live, does not say to ask the caller, and does not say to
// call again with an id. So the model read `success: false` as "this cannot be
// done" -- offered a callback, then invented "since you're calling from a
// different number, could I have the last four digits" (the caller ID matched
// the row exactly, and the prompt says in as many words NOT to ask that), then
// gave up and offered to take a message.
//
// This is LVX34's shape on a different tool, and LVX34's rewritten refusal is
// the model for the fix: say it is not a failure, say what is missing, say what
// to do, and say to call again.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const mockGetAppointmentById = vi.fn();
const mockUpdateAppointment = vi.fn();
const mockListAppointmentsByCaller = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
vi.mock("../services/db.js", () => ({
  createAppointment: vi.fn(),
  createAppointmentIfAvailable: vi.fn(),
  countScheduledOverlapping: vi.fn().mockResolvedValue(0),
  listScheduledBetween: vi.fn().mockResolvedValue([]),
  listAppointmentsByCaller: (...a) => mockListAppointmentsByCaller(...a),
  updateAppointmentStatus: (...a) => mockUpdateAppointmentStatus(...a),
  updateAppointment: (...a) => mockUpdateAppointment(...a),
  getAppointmentById: (...a) => mockGetAppointmentById(...a),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";

// The exact state of call 4: two upcoming appointments, both the caller's.
const TWO_ON_FILE = {
  callCount: 3,
  lastCallSummary: null,
  upcomingAppointments: [
    { id: "sat-1", client_name: "Nithin Dodla", scheduled_at: "2026-09-05T15:00:00Z", notes: null },
    { id: "mon-1", client_name: "Nithin Dodla", scheduled_at: "2026-09-07T13:00:00Z", notes: null },
  ],
};

const ctx = (callerContext) => ({
  businessId: "biz-1",
  callerPhone: "+14699338887",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: { timezone: "America/Chicago" },
  callerContext,
  spellingSettled: true,
});

const call = (name, args, callerContext = TWO_ON_FILE) =>
  executeToolCall({ id: "fc1", name, args }, ctx(callerContext));

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// THE CLOCK IS FROZEN, and this test learned why the hard way.
//
// The fixture below gives the caller two appointments, one on Saturday 5
// September at 15:00Z. `upcomingForCaller` filters to the FUTURE, so at 15:00Z
// on 5 September 2026 that row silently stopped counting and this file's whole
// premise -- a caller with TWO appointments -- became a caller with one. Ten
// tests went red mid-session, on a change that touched neither this file nor
// anything it imports.
//
// A test whose result depends on when it is run is not a test of the code. The
// same guard is already used by tests/promptSnapshot.test.js, for the same
// reason: the dynamic tail renders the current date and would churn every run.
//
// Friday 4 September, which is before both fixture appointments and is the day
// the calls this file was written from actually happened.
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


describe("LVX71 — the refusal has to say what to do next", () => {
  const NEEDS = [
    ["reschedule_appointment_db", { new_scheduled_at: "2026-09-08T14:00:00" }],
    ["cancel_appointment_db", {}],
    ["correct_appointment_name", { client_name: "Nathan Dodla" }],
  ];

  for (const [name, args] of NEEDS) {
    describe(name, () => {
      it("still refuses, and writes nothing", async () => {
        const { functionResponse } = await call(name, args);
        expect(functionResponse.response.success).toBe(false);
        expect(mockUpdateAppointment).not.toHaveBeenCalled();
      });

      it("says the request is still live, not that it failed", async () => {
        const { functionResponse } = await call(name, args);
        const m = functionResponse.response.message;
        // The LVX34 lesson: a bare success:false is read as "cannot be done",
        // and the model's fallback everywhere else is to take a message.
        expect(m).toContain("NOT A FAILURE");
        expect(m).toMatch(/do not (?:offer a callback|take a message)/i);
      });

      it("names what is missing and how to supply it", async () => {
        const { functionResponse } = await call(name, args);
        const m = functionResponse.response.message;
        expect(m).toContain("appointment_id");
        expect(m).toMatch(/ask the caller which/i);
      });

      it("offers the candidates, so the model has something to ask WITH", async () => {
        // The model cannot see which appointments exist from the refusal alone,
        // and asking "which appointment?" of a caller who has just said "my
        // Monday one" is the loop. Dates disambiguate; names are NOT included,
        // because NNR rule 4 forbids reading a name out of a record to have it
        // confirmed.
        const { functionResponse } = await call(name, args);
        const m = functionResponse.response.message;
        expect(m).toContain("September 5");
        expect(m).toContain("September 7");
        expect(m).not.toContain("Nithin");
      });

      it("is model-facing, and the caller hears something plain", async () => {
        const { functionResponse, stateEffects } = await call(name, args);
        expect(functionResponse.response.message).toContain("[not caller speech]");
        expect(stateEffects.toolResult.message).not.toContain("[not caller speech]");
        expect(stateEffects.toolResult.message).not.toContain("appointment_id");
      });
    });
  }

  it("says so plainly when there are no appointments to choose between", async () => {
    // A different situation and it must not read the same: there is nothing to
    // ask the caller about, so telling the model to ask which one is a loop.
    const { functionResponse } = await call(
      "reschedule_appointment_db",
      { new_scheduled_at: "2026-09-08T14:00:00" },
      { callCount: 0, lastCallSummary: null, upcomingAppointments: [] }
    );
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/no upcoming appointments/i);
    expect(functionResponse.response.message).not.toMatch(/ask the caller which/i);
  });

  // The declaration says appointment_id is "optional if caller has one
  // appointment". The code only delivers that when a PREVIOUS lookup left an id
  // in the pack scratchpad, so a caller with exactly one gets refused too --
  // a mismatch between a tool's stated contract and its behaviour, found while
  // fixing LVX71 rather than by a call.
  //
  // The control flow is deliberately not changed here: resolving the id inside
  // a message builder would move an ownership decision somewhere it does not
  // belong. The model is handed the id instead, which is what it was missing.
  it("does not refuse AT ALL when the caller has only one appointment", async () => {
    // CHANGED 2026-09-04, and it is LVX71's own goal reached one layer earlier.
    //
    // This used to assert the refusal text -- that it handed the model the id
    // and told it not to ask which. That was the best available answer while
    // the id could only come from the model, and it still cost a round-trip the
    // caller waits through, at a reply p50 of 1.3-2.5 s.
    //
    // LVX74's resolver now fills a missing appointment_id from the caller's own
    // call-start snapshot when exactly one is upcoming, so there is nothing to
    // refuse. Ownership is unchanged: verifyAppointmentIdentity still runs on
    // the resolved id and still fails closed, which is what the mock below is
    // for.
    const one = { callCount: 1, lastCallSummary: null, upcomingAppointments: [TWO_ON_FILE.upcomingAppointments[0]] };
    mockGetAppointmentById.mockResolvedValue({
      id: "sat-1",
      client_name: "Nithin Dodla",
      client_phone: "+14699338887",
      scheduled_at: "2026-09-05T15:00:00Z",
      status: "scheduled",
    });
    mockUpdateAppointmentStatus.mockResolvedValue(true);

    const { functionResponse } = await call("cancel_appointment_db", {}, one);

    expect(functionResponse.response.success).toBe(true);
    expect(mockGetAppointmentById).toHaveBeenCalledWith("sat-1", "biz-1");
  });

  it("still refuses, with the id, if the resolver is ever bypassed", async () => {
    // The backstop, exercised directly. whichAppointmentMessage's
    // single-appointment branch is no longer on the path a caller takes, and a
    // branch nothing reaches is a branch that rots -- so this pins it against
    // the day the resolver is narrowed. Bypassed here by supplying an id the
    // resolver will not touch and that resolves to nothing, then asserting the
    // OTHER refusal still names what is missing.
    const one = { callCount: 1, lastCallSummary: null, upcomingAppointments: [TWO_ON_FILE.upcomingAppointments[0]] };
    mockGetAppointmentById.mockResolvedValue(null);

    const { functionResponse } = await call("cancel_appointment_db", { appointment_id: "invented" }, one);

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/get_caller_appointments_from_db/);
    expect(functionResponse.response.message).not.toMatch(/booked under your number/i);
  });
});
