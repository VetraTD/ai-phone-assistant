// ---------------------------------------------------------------------------
// A write needs consent that was actually given, in speech we actually heard.
//
// LVX56 — turn 10 of a real call: the caller said "Ah!" and nothing else, and
// the assistant executed a reschedule AND a name correction, then announced
// both as done. The LVX45 fix threaded the caller's last utterance into the
// end_call gate ONLY, so the hang-up was protected and every write was not.
//
// LVX50 — an English turn came back as "에레는" and was answered "Great, 8 AM on
// Tuesday, September 8th, is available"; the call then booked from it. This is
// the input path to a WRITE, which is what makes it worse than a misheard word:
// a misheard time gives a wrong row, an invented reading of noise gives a row
// nobody asked for.
//
// The gate is deliberately ABOVE the spelling gate: checking the spelling of a
// name on a write nobody authorised is checking the spelling of a decision that
// was never made.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();
const mockListAppointmentsByCaller = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
const mockUpdateAppointment = vi.fn();
const mockGetAppointmentById = vi.fn();
const mockCountScheduledOverlapping = vi.fn().mockResolvedValue(0);
const mockListScheduledBetween = vi.fn().mockResolvedValue([]);

vi.mock("../services/db.js", () => ({
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: async (p) => {
    const id = await mockCreateAppointment(p);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: (...a) => mockCountScheduledOverlapping(...a),
  listScheduledBetween: (...a) => mockListScheduledBetween(...a),
  listAppointmentsByCaller: (...a) => mockListAppointmentsByCaller(...a),
  updateAppointmentStatus: (...a) => mockUpdateAppointmentStatus(...a),
  updateAppointment: (...a) => mockUpdateAppointment(...a),
  getAppointmentById: (...a) => mockGetAppointmentById(...a),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const FUTURE_SLOT = `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T10:00:00`;

const ctxWith = (lastCallerText) => ({
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: {},
  // Settled, so a refusal here is the consent gate and never the spelling gate.
  spellingSettled: true,
  lastCallerText,
});

const book = (ctx) =>
  executeToolCall(
    {
      id: "fc1",
      name: "book_appointment",
      args: { client_name: "Nithin Dodla", scheduled_at: FUTURE_SLOT, notes: "cleaning" },
    },
    ctx
  );

const counters = () => getLatencyStats().turnTaking;

beforeEach(() => {
  clearStats();
  vi.clearAllMocks();
  mockCreateAppointment.mockResolvedValue("appt-1");
  mockCountScheduledOverlapping.mockResolvedValue(0);
  mockListScheduledBetween.mockResolvedValue([]);
});

describe("LVX56 — a hesitation cannot be the agreement that triggers a write", () => {
  it("refuses the write, and nothing reaches the database", async () => {
    const { functionResponse, stateEffects } = await book(ctxWith("Ah!"));

    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    // The refusal is model-facing; the caller hears a plain question instead.
    expect(functionResponse.response.message).toContain("[not caller speech]");
    expect(stateEffects.toolResult.callerSafe).toBe(true);
    expect(stateEffects.toolResult.message).toBe("Sorry — did you want me to go ahead with that?");
    // Silent, for the same reason the spelling gate's event is: nothing ran, so
    // the session must not narrate work that was declined.
    expect(stateEffects.toolCallEvent.silent).toBe(true);
  });

  it("covers every action tool, not just end_call", async () => {
    // The exact pair executed off "Ah!" on the real call.
    mockGetAppointmentById.mockResolvedValue({
      id: "a1",
      client_phone: "+15551234567",
      scheduled_at: FUTURE_SLOT,
      status: "scheduled",
    });
    for (const fc of [
      { id: "1", name: "cancel_appointment_db", args: { appointment_id: "a1" } },
      { id: "2", name: "reschedule_appointment_db", args: { new_scheduled_at: FUTURE_SLOT } },
      { id: "3", name: "correct_appointment_name", args: { client_name: "Nathan Dodla" } },
      { id: "4", name: "record_customer_request", args: { request_type: "message" } },
    ]) {
      const { functionResponse } = await executeToolCall(fc, ctxWith("umm"));
      expect(functionResponse.response.success, fc.name).toBe(false);
    }
    expect(mockUpdateAppointment).not.toHaveBeenCalled();
    expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
  });

  it("does NOT refuse on an acknowledgement, which is how people agree", async () => {
    // The whole reason this uses isHesitationOnly and not stripFillers, which
    // reduces all of these to the empty string. Refusing to book on "Okay."
    // would be a worse defect than the one being fixed.
    for (const said of ["Okay", "Okay.", "OK", "Right", "Mm-hmm", "uh-huh", "Yes", "Yep", "Sure"]) {
      mockCreateAppointment.mockResolvedValue(`appt-${said}`);
      const { functionResponse } = await book(ctxWith(said));
      expect(functionResponse.response.success, said).toBe(true);
    }
  });

  it("does not fire when the caller said nothing at all", async () => {
    // An empty turn is silence, which the silence ladder owns. Treating it here
    // would block a legitimate write after a pause.
    const { functionResponse } = await book(ctxWith(""));
    expect(functionResponse.response.success).toBe(true);
  });

  it("leaves the cascade byte-identical — it never sets the field", async () => {
    const ctx = ctxWith(undefined);
    delete ctx.lastCallerText;
    const { functionResponse } = await book(ctx);
    expect(functionResponse.response.success).toBe(true);
  });
});

describe("LVX50 — an unusable transcript cannot authorise a write either", () => {
  it("refuses the booking that a Korean-character transcript produced", async () => {
    const { functionResponse, stateEffects } = await book(ctxWith("에레는"));

    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    expect(functionResponse.response.message).toContain("did not transcribe as usable speech");
    expect(stateEffects.toolResult.message).toBe("Sorry, I didn't catch that — could you say it again?");
  });

  it("does not refuse a Spanish turn, which is a supported locale", async () => {
    const { functionResponse } = await book(ctxWith("Sí, el martes está bien"));
    expect(functionResponse.response.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The counters, end to end.
//
// A guard can fire correctly, block correctly, log correctly and contribute
// nothing to /api/debug/latency, with every one of its own unit tests passing.
// bumpCounter silently drops a name that is not in COUNTER_NAMES, so an
// unregistered guard blocks and reports nothing. Asserted through
// getLatencyStats, which is what the debug endpoint actually serves.
// ---------------------------------------------------------------------------
describe("consent counters reach getLatencyStats", () => {
  it("counts a hesitation refusal", async () => {
    await book(ctxWith("Ah!"));
    expect(counters().write_refused_hesitation).toBe(1);
    expect(counters().write_consent_checked).toBe(0);
  });

  it("counts an unusable-transcript refusal", async () => {
    await book(ctxWith("에레는"));
    expect(counters().live_unusable_transcript).toBe(1);
  });

  it("counts the POSITIVE case, so a clean call is distinguishable from no call", async () => {
    // The measure that makes the pair readable. Without this, a call that
    // booked cleanly and a call that never attempted a write both report
    // write_refused_hesitation: 0 — which is exactly how LVX45 sat in the tree
    // for a day looking finished while its gate was unreachable.
    await book(ctxWith("Yes, please"));
    expect(counters().write_consent_checked).toBe(1);
    expect(counters().write_refused_hesitation).toBe(0);
  });
});
