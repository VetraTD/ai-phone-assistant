// ---------------------------------------------------------------------------
// LVX74 — "not found" was spoken to the caller as "not yours".
//
// A caller asked to change the name on their own appointment, booked under
// their own number, calling from that number, and was told:
//
//   "I'm not able to make changes to appointments that are not booked under
//    your number. Can I take a message instead?"
//
// Every word false. And IDENTITY_MISMATCH_MESSAGE is callerSafe, so it is
// spoken verbatim rather than being a model-facing hint.
//
// ---------------------------------------------------------------------------
// Why it happened, and why the two halves are separable
// ---------------------------------------------------------------------------
//
// verifyAppointmentIdentity returned a single `false` for two different facts:
// the row could not be FOUND, and the row is not YOURS. Failing closed is
// right. Asserting the wrong reason to the caller is not.
//
// It could not be found because the model had no legitimate way to get an
// appointment_id: the CALLER CONTEXT block renders dates and names and no ids
// at all, so an id only exists after get_caller_appointments_from_db has run.
// On that call none had. LVX71's rewritten refusal makes the pressure worse,
// not better, because it now tells the model to call again WITH an id.
//
// Fixed here: the not-found case says so, and points at the tool that produces
// real ids. Whether ids belong in the prompt is a separate design question and
// is deliberately NOT decided here.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetAppointmentById = vi.fn();
const mockUpdateAppointment = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
vi.mock("../services/db.js", () => ({
  createAppointment: vi.fn(),
  createAppointmentIfAvailable: vi.fn(),
  countScheduledOverlapping: vi.fn().mockResolvedValue(0),
  listScheduledBetween: vi.fn().mockResolvedValue([]),
  listAppointmentsByCaller: vi.fn(),
  updateAppointmentStatus: (...a) => mockUpdateAppointmentStatus(...a),
  updateAppointment: (...a) => mockUpdateAppointment(...a),
  getAppointmentById: (...a) => mockGetAppointmentById(...a),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const MINE = {
  id: "appt-mine",
  client_name: "Nithin Dodla",
  client_phone: "+14699338887",
  scheduled_at: "2026-09-10T14:00:00Z",
  status: "scheduled",
};

const ctx = {
  businessId: "biz-1",
  callerPhone: "+14699338887",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: { timezone: "America/Chicago" },
  callerContext: { callCount: 2, lastCallSummary: null, upcomingAppointments: [MINE] },
  spellingSettled: true,
};

const CHANGE_TOOLS = [
  ["correct_appointment_name", { client_name: "Marcus Bell" }],
  ["cancel_appointment_db", {}],
  ["reschedule_appointment_db", { new_scheduled_at: "2026-09-12T14:00:00" }],
];

beforeEach(() => {
  clearStats();
  vi.clearAllMocks();
});

describe("LVX74 — an id that resolves to nothing", () => {
  for (const [name, args] of CHANGE_TOOLS) {
    describe(name, () => {
      const call = () =>
        executeToolCall({ id: "fc1", name, args: { ...args, appointment_id: "does-not-exist" } }, ctx);

      it("does not tell the caller their appointment is not theirs", async () => {
        mockGetAppointmentById.mockResolvedValue(null);
        const { functionResponse, stateEffects } = await call();

        expect(functionResponse.response.success).toBe(false);
        // The exact sentence a real caller heard about their own appointment.
        expect(functionResponse.response.message).not.toMatch(/booked under your number/i);
        expect(stateEffects.toolResult.message).not.toMatch(/booked under your number/i);
      });

      it("says the row could not be found, and points at the tool that has real ids", async () => {
        mockGetAppointmentById.mockResolvedValue(null);
        const { functionResponse } = await call();
        const m = functionResponse.response.message;

        expect(m).toContain("[not caller speech]");
        expect(m).toMatch(/could not be found|does not match/i);
        // The other half of the defect: the model cannot invent an id, and the
        // prompt gives it none, so the refusal has to name where ids come from.
        expect(m).toContain("get_caller_appointments_from_db");
      });

      it("writes nothing", async () => {
        mockGetAppointmentById.mockResolvedValue(null);
        await call();
        expect(mockUpdateAppointment).not.toHaveBeenCalled();
        expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
      });
    });
  }

  it("still refuses a row that really belongs to someone else, with the identity message", async () => {
    // The check must keep failing closed. Only the REASON changes, and only for
    // the case where there is no row at all.
    mockGetAppointmentById.mockResolvedValue({
      ...MINE,
      id: "appt-theirs",
      client_phone: "+15550001111",
      client_name: "Someone Else",
    });
    const { functionResponse, stateEffects } = await executeToolCall(
      { id: "fc1", name: "cancel_appointment_db", args: { appointment_id: "appt-theirs" } },
      ctx
    );

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/booked under your number/i);
    expect(stateEffects.toolResult.callerSafe).toBe(true);
    expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
  });

  it("still lets the caller change their own appointment", async () => {
    mockGetAppointmentById.mockResolvedValue(MINE);
    mockUpdateAppointment.mockResolvedValue(true);
    const { functionResponse } = await executeToolCall(
      { id: "fc1", name: "correct_appointment_name", args: { client_name: "Marcus Bell", appointment_id: "appt-mine" } },
      ctx
    );
    expect(functionResponse.response.success).toBe(true);
  });

  it("counts the not-found refusal", async () => {
    // The positive twin already exists: a change that lands shows up as
    // postcall_changed_rows, so a call with neither is a call that never tried.
    mockGetAppointmentById.mockResolvedValue(null);
    await executeToolCall(
      { id: "fc1", name: "cancel_appointment_db", args: { appointment_id: "nope" } },
      ctx
    );
    expect(getLatencyStats().turnTaking.write_refused_appointment_not_found).toBe(1);
  });
});
