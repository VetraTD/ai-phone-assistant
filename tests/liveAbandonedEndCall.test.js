// ---------------------------------------------------------------------------
// LVX72's prevention half, in the only form that is safe to ship today: a
// COUNT, and no refusal.
//
// The defect: a write is refused, the caller answers the refusal, the model
// never retries, and it announces the change as done. On call 6 of the
// 2026-09-04 round the caller hung up believing the name on their appointment
// had changed. The row still read Nithin Dodla.
//
// postcall_verify now detects it -- verdict write_abandoned, and it has been
// seen both firing on the abandoned call and staying silent on the successful
// one, so its false-positive rate is not unknown. But detection happens after
// the caller has hung up. The clean prevention is the end_call gate: refuse the
// hang-up once while an abandoned write is outstanding.
//
// That gate is NOT built here, and the reason is the whole point of this file.
// It carries a real hair-trigger risk -- a caller who genuinely changed their
// mind mid-change would be held on the line -- and this codebase has already
// paid for a guard with a hair trigger: LVX21 delivered 0.5 s of audio in 25
// seconds. The question that decides whether refusing is safe is "on real
// calls, how often would a caller have been held?", and until now nothing could
// answer it.
//
// So: count first, act once the counter says how often it fires when nothing is
// wrong. The same ladder live_claim_without_action climbed, which is why
// LIVE_CLAIM_GUARD could be left unset without losing the evidence.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/db.js", () => ({
  createAppointment: async () => null,
  createAppointmentIfAvailable: async () => ({ full: true }),
  countScheduledOverlapping: async () => 0,
  listScheduledBetween: async () => [],
  listAppointmentsByCaller: async () => [],
  updateAppointmentStatus: async () => false,
  updateAppointment: async () => false,
  getAppointmentById: async () => null,
}));

vi.mock("../services/integrations.js", () => ({ executeIntegration: async () => ({}) }));

const { executeToolCall } = await import("../services/tools.js");
const { getLatencyStats, clearStats } = await import("../lib/voice/metrics.js");

const CONFIG = {
  businessName: "Brightwork Family Dental",
  timezone: "America/Chicago",
  allowedTasks: ["general_question", "take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
};

const baseCtx = {
  businessId: "b1",
  callerPhone: "+14699338887",
  callId: "c1",
  config: CONFIG,
  step: "confirm",
  callerTurnCount: 4,
  completedActionThisCall: true,
  lastCallerText: "No, that's everything, thanks.",
};

const endCall = (ctx) => executeToolCall({ id: "fc1", name: "end_call", args: { reason: "done" } }, ctx);
const c = () => getLatencyStats().turnTaking;

describe("LVX72 — an abandoned write outstanding at hang-up", () => {
  beforeEach(() => clearStats());

  it("counts the check running when nothing was abandoned", async () => {
    // The positive twin, and the case it exists for. A clean call and a call
    // where the wire is broken both leave the fault counter at 0 -- which is
    // exactly how the hesitation gate sat unreachable for the life of a
    // deployment while end_call_refused_hesitation read 0 throughout.
    const { functionResponse } = await endCall({ ...baseCtx, abandonedWrites: [] });

    expect(functionResponse.response.success).toBe(true);
    expect(c().end_call_abandoned_check_ran).toBe(1);
    expect(c().end_call_would_refuse_abandoned).toBe(0);
  });

  it("counts an end_call that arrives with a refused write never retried", async () => {
    const { functionResponse } = await endCall({
      ...baseCtx,
      abandonedWrites: ["correct_appointment_name"],
    });

    expect(c().end_call_abandoned_check_ran).toBe(1);
    expect(c().end_call_would_refuse_abandoned).toBe(1);
    // AND THE CALL STILL ENDS. This is the assertion that says "count only".
    // If a later change starts refusing, this test is where it must be an
    // explicit decision rather than a side effect.
    expect(functionResponse.response.success).toBe(true);
  });

  it("stays inert for the cascade, which passes no abandoned set at all", async () => {
    // services/tools.js is shared. The cascade never populates this field, so
    // the check must no-op there rather than counting a clean run it did not
    // observe -- an all-zeros reading on the cascade is the honest one.
    const { functionResponse } = await endCall({ ...baseCtx });

    expect(functionResponse.response.success).toBe(true);
    expect(c().end_call_abandoned_check_ran).toBe(0);
    expect(c().end_call_would_refuse_abandoned).toBe(0);
  });

  it("counts on a REFUSED end_call too, not only an accepted one", async () => {
    // The abandoned write is the interesting fact whatever the gate decides
    // about the hang-up, and the counts must not be conditional on the branch
    // taken -- otherwise the number that decides whether refusing is safe is
    // itself sampled by a different refusal.
    const { functionResponse } = await endCall({
      ...baseCtx,
      step: "gather_details",
      callerTurnCount: 1,
      completedActionThisCall: false,
      abandonedWrites: ["cancel_appointment_db"],
    });

    expect(functionResponse.response.success).toBe(false);
    expect(c().end_call_abandoned_check_ran).toBe(1);
    expect(c().end_call_would_refuse_abandoned).toBe(1);
  });
});
