// ---------------------------------------------------------------------------
// LVX48's shape, in a new place: a note claimed and never written.
//
// On call 5 of the 2026-09-04 round the caller asked for something to be added
// to their appointment -- "could you put that I have some dirt in the back" --
// and the assistant said:
//
//   "I've added that note for you."
//
// The row's notes column still read "cleaning". No tool had run carrying that
// text, because NO TOOL COULD: the appointment pack declared book, check,
// cancel, reschedule and correct_appointment_name, and nothing that could touch
// notes. The model was asked for something the system cannot do, and answered
// as though it had done it.
//
// Neither guard saw it. The claim detector missed it because a booking DID
// happen -- it just was not the one described -- and the write ledger saw a
// successful book_appointment. That is the LVX59 class, and it is why this is a
// tool rather than another prompt rule: there is no wording that makes a model
// reliably refuse a reasonable request, and "I cannot do that" is only honest
// while it stays true.
//
// So: either a tool that does it, or a refusal that admits it cannot. This is
// the first, with the second as its failure path.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetAppointmentById = vi.fn();
const mockUpdateAppointment = vi.fn();
vi.mock("../services/db.js", () => ({
  createAppointment: vi.fn(),
  createAppointmentIfAvailable: vi.fn(),
  countScheduledOverlapping: vi.fn().mockResolvedValue(0),
  listScheduledBetween: vi.fn().mockResolvedValue([]),
  listAppointmentsByCaller: vi.fn(),
  updateAppointmentStatus: vi.fn(),
  updateAppointment: (...a) => mockUpdateAppointment(...a),
  getAppointmentById: (...a) => mockGetAppointmentById(...a),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";
import { buildAllDeclarations } from "../services/gemini.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

/**
 * A FIXTURE DATE MUST NOT BE A LITERAL. Written 2026-09-04 as
 * "2026-09-10T14:00:00Z" and it went off on 2026-09-10 at 14:00 UTC, six days
 * later, taking five tests across two files with it.
 *
 * capabilities/appointments.js:527 filters upcomingAppointments to `t > now`,
 * so once this instant passed the caller had ZERO upcoming appointments and
 * resolveAppointmentId stopped resolving. Two tests then failed for the honest
 * reason. The third INVERTED: with the only past row filtered out of a
 * two-appointment list, the "genuinely ambiguous" case became unambiguous and
 * a write the test exists to forbid went through.
 *
 * Nothing in production was wrong on either day. The test was.
 */
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

const MINE = {
  id: "appt-mine",
  client_name: "Nithin Dodla",
  client_phone: "+14699338887",
  scheduled_at: inDays(1),
  status: "scheduled",
  notes: "cleaning",
};

const baseCtx = () => ({
  businessId: "biz-1",
  callerPhone: "+14699338887",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: { timezone: "America/Chicago" },
  callerContext: { callCount: 2, lastCallSummary: null, upcomingAppointments: [MINE] },
  spellingSettled: true,
});

const c = () => getLatencyStats().turnTaking;

describe("add_appointment_note — the tool the claim needed", () => {
  beforeEach(() => {
    clearStats();
    mockGetAppointmentById.mockReset();
    mockUpdateAppointment.mockReset();
  });

  it("is declared for a tenant whose appointments are enabled", () => {
    // The whole defect was a missing capability. If it is not in the
    // declarations the model cannot call it, and it will say it did anyway.
    const config = {
      businessName: "Brightwork Family Dental",
      allowedTasks: ["book_appointment", "check_appointment", "cancel_reschedule"],
      capabilities: { appointments: { enabled: true, adapter: "internal" } },
      timezone: "America/Chicago",
    };
    const names = buildAllDeclarations(config, {}).map((d) => d.name);
    expect(names).toContain("add_appointment_note");
  });

  it("APPENDS to what is already there rather than replacing it", async () => {
    // THE PART THAT MATTERS. On the call that found this, the row's notes read
    // "cleaning" -- the reason for the appointment. A tool that overwrote it
    // would have destroyed the booking's own subject in order to record a
    // detail about it, and the caller would never know.
    mockGetAppointmentById.mockResolvedValue(MINE);
    mockUpdateAppointment.mockResolvedValue(true);

    const { functionResponse, stateEffects } = await executeToolCall(
      { id: "fc1", name: "add_appointment_note", args: { note: "has some dirt in the back" } },
      baseCtx()
    );

    expect(functionResponse.response.success).toBe(true);
    const [id, updates, businessId] = mockUpdateAppointment.mock.calls[0];
    expect(id).toBe("appt-mine");
    expect(businessId).toBe("biz-1");
    expect(updates.notes).toBe("cleaning — has some dirt in the back");
    expect(c().appointment_note_added).toBe(1);
    expect(stateEffects.toolResult.callerSafe).toBe(true);
  });

  it("writes the note alone when the row had none", async () => {
    mockGetAppointmentById.mockResolvedValue({ ...MINE, notes: null });
    mockUpdateAppointment.mockResolvedValue(true);

    await executeToolCall(
      { id: "fc1", name: "add_appointment_note", args: { note: "parking round the back" } },
      baseCtx()
    );

    expect(mockUpdateAppointment.mock.calls[0][1].notes).toBe("parking round the back");
  });

  it("REFUSES when there is no appointment to attach it to, and admits it", async () => {
    // The failure path is the whole point of the item. A caller with nothing
    // booked asks for a note; the honest answer is that there is nothing to put
    // it on -- not silence, and not a claim.
    mockGetAppointmentById.mockResolvedValue(null);

    const ctx = baseCtx();
    ctx.callerContext = { callCount: 1, lastCallSummary: null, upcomingAppointments: [] };

    const { functionResponse, stateEffects } = await executeToolCall(
      { id: "fc1", name: "add_appointment_note", args: { note: "allergic to latex" } },
      ctx
    );

    expect(functionResponse.response.success).toBe(false);
    // LVX34's shape: not a failure, what is actually true, what to do instead.
    // A bare refusal is what made the model answer "someone will call you back".
    expect(functionResponse.response.message).toMatch(/NOT A FAILURE/);
    expect(functionResponse.response.message).toMatch(/record_customer_request|take a message/i);
    expect(mockUpdateAppointment).not.toHaveBeenCalled();
    expect(c().appointment_note_refused_no_row).toBe(1);
    expect(c().appointment_note_added).toBe(0);
    expect(stateEffects.toolResult.success).toBe(false);
  });

  it("refuses an empty note without touching the row", async () => {
    mockGetAppointmentById.mockResolvedValue(MINE);

    const { functionResponse } = await executeToolCall(
      { id: "fc1", name: "add_appointment_note", args: { note: "   " } },
      baseCtx()
    );

    expect(functionResponse.response.success).toBe(false);
    expect(mockUpdateAppointment).not.toHaveBeenCalled();
  });

  it("will not write to a row that belongs to someone else", async () => {
    // The same identity check every other change tool runs. A note is a write
    // to another person's record, and nothing about it being small changes that.
    mockGetAppointmentById.mockResolvedValue({
      ...MINE,
      id: "appt-theirs",
      client_phone: "+15550001111",
      client_name: "Someone Else",
    });

    const { functionResponse } = await executeToolCall(
      { id: "fc1", name: "add_appointment_note", args: { note: "x", appointment_id: "appt-theirs" } },
      baseCtx()
    );

    expect(functionResponse.response.success).toBe(false);
    expect(mockUpdateAppointment).not.toHaveBeenCalled();
  });

  it("reports the write failing rather than claiming it worked", async () => {
    // The exact defect, one layer down: if the update returns false the caller
    // must not be told it is done.
    mockGetAppointmentById.mockResolvedValue(MINE);
    mockUpdateAppointment.mockResolvedValue(false);

    const { functionResponse } = await executeToolCall(
      { id: "fc1", name: "add_appointment_note", args: { note: "something" } },
      baseCtx()
    );

    expect(functionResponse.response.success).toBe(false);
    expect(c().appointment_note_added).toBe(0);
  });
});
