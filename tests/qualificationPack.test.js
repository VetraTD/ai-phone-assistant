// tests/qualificationPack.test.js
/**
 * S3-10 (spec §12.2, Task 24): the `qualification` CAMPAIGN pack --
 * `record_answer({key, value})` -- and the `book_appointment` booking gate
 * it feeds (lib/capabilities/requirements.js's checkQualificationBookingGate,
 * dispatched from services/tools.js).
 *
 * Unit level, driving the pack directly through the same ctx.deps seam every
 * other capability pack is tested through (see tests/outboundPacks.test.js's
 * own doc) -- no real database. DB-real coverage for the booking side
 * (clientPhone = party.phone, a real clash, the booked -> outcome wiring) is
 * tests/db/outboundBooking.test.js.
 */
import { describe, it, expect, vi } from "vitest";
import qualification from "../capabilities/qualification.js";
import { checkQualificationBookingGate } from "../lib/capabilities/requirements.js";
import { executeToolCall } from "../services/tools.js";
import { buildAllDeclarations } from "../services/gemini.js";

const CALLING_WINDOW = { mon_fri: "09:00-20:00", sat: "10:00-16:00", sun: null, outside_window: "queue" };

function outboundCallWithQuestions(questions, capabilities = ["qualification", "appointments"]) {
  return {
    config: { capabilities, calling_window: CALLING_WINDOW, questions },
    contact: { firstName: "Priya", timezone: "America/Chicago", phone: "+15559876543" },
    campaign: { audience: "business" },
  };
}

const REQUIRED_QUESTION = [{ key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text" }];
const OPTIONAL_QUESTION = [{ key: "referral_source", ask: "How did you hear about us?", required: false, type: "text" }];

function fakeDeps(overrides = {}) {
  return { mergeCallAnswers: vi.fn(async () => {}), ...overrides };
}

// ---------------------------------------------------------------------------
// record_answer -- declaration gating (named risk 3: never on inbound)
// ---------------------------------------------------------------------------
describe("qualification.tools() -- declaration gating", () => {
  it("declares nothing at all with no ctx.outboundCall (inbound shape)", () => {
    expect(qualification.tools({}, {})).toEqual([]);
    expect(qualification.tools({}, undefined)).toEqual([]);
  });

  it("declares nothing when the campaign's capabilities list omits qualification", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION, ["appointments"]) };
    expect(qualification.tools({}, ctx)).toEqual([]);
  });

  it("declares record_answer, with an enum of the campaign's own question keys, when qualification is listed", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION) };
    const decls = qualification.tools({}, ctx);
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe("record_answer");
    expect(decls[0].parameters.properties.key.enum).toEqual(["clinic_name"]);
  });

  it("inbound declares no record_answer even through the full buildAllDeclarations union", () => {
    const names = buildAllDeclarations({ allowedTasks: [] }, {}).map((d) => d.name);
    expect(names).not.toContain("record_answer");
  });
});

// ---------------------------------------------------------------------------
// qualification.prompt() -- fix round 1 (controller Ruling R-S3-10-prompt):
// the full Task 24 contract binds. static.capabilities must list every
// askable question, marked required or optional, gated exactly like tools().
// ---------------------------------------------------------------------------
const TWO_QUESTIONS = [
  { key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text" },
  { key: "referral_source", ask: "How did you hear about us?", required: false, type: "text" },
];

describe("qualification.prompt() -- static.capabilities lists the questions, marked required/optional", () => {
  it("renders nothing at all with no ctx.outboundCall (inbound shape)", () => {
    expect(qualification.prompt({}, {})).toEqual({ static: { capabilities: [] } });
    expect(qualification.prompt({}, undefined)).toEqual({ static: { capabilities: [] } });
  });

  it("renders nothing when the campaign's capabilities list omits qualification", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(TWO_QUESTIONS, ["appointments"]) };
    expect(qualification.prompt({}, ctx)).toEqual({ static: { capabilities: [] } });
  });

  it("renders nothing when qualification is listed but the campaign has no questions", () => {
    const ctx = { outboundCall: outboundCallWithQuestions([]) };
    expect(qualification.prompt({}, ctx)).toEqual({ static: { capabilities: [] } });
  });

  it("lists every question's ask text and key, marked required or optional", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(TWO_QUESTIONS) };
    const { static: stat } = qualification.prompt({}, ctx);
    const joined = stat.capabilities.join(" | ");
    expect(joined).toContain("What's the clinic called?");
    expect(joined).toContain("clinic_name");
    expect(joined).toMatch(/clinic_name \(required\)/);
    expect(joined).toContain("How did you hear about us?");
    expect(joined).toContain("referral_source");
    expect(joined).toMatch(/referral_source \(optional\)/);
  });

  it("every entry is a single line -- no embedded newlines that would break the comma-joined CAPABILITIES sentence", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(TWO_QUESTIONS) };
    const { static: stat } = qualification.prompt({}, ctx);
    for (const clause of stat.capabilities) {
      expect(clause).not.toMatch(/\n/);
    }
  });

  it("skips a question missing an ask or a key, but still renders the others", () => {
    const ctx = {
      outboundCall: outboundCallWithQuestions([
        { key: "no_ask", ask: "", required: true, type: "text" },
        { key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text" },
      ]),
    };
    const { static: stat } = qualification.prompt({}, ctx);
    const joined = stat.capabilities.join(" | ");
    expect(joined).toContain("What's the clinic called?");
    expect(joined).not.toContain("no_ask");
  });
});

// ---------------------------------------------------------------------------
// record_answer -- execute()
// ---------------------------------------------------------------------------
describe("qualification.execute() -- record_answer", () => {
  it("refuses an unknown key, naming the valid ones", async () => {
    const deps = fakeDeps();
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION), callSid: "CA1", deps };
    const fc = { id: "fc1", name: "record_answer", args: { key: "not_a_real_key", value: "hello" } };
    const out = await qualification.execute(fc, ctx);
    expect(out.functionResponse.response.success).toBe(false);
    expect(out.functionResponse.response.message).toMatch(/clinic_name/);
    expect(deps.mergeCallAnswers).not.toHaveBeenCalled();
  });

  it("refuses a value over 500 characters, naming the valid keys", async () => {
    const deps = fakeDeps();
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION), callSid: "CA1", deps };
    const fc = { id: "fc2", name: "record_answer", args: { key: "clinic_name", value: "x".repeat(501) } };
    const out = await qualification.execute(fc, ctx);
    expect(out.functionResponse.response.success).toBe(false);
    expect(out.functionResponse.response.message).toMatch(/clinic_name/);
    expect(deps.mergeCallAnswers).not.toHaveBeenCalled();
  });

  it("accepts exactly 500 characters", async () => {
    const deps = fakeDeps();
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION), callSid: "CA1", deps };
    const fc = { id: "fc2b", name: "record_answer", args: { key: "clinic_name", value: "x".repeat(500) } };
    const out = await qualification.execute(fc, ctx);
    expect(out.functionResponse.response.success).toBe(true);
  });

  // Minor (review): a missing mergeCallAnswers wire used to silently no-op
  // (`?.()`), and the tool still answered "Recorded." -- unlike
  // opt_out/outcome.js's own writes, which refuse rather than claim success
  // for a write that never happened.
  it("a missing mergeCallAnswers wire refuses -- never claims 'Recorded.' for a write that did not happen", async () => {
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION), callSid: "CA1", deps: {} };
    const fc = { id: "fc-wire", name: "record_answer", args: { key: "clinic_name", value: "Riverside Clinic" } };
    const out = await qualification.execute(fc, ctx);
    expect(out.functionResponse.response.success).toBe(false);
  });

  it("records a valid answer: capabilityState, the capabilityEffect, and a durable write via mergeCallAnswers", async () => {
    const deps = fakeDeps();
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION), callSid: "CA1", deps };
    const fc = { id: "fc3", name: "record_answer", args: { key: "clinic_name", value: "Riverside Clinic" } };
    const out = await qualification.execute(fc, ctx);
    expect(out.functionResponse.response.success).toBe(true);
    expect(out.stateEffects.capabilityState.qualification.answers).toEqual({ clinic_name: "Riverside Clinic" });
    expect(out.stateEffects.capabilityEffects).toEqual([{ capability: "qualification", type: "answered", data: { key: "clinic_name" } }]);
    expect(deps.mergeCallAnswers).toHaveBeenCalledWith("CA1", { clinic_name: "Riverside Clinic" });
  });

  it("merges a new answer onto answers already recorded this call, rather than replacing them", async () => {
    const deps = fakeDeps();
    const ctx = {
      outboundCall: outboundCallWithQuestions([...REQUIRED_QUESTION, { key: "phone", ask: "Best number?", required: false, type: "text" }]),
      callSid: "CA1",
      deps,
      capabilityState: { qualification: { answers: { clinic_name: "Riverside Clinic" } } },
    };
    const fc = { id: "fc4", name: "record_answer", args: { key: "phone", value: "555-1234" } };
    const out = await qualification.execute(fc, ctx);
    expect(out.stateEffects.capabilityState.qualification.answers).toEqual({
      clinic_name: "Riverside Clinic",
      phone: "555-1234",
    });
  });

  it("onEffect leaves a history note naming the recorded key, and is a no-op for any other effect type", () => {
    const addHistoryNote = vi.fn();
    qualification.onEffect({ capability: "qualification", type: "answered", data: { key: "clinic_name" } }, { addHistoryNote });
    expect(addHistoryNote).toHaveBeenCalledTimes(1);
    expect(addHistoryNote.mock.calls[0][0]).toMatch(/clinic_name/);

    const addHistoryNote2 = vi.fn();
    qualification.onEffect({ capability: "qualification", type: "something_else", data: {} }, { addHistoryNote: addHistoryNote2 });
    expect(addHistoryNote2).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkQualificationBookingGate -- the pure gate function
// ---------------------------------------------------------------------------
describe("checkQualificationBookingGate", () => {
  it("is a no-op with no outboundCall (inbound)", () => {
    expect(checkQualificationBookingGate({})).toEqual({ ok: true, missing: [] });
  });

  it("is a no-op when qualification is not in the campaign's capabilities", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION, ["appointments"]) };
    expect(checkQualificationBookingGate(ctx)).toEqual({ ok: true, missing: [] });
  });

  it("is a no-op when the campaign has no required question (an optional question never blocks)", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(OPTIONAL_QUESTION) };
    expect(checkQualificationBookingGate(ctx)).toEqual({ ok: true, missing: [] });
  });

  it("is a no-op once the required answer is already recorded", () => {
    const ctx = {
      outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION),
      capabilityState: { qualification: { answers: { clinic_name: "Riverside Clinic" } } },
    };
    expect(checkQualificationBookingGate(ctx)).toEqual({ ok: true, missing: [] });
  });

  it("refuses once, naming the missing key, when the required answer is absent and the ceiling is unspent", () => {
    const ctx = { outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION) };
    const result = checkQualificationBookingGate(ctx);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["clinic_name"]);
    expect(result.message).toMatch(/clinic_name|clinic called/);
  });

  it("allows the booking once the one-shot ceiling is already spent, still reporting what is missing", () => {
    const ctx = {
      outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION),
      capabilityState: { qualification: { bookingGateRefusals: 1 } },
    };
    const result = checkQualificationBookingGate(ctx);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual(["clinic_name"]);
  });
});

// ---------------------------------------------------------------------------
// The booking gate through the REAL dispatch (services/tools.js), end to end:
// refused exactly once, then allowed, with the counter living in
// capabilityState rather than merely being asked for in the prompt (memory
// prompt-caps-need-counters), and the missing key persisted via
// mergeCallAnswers on the second attempt.
// ---------------------------------------------------------------------------
function makeBookDeps() {
  const createAppointmentIfAvailable = vi.fn(async () => ({ id: "appt-qual-1" }));
  return {
    deps: {
      createAppointmentIfAvailable,
      listAppointmentsByCaller: vi.fn(async () => []),
      getAppointmentById: vi.fn(async () => null),
      updateAppointment: vi.fn(async () => true),
      updateAppointmentStatus: vi.fn(async () => true),
      countScheduledOverlapping: vi.fn(async () => 0),
      listScheduledBetween: vi.fn(async () => []),
      executeIntegration: vi.fn(),
      captureException: vi.fn(),
      mergeCallAnswers: vi.fn(async () => {}),
    },
    createAppointmentIfAvailable,
  };
}

const futureIso = (days = 3) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
};

describe("book_appointment -- the qualification gate through the real dispatch (services/tools.js)", () => {
  const VERIFIED = { phone: "+15559876543", source: "dialed", verified: true };

  function baseCtx(deps, capabilityState = {}) {
    return {
      businessId: "biz-qual",
      callId: "call-qual-1",
      callSid: "CA-qual-1",
      integrations: [],
      capabilityState,
      config: {},
      spellingSettled: true,
      party: VERIFIED,
      outboundCall: outboundCallWithQuestions(REQUIRED_QUESTION),
      depsOverride: deps,
    };
  }

  it("refuses the first attempt, naming the missing key, and does not book", async () => {
    const { deps, createAppointmentIfAvailable } = makeBookDeps();
    const ctx = baseCtx(deps);
    const fc = { id: "fc1", name: "book_appointment", args: { client_name: "Priya Shah", scheduled_at: futureIso() } };
    const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/clinic_name|clinic called/);
    expect(createAppointmentIfAvailable).not.toHaveBeenCalled();
    expect(stateEffects.capabilityState.qualification.bookingGateRefusals).toBe(1);
  });

  it("allows the SECOND attempt through (the ceiling is spent) and flags missing_required via mergeCallAnswers", async () => {
    const { deps, createAppointmentIfAvailable } = makeBookDeps();
    // Simulate the engine having merged the first refusal's capabilityState
    // patch back in, exactly as services/gemini.js does between rounds.
    const ctx = baseCtx(deps, { qualification: { bookingGateRefusals: 1 } });
    const fc = { id: "fc2", name: "book_appointment", args: { client_name: "Priya Shah", scheduled_at: futureIso() } };
    const { functionResponse } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(true);
    expect(createAppointmentIfAvailable).toHaveBeenCalledTimes(1);
    expect(deps.mergeCallAnswers).toHaveBeenCalledWith("CA-qual-1", { _missing_required: ["clinic_name"] });
  });

  it("an optional question never blocks: books on the first attempt with no refusal at all", async () => {
    const { deps, createAppointmentIfAvailable } = makeBookDeps();
    const ctx = baseCtx(deps);
    ctx.outboundCall = outboundCallWithQuestions(OPTIONAL_QUESTION);
    const fc = { id: "fc3", name: "book_appointment", args: { client_name: "Priya Shah", scheduled_at: futureIso() } };
    const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(true);
    expect(createAppointmentIfAvailable).toHaveBeenCalledTimes(1);
    expect(stateEffects.capabilityState?.qualification).toBeUndefined();
  });

  it("books straight through once the required answer has already been recorded this call", async () => {
    const { deps, createAppointmentIfAvailable } = makeBookDeps();
    const ctx = baseCtx(deps, { qualification: { answers: { clinic_name: "Riverside Clinic" } } });
    const fc = { id: "fc4", name: "book_appointment", args: { client_name: "Priya Shah", scheduled_at: futureIso() } };
    const { functionResponse } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(true);
    expect(createAppointmentIfAvailable).toHaveBeenCalledTimes(1);
    expect(deps.mergeCallAnswers).not.toHaveBeenCalled();
  });

  it("inbound (no outboundCall) is unaffected: the gate never fires there at all", async () => {
    const { deps, createAppointmentIfAvailable } = makeBookDeps();
    const ctx = {
      businessId: "biz-qual-inbound",
      callId: "call-qual-inbound",
      callSid: "CA-qual-inbound",
      callerPhone: "+15551234567",
      integrations: [],
      capabilityState: {},
      config: {},
      spellingSettled: true,
      depsOverride: deps,
    };
    const fc = { id: "fc5", name: "book_appointment", args: { client_name: "Jane Smith", scheduled_at: futureIso() } };
    const { functionResponse } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(true);
    expect(createAppointmentIfAvailable).toHaveBeenCalledTimes(1);
  });
});
