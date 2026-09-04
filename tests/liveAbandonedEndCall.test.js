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

describe("LVX76 — the refusal that made it say goodbye and repeat itself", () => {
  beforeEach(() => clearStats());

  // -------------------------------------------------------------------------
  // Confirmed by the owner on a real call, 2026-09-04. The caller said "Okay"
  // meaning "go on"; the model called end_call; the hesitation gate refused --
  // CORRECTLY, the caller went on to book -- and handed back:
  //
  //   "The caller has not answered yet — all they said was a hesitation
  //    ("um", "uh") ... Do not end the call. Wait, or ask again gently."
  //
  // Two faults, both in the wording. It described an acknowledgement as a
  // hesitation, which is false; and "ask again" named no object, so the model
  // re-delivered a forty-word answer verbatim. Then, having been told the call
  // was not ending, it said goodbye anyway.
  // -------------------------------------------------------------------------

  const hesitate = (text) =>
    executeToolCall(
      { id: "fc1", name: "end_call", args: { reason: "caller is done" } },
      { ...baseCtx, lastCallerText: text }
    );

  it("still refuses, and still counts — the DECISION was never the problem", async () => {
    const { functionResponse } = await hesitate("Okay.");

    expect(functionResponse.response.success).toBe(false);
    expect(c().end_call_refused_hesitation).toBe(1);
  });

  it("no longer tells the model the caller hesitated when they said 'okay'", async () => {
    // A model handed a false description of its input reasons onward from it.
    const { functionResponse } = await hesitate("Okay.");
    const m = functionResponse.response.message;

    expect(m).not.toMatch(/has not answered yet/i);
    expect(m).not.toMatch(/someone thinking/i);
    // What is actually true, and all that is knowable here.
    expect(m).toMatch(/does not settle whether they are finished/i);
  });

  it("forbids the goodbye and the repeat by name", async () => {
    const { functionResponse } = await hesitate("Okay.");
    const m = functionResponse.response.message;

    expect(m).toMatch(/do NOT say goodbye/i);
    expect(m).toMatch(/do NOT sign off/i);
    expect(m).toMatch(/do NOT repeat anything you have already said/i);
  });

  it("bounds what to do instead — one sentence, then wait", async () => {
    // "Ask again gently" named no object, and the model chose the whole
    // previous turn as the thing to ask again.
    const { functionResponse } = await hesitate("Umm.");
    const m = functionResponse.response.message;

    expect(m).toMatch(/ONE short sentence/i);
    expect(m).toMatch(/wait for their answer/i);
    expect(m).not.toMatch(/ask again gently/i);
  });

  it("allows SILENCE when it has already asked — the doubling on call 2", async () => {
    // end_call's declaration requires the sign-off in the SAME response as the
    // call, so a refused end_call always follows a turn the caller has already
    // heard. An unconditional "say one short sentence asking whether there is
    // anything else" therefore asks for a thing just said, and on call 2 the
    // caller heard it twice, rephrased. Silence has to be an allowed outcome,
    // and its cost is bounded by the silence ladder at 6-10 s.
    const { functionResponse } = await hesitate("Okay.");
    const m = functionResponse.response.message;

    expect(m).toMatch(/ALREADY asked/i);
    expect(m).toMatch(/say NOTHING further/i);
    expect(m).toMatch(/Only if you have not asked yet/i);
  });

  it("leaves the caller-facing line alone — only the model-facing text changed", async () => {
    // The split is the point: the caller hears one short question, and the
    // instructions the model reads are never spoken.
    const { stateEffects } = await hesitate("Okay.");

    expect(stateEffects.toolResult.callerSafe).toBe(true);
    expect(stateEffects.toolResult.message).toBe("Is there anything else I can help you with?");
  });

  it("still lets a genuine goodbye through", async () => {
    // The guard against over-correcting. "No, that's everything" is not a
    // hesitation and must still end the call.
    const { functionResponse } = await hesitate("No, that's everything, thanks.");

    expect(functionResponse.response.success).toBe(true);
    expect(c().end_call_refused_hesitation).toBe(0);
  });
});

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

  it("REFUSES an end_call that arrives with a refused write never retried", async () => {
    // CHANGED 2026-09-04. This used to assert that the call still ended, so
    // that starting to refuse had to be a deliberate decision rather than a
    // side effect. It is now that deliberate decision, on three calls of
    // evidence: end_call_would_refuse_abandoned read 0, 0, 1 -- silent on two
    // clean calls, firing once on a booking that was refused for a spelling,
    // spelled, never retried, and then announced as done with booked_rows 0.
    const { functionResponse, stateEffects } = await endCall({
      ...baseCtx,
      abandonedWrites: ["book_appointment"],
    });

    expect(c().end_call_abandoned_check_ran).toBe(1);
    expect(c().end_call_would_refuse_abandoned).toBe(1);
    expect(c().end_call_refused_abandoned).toBe(1);
    expect(functionResponse.response.success).toBe(false);
    // Names the tool, because "something was abandoned" is not actionable --
    // LVX71's mistake one layer up.
    expect(functionResponse.response.message).toMatch(/book_appointment/);
    expect(functionResponse.response.message).toMatch(/NOTHING was saved/);
    // Either finish it or say it did not happen. Both are acceptable; claiming
    // it is done is not.
    expect(functionResponse.response.message).toMatch(/tell them plainly that it did not go through/i);
    expect(functionResponse.response.message).toMatch(/do NOT say goodbye/i);
    expect(stateEffects.toolResult.callerSafe).toBe(true);
  });

  it("refuses ONCE — the second attempt goes through", async () => {
    // The hair trigger this whole ladder existed to avoid. One refusal is a
    // question the caller can answer; two is a trap, and LVX21 is what that
    // costs here. The latch is owned by lib/voice/live/tools.js because
    // services/tools.js is stateless and shared with the cascade.
    const { functionResponse } = await endCall({
      ...baseCtx,
      abandonedWrites: ["book_appointment"],
      abandonedHangupRefusalSpent: true,
    });

    expect(functionResponse.response.success).toBe(true);
    // Still COUNTED, though. The situation has not gone away just because the
    // refusal is spent, and the two counters diverging is how a second attempt
    // becomes visible at all.
    expect(c().end_call_would_refuse_abandoned).toBe(1);
    expect(c().end_call_refused_abandoned).toBe(0);
  });

  it("outranks the hesitation refusal when both apply", async () => {
    // Both keep the line open, but only this one tells the model a write is
    // missing. A caller told their booking exists when it does not is a worse
    // outcome than a caller asked twice whether they are finished.
    const { functionResponse } = await executeToolCall(
      { id: "fc1", name: "end_call", args: { reason: "done" } },
      { ...baseCtx, lastCallerText: "Okay.", abandonedWrites: ["book_appointment"] }
    );

    expect(functionResponse.response.message).toMatch(/NOTHING was saved/);
    expect(c().end_call_refused_abandoned).toBe(1);
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
