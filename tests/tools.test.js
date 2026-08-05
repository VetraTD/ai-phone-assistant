import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();
const mockListAppointmentsByCaller = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
const mockUpdateAppointment = vi.fn();
const mockGetAppointmentById = vi.fn();
const mockExecuteIntegration = vi.fn();
const mockCaptureException = vi.fn();
const mockCountScheduledOverlapping = vi.fn().mockResolvedValue(0);
const mockListScheduledBetween = vi.fn().mockResolvedValue([]);

vi.mock("../services/supabase.js", () => ({
  createAppointment: (...args) => mockCreateAppointment(...args),
  // Internal booking now goes through the availability-aware RPC. For the tool
  // layer these tests exercise, the DB either accepts the booking (returns an
  // id) or the slot is full (returns null) — modelled here by delegating to the
  // same createAppointment mock, so a resolved id books and a rejection still
  // surfaces the "slot taken" path.
  createAppointmentIfAvailable: async (params) => {
    const id = await mockCreateAppointment(params);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: (...args) => mockCountScheduledOverlapping(...args),
  listScheduledBetween: (...args) => mockListScheduledBetween(...args),
  listAppointmentsByCaller: (...args) => mockListAppointmentsByCaller(...args),
  updateAppointmentStatus: (...args) => mockUpdateAppointmentStatus(...args),
  updateAppointment: (...args) => mockUpdateAppointment(...args),
  getAppointmentById: (...args) => mockGetAppointmentById(...args),
}));

vi.mock("../services/integrations.js", () => ({
  executeIntegration: (...args) => mockExecuteIntegration(...args),
}));

vi.mock("../lib/sentry.js", () => ({
  captureException: (...args) => mockCaptureException(...args),
}));

import { executeToolCall } from "../services/tools.js";
import { parseNaiveDateTime, zonedComponentsToUtcMs } from "../lib/capabilities/datetime.js";

const baseCtx = {
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: {},
};

// Minimal stand-in for CAPABILITY_DEPS, for the few tests that need to observe
// what a pack logs. depsOverride REPLACES the real surface wholesale, so every
// dep the exercised path touches has to be present or the pack throws.
const capabilityDepsFake = {
  getAppointmentById: (...a) => mockGetAppointmentById(...a),
  updateAppointment: (...a) => mockUpdateAppointment(...a),
  updateAppointmentStatus: (...a) => mockUpdateAppointmentStatus(...a),
  listAppointmentsByCaller: (...a) => mockListAppointmentsByCaller(...a),
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: async (p) => {
    const id = await mockCreateAppointment(p);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: (...a) => mockCountScheduledOverlapping(...a),
  listScheduledBetween: (...a) => mockListScheduledBetween(...a),
  executeIntegration: (...a) => mockExecuteIntegration(...a),
  captureException: (...a) => mockCaptureException(...a),
};

// book_appointment rejects any time in the past before it reaches the logic
// these tests are actually about, so a hardcoded date silently rots: this file
// was written with 2026-08-01 and every booking test began failing the moment
// that date passed. They then sat red, which is worse than the original
// staleness — a red test cannot warn anyone about a real booking regression.
//
// Computed relative to now so it cannot expire again. 30 days is far enough
// that no timezone anchoring can drag it into the past. The exact value is
// never asserted; these tests only care that it is carried through unchanged,
// so a moving date costs nothing in determinism.
//
// Tests that DO depend on a specific instant (the timezone-anchoring block
// below) freeze the clock with vi.setSystemTime instead, which is the right
// tool when the value itself is under test.
const FUTURE_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

// NAIVE, not "...T10:00:00Z" as this used to be.
//
// The tool declarations ask the model for a naive local wall clock, and every
// datetime a tool now hands BACK to the model is naive local too, so a naive
// string is what book_appointment actually receives in production. The old
// Z-suffixed fixture described a value the model has no legitimate way to
// produce, and it quietly exercised the "store the offset verbatim" branch —
// the branch that let a UK wall clock be persisted an hour off.
const FUTURE_SLOT = `${FUTURE_DATE}T10:00:00`;

// What FUTURE_SLOT anchors to once interpreted in the business timezone.
// baseCtx carries no timezone, so validateBookingTime falls back to
// America/Chicago. Derived rather than hardcoded because FUTURE_DATE moves and
// Chicago changes offset at the DST boundary — a literal would rot twice a year.
const FUTURE_SLOT_ANCHORED = new Date(
  zonedComponentsToUtcMs(parseNaiveDateTime(FUTURE_SLOT), "America/Chicago")
).toISOString();

// The same instant written two ways, for the idempotency test: a normalized
// UTC anchor versus the offset-bearing form the model re-sends. Both must be
// derived from one date or they stop describing the same moment, which is the
// entire thing that test is checking. -05:00 is written literally rather than
// looked up, so the pair is unambiguous whatever the local zone does.
const FUTURE_SLOT_UTC = `${FUTURE_DATE}T15:00:00.000Z`;
const FUTURE_SLOT_OFFSET = `${FUTURE_DATE}T10:00:00-05:00`;

describe("services/tools.js — executeToolCall (extracted from getReplyStreaming)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("set_call_intent: sets intentArgs state effect and echoes success", async () => {
    const fc = { id: "fc1", name: "set_call_intent", args: { intent: "book_appointment" } };
    const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

    expect(functionResponse).toEqual({
      id: "fc1",
      name: "set_call_intent",
      response: { success: true },
    });
    expect(stateEffects.intentArgs).toEqual({ intent: "book_appointment" });
    expect(stateEffects.toolResult).toEqual({
      name: "set_call_intent",
      success: true,
      message: "How can I help you with that?",
      // Marked speakable: tool messages are no longer read aloud unless their
      // author said they were written for the caller (services/gemini.js).
      callerSafe: true,
    });
    expect(stateEffects.toolCallEvent).toEqual({
      name: "set_call_intent",
      args: { intent: "book_appointment" },
    });
  });

  it("record_customer_request: response shape and recorded capability effect", async () => {
    const args = { request_type: "message", caller_name: "Jane", message: "Call me back" };
    const fc = { id: "fc2", name: "record_customer_request", args };
    const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

    expect(functionResponse.response).toEqual({
      success: true,
      message: "I'll make sure they get your message.",
    });
    // Reports through the generic channel rather than a customerRequestArgs
    // field the engine knows by name. The persist and the owner notification
    // now live in the messages pack's onEffect.
    expect(stateEffects.capabilityEffects).toEqual([
      { capability: "messages", type: "recorded", data: args },
    ]);
    expect(stateEffects.customerRequestArgs).toBeUndefined();
    expect(stateEffects.toolResult.success).toBe(true);
  });

  it("unknown tool name: falls through to the default branch and reports 'Unknown function'", async () => {
    const fc = { id: "fc3", name: "some_unregistered_tool", args: {} };
    const ctx = { ...baseCtx, integrations: [] };
    const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

    expect(functionResponse.response).toEqual({ error: "Unknown function" });
    expect(stateEffects.toolResult).toEqual({
      name: "some_unregistered_tool",
      success: false,
      message: "I'm sorry, I wasn't able to do that.",
      callerSafe: true,
    });
    // Default branch always yields a toolCallEvent, unlike the validation-
    // failure early-returns in cancel/reschedule below.
    expect(stateEffects.toolCallEvent).toEqual({ name: "some_unregistered_tool", args: {} });
  });

  it("book_appointment: success path calls createAppointment and emits a booked effect", async () => {
    mockCreateAppointment.mockResolvedValue("appt-1");
    const args = { scheduled_at: FUTURE_SLOT, client_name: "Jane", service_type: "cleaning" };
    const fc = { id: "fc4", name: "book_appointment", args };

    const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

    // The ANCHORED instant reaches the database, not the model's wall-clock
    // string — scheduled_at is timestamptz, so a naive string would be coerced
    // in the DB's own session zone (UTC) rather than the business's.
    expect(mockCreateAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        callId: "call-1",
        scheduledAt: FUTURE_SLOT_ANCHORED,
      })
    );
    expect(functionResponse.response.success).toBe(true);
    expect(stateEffects.capabilityEffects).toEqual([
      {
        capability: "appointments",
        type: "booked",
        data: { ...args, scheduled_at: FUTURE_SLOT_ANCHORED },
      },
    ]);
  });

  describe("book_appointment: time validation + timezone anchoring (Fix 1)", () => {
    const WEEKLY_MON_FRI = {
      mon: { open: "09:00", close: "17:00", closed: false },
      tue: { open: "09:00", close: "17:00", closed: false },
      wed: { open: "09:00", close: "17:00", closed: false },
      thu: { open: "09:00", close: "17:00", closed: false },
      fri: { open: "09:00", close: "17:00", closed: false },
      sat: { open: null, close: null, closed: true },
      sun: { open: null, close: null, closed: true },
    };

    beforeEach(() => {
      // 2026-07-20T15:00:00Z == Monday 10:00 America/Chicago (CDT, UTC-5).
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-20T15:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("future in-hours booking succeeds and stores an unambiguous UTC value", async () => {
      mockCreateAppointment.mockResolvedValue("appt-1");
      // Tuesday 10:00 America/Chicago -> 15:00 UTC (CDT, UTC-5) -> future.
      const fc = {
        id: "fcA1",
        name: "book_appointment",
        args: { scheduled_at: "2026-07-21T10:00:00", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: WEEKLY_MON_FRI } };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledAt: "2026-07-21T15:00:00.000Z" })
      );
      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.capabilityEffects[0].data.scheduled_at).toBe("2026-07-21T15:00:00.000Z");
    });

    it("winter date: same timezone anchors with the CST (UTC-6) offset, not a hardcoded CDT offset", async () => {
      mockCreateAppointment.mockResolvedValue("appt-1");
      // "now" for this one test is mid-January so the January booking is future.
      vi.setSystemTime(new Date("2027-01-04T15:00:00Z")); // Monday
      // Tuesday 10:00 America/Chicago in January -> CST (UTC-6) -> 16:00 UTC.
      const fc = {
        id: "fcA1b",
        name: "book_appointment",
        args: { scheduled_at: "2027-01-05T10:00:00", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: null } };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledAt: "2027-01-05T16:00:00.000Z" })
      );
      expect(functionResponse.response.success).toBe(true);
    });

    it("past time is rejected with no insert", async () => {
      // 9:00 America/Chicago is earlier the same day as "now" (10:00).
      const fc = {
        id: "fcA2",
        name: "book_appointment",
        args: { scheduled_at: "2026-07-20T09:00:00", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: WEEKLY_MON_FRI } };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "That time has already passed — what day and time works for you?",
      });
      expect(stateEffects.capabilityEffects).toBeUndefined();
    });

    it("unparseable datetime is rejected with no insert", async () => {
      const fc = {
        id: "fcA3",
        name: "book_appointment",
        args: { scheduled_at: "next Tuesday afternoon", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: WEEKLY_MON_FRI } };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "I didn't catch a valid date and time — could you say the day and time again?",
      });
    });

    it("closed Sunday is rejected with no insert", async () => {
      // 2026-07-26 is the Sunday following the fake "now" Monday.
      const fc = {
        id: "fcA4",
        name: "book_appointment",
        args: { scheduled_at: "2026-07-26T10:00:00", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: WEEKLY_MON_FRI } };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "We're closed that day — would another time work?",
      });
    });

    it("3am (outside hours, but an open day) is rejected with no insert", async () => {
      const fc = {
        id: "fcA5",
        name: "book_appointment",
        args: { scheduled_at: "2026-07-21T03:00:00", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: WEEKLY_MON_FRI } };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "We're not open then — our hours that day are 9:00 AM to 5:00 PM. Would another time work?",
      });
    });

    it("legacy businessHours shape ({open_time,close_time}) is honored", async () => {
      mockCreateAppointment.mockResolvedValue("appt-1");
      const ctx = {
        ...baseCtx,
        config: { timezone: "America/Chicago", businessHours: { open_time: "09:00", close_time: "17:00" } },
      };

      const inHours = await executeToolCall(
        { id: "fcA6a", name: "book_appointment", args: { scheduled_at: "2026-07-21T10:00:00", client_name: "Jane" } },
        ctx
      );
      expect(inHours.functionResponse.response.success).toBe(true);

      const outOfHours = await executeToolCall(
        { id: "fcA6b", name: "book_appointment", args: { scheduled_at: "2026-07-21T03:00:00", client_name: "Jane" } },
        ctx
      );
      expect(outOfHours.functionResponse.response.success).toBe(false);
      expect(outOfHours.functionResponse.response.message).toContain("We're not open then");
    });

    it("null businessHours shape means no hours restriction (any future time is accepted)", async () => {
      mockCreateAppointment.mockResolvedValue("appt-1");
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: null } };

      const { functionResponse } = await executeToolCall(
        { id: "fcA7", name: "book_appointment", args: { scheduled_at: "2026-07-21T03:00:00", client_name: "Jane" } },
        ctx
      );
      expect(functionResponse.response.success).toBe(true);
    });

    it("unique-slot 23505 still surfaces the 'no longer available' message for an otherwise-valid time", async () => {
      mockCreateAppointment.mockRejectedValue(Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }));
      const fc = {
        id: "fcA8",
        name: "book_appointment",
        args: { scheduled_at: "2026-07-21T10:00:00", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: WEEKLY_MON_FRI } };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "That time slot is no longer available. Please ask the caller to pick a different time.",
      });
      expect(stateEffects.capabilityEffects).toBeUndefined();
      expect(mockCaptureException).toHaveBeenCalled();
    });

    it("an already offset-anchored scheduled_at (trailing Z) is validated but stored byte-for-byte, not reformatted", async () => {
      mockCreateAppointment.mockResolvedValue("appt-1");
      // Same instant as the naive-Tuesday-10am-Chicago case above, spelled as UTC.
      const fc = {
        id: "fcA9",
        name: "book_appointment",
        args: { scheduled_at: "2026-07-21T15:00:00Z", client_name: "Jane" },
      };
      const ctx = { ...baseCtx, config: { timezone: "America/Chicago", businessHours: WEEKLY_MON_FRI } };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledAt: "2026-07-21T15:00:00Z" })
      );
      expect(functionResponse.response.success).toBe(true);
    });
  });

  it("cancel_appointment_db: missing appointment id short-circuits with no toolCallEvent (bug preserved verbatim)", async () => {
    const fc = { id: "fc5", name: "cancel_appointment_db", args: {} };
    const ctx = { ...baseCtx, capabilityState: {} };

    const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

    expect(functionResponse.response.success).toBe(false);
    expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
    // Preserved from the pre-extraction switch: the validation-failure path
    // never yields a toolCall event.
    expect(stateEffects.toolCallEvent).toBeNull();
  });

  it("get_caller_appointments_from_db: fixed — calls listAppointmentsByCaller with { clientPhone } (phase2 leak fix)", async () => {
    mockListAppointmentsByCaller.mockResolvedValue([{ id: "appt-9" }]);
    const fc = { id: "fc6", name: "get_caller_appointments_from_db", args: {} };

    const { stateEffects } = await executeToolCall(fc, baseCtx);

    // Fixed: the caller's verified phone (ctx.callerPhone) is passed as
    // { clientPhone }, not a bare string — previously the bare-string second
    // arg silently disabled the phone filter inside listAppointmentsByCaller,
    // leaking every business's appointments to any caller.
    expect(mockListAppointmentsByCaller).toHaveBeenCalledWith("biz-1", { clientPhone: "+15551234567" });
    expect(stateEffects.capabilityState.appointments.selectedAppointmentId).toBe("appt-9");
  });

  it("get_caller_appointments_from_db: ignores a model-supplied caller_phone arg — never trusts it over ctx.callerPhone", async () => {
    mockListAppointmentsByCaller.mockResolvedValue([]);
    const fc = {
      id: "fc6b",
      name: "get_caller_appointments_from_db",
      args: { caller_phone: "+19995550000" }, // someone else's number, model-supplied
    };

    await executeToolCall(fc, baseCtx);

    expect(mockListAppointmentsByCaller).toHaveBeenCalledWith("biz-1", { clientPhone: "+15551234567" });
  });

  it("get_caller_appointments_from_db: message lists times in LOCAL time, not raw UTC (spoken-time fix)", async () => {
    // 19:00Z is 2:00 PM America/Chicago — the model reads the message aloud, so
    // it must not surface the raw UTC instant (which would be spoken as 7 PM).
    mockListAppointmentsByCaller.mockResolvedValue([
      { id: "appt-9", client_name: "Priya Nair", scheduled_at: "2026-07-29T19:00:00.000Z" },
    ]);
    const fc = { id: "fc6c", name: "get_caller_appointments_from_db", args: {} };

    const { functionResponse } = await executeToolCall(fc, {
      ...baseCtx,
      config: { timezone: "America/Chicago" },
    });
    const { message, appointments } = functionResponse.response;

    // Machine-readable rows are now the BUSINESS-LOCAL wall clock, not the raw
    // UTC instant they used to be.
    //
    // Raw UTC here was justified as "machine-readable", but the machine reading
    // it is a language model that also passes these values back into booking
    // arguments — where the declarations ask for a naive LOCAL time. One field,
    // two possible frames, no way to tell them apart downstream. Emitting local
    // makes the round-trip single-valued, and it removes the second-worst
    // failure mode: the model reading a UTC ISO aloud as if it were local.
    expect(appointments[0].scheduled_at).toBe("2026-07-29T14:00:00");
    // No timezone suffix — an offset here would put us straight back into the
    // ambiguity this change exists to remove.
    expect(appointments[0].scheduled_at).not.toMatch(/(Z|[+-]\d{2}:\d{2})$/);

    // Another caller's stored phone number is never handed to the model.
    // Identity is proven server-side from call metadata, so the digits have no
    // purpose in the prompt.
    expect(appointments[0].client_phone).toBeUndefined();

    // The spoken listing is localized: local time present, no raw ISO / UTC hour.
    expect(message).toMatch(/2:00\s?PM/);
    expect(message).toMatch(/July 29/);
    expect(message).not.toMatch(/T\d{2}:\d{2}/);
    expect(message).not.toMatch(/7:00\s?PM/);
  });

  describe("end_call step-gating", () => {
    it("honors end_call during the confirm step", async () => {
      const fc = { id: "fc7", name: "end_call", args: { reason: "done" } };
      const ctx = { ...baseCtx, step: "confirm" };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response).toEqual({ success: true });
      expect(stateEffects.endCallArgs).toEqual({ reason: "done" });
      expect(stateEffects.toolResult).toEqual({
        name: "end_call",
        success: true,
        message: "Goodbye!",
        callerSafe: true,
      });
    });

    it("honors end_call during the ending step", async () => {
      const fc = { id: "fc7b", name: "end_call", args: { reason: "done" } };
      const ctx = { ...baseCtx, step: "ending" };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(true);
    });

    it("rejects end_call during gather_details with the legacy 'don't end yet' message", async () => {
      const fc = { id: "fc8", name: "end_call", args: { reason: "caller wants to hang up" } };
      const ctx = { ...baseCtx, step: "gather_details" };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response).toEqual({
        success: false,
        message:
          "Don't end the call yet. First confirm you've helped with their request and ask if there's anything else they need.",
      });
      expect(stateEffects.endCallArgs).toBeUndefined();
      expect(stateEffects.toolResult).toEqual({
        name: "end_call",
        success: false,
        // Note the split: the model is told "don't end the call yet"; only
        // this caller-facing line is ever eligible to be spoken.
        message: "Is there anything else I can help you with?",
        callerSafe: true,
      });
    });

    // -----------------------------------------------------------------------
    // THE ~90% BUG: the gate was unreachable for most calls.
    //
    // end_call was allowed only in step "confirm"/"ending", or when an action
    // tool completed in the SAME turn. But step reaches "confirm" from just
    // three places — the appointments and quotes packs. Taking a message never
    // got there, and an informational call never got there at all.
    //
    // So the model said its goodbye (already streamed to TTS and spoken to the
    // caller), called end_call, and was refused. Nothing armed a close. The
    // line stayed open until the silence ladder fired 20-28 seconds later, and
    // the model — told to "ask if there's anything else" — tried again and was
    // refused again for the same structural reason.
    // -----------------------------------------------------------------------
    it("honors end_call when an action completed EARLIER in the call, not just this turn", async () => {
      // The caller booked, chatted for another turn, then said goodbye. The
      // turn-scoped flag is false by then; the call-scoped one is what makes
      // wrapping up possible at all.
      const fc = { id: "fc7c", name: "end_call", args: { reason: "done" } };
      const ctx = { ...baseCtx, step: "gather_details", completedActionThisCall: true };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.endCallArgs).toEqual({ reason: "done" });
    });

    it("honors end_call on an informational call once the caller has had a real conversation", async () => {
      // No tool ever runs on "what are your hours?" — so no step transition and
      // no action flag ever existed, and this call could never be ended by the
      // assistant no matter how clearly the caller said goodbye.
      const fc = { id: "fc7d", name: "end_call", args: { reason: "caller is done" } };
      const ctx = { ...baseCtx, step: "identify_intent", callerTurnCount: 3 };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(true);
    });

    it("still refuses end_call at the very start of a call", async () => {
      // The gate exists to stop the assistant hanging up before it has helped.
      // Widening it must not cost that: one caller turn in, with nothing done
      // and nothing confirmed, is still too early.
      const fc = { id: "fc7e", name: "end_call", args: { reason: "premature" } };
      const ctx = { ...baseCtx, step: "identify_intent", callerTurnCount: 1 };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(false);
      expect(stateEffects.endCallArgs).toBeUndefined();
    });
  });

  describe("caller-identity guard on cancel/reschedule", () => {
    it("cancel_appointment_db: allows when the appointment's client_phone matches ctx.callerPhone", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+1 (555) 123-4567", // formatting differs, digits match
        client_name: "Someone Else",
      });
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const fc = { id: "fc9", name: "cancel_appointment_db", args: { appointment_id: "appt-1" } };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockGetAppointmentById).toHaveBeenCalledWith("appt-1", "biz-1");
      expect(mockUpdateAppointmentStatus).toHaveBeenCalledWith("appt-1", "cancelled", "biz-1");
      expect(functionResponse.response).toEqual({ success: true, message: "That appointment has been cancelled." });
    });

    it("cancel_appointment_db: allows on a name match ONLY when the caller also supplies the correct last 4 digits", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+19995550000", // does not match ctx.callerPhone
        client_name: "Jane Doe",
      });
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const fc = {
        id: "fc9b",
        name: "cancel_appointment_db",
        args: { appointment_id: "appt-1", client_name: "jane doe", phone_last4: "0000" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointmentStatus).toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(true);
    });

    it("cancel_appointment_db: DENIES a name match with no last-4 second factor (knowing a name must not be enough)", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+19995550000",
        client_name: "Jane Doe",
      });
      const fc = {
        id: "fc9b1",
        name: "cancel_appointment_db",
        args: { appointment_id: "appt-1", client_name: "jane doe" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "I can only make changes to appointments booked under your number. Let me take a message instead.",
      });
    });

    it("cancel_appointment_db: DENIES a name match with the WRONG last-4", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+19995550000",
        client_name: "Jane Doe",
      });
      const fc = {
        id: "fc9b2",
        name: "cancel_appointment_db",
        args: { appointment_id: "appt-1", client_name: "jane doe", phone_last4: "1234" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(false);
    });

    it("cancel_appointment_db: accepts a spoken last-4 with punctuation/spacing ('0-0-0-0')", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+19995550000",
        client_name: "Jane Doe",
      });
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const fc = {
        id: "fc9b3",
        name: "cancel_appointment_db",
        args: { appointment_id: "appt-1", client_name: "jane doe", phone_last4: "0-0-0-0" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(functionResponse.response.success).toBe(true);
    });

    it("cancel_appointment_db: a last-4 alone (no name match) is NOT enough", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+19995550000",
        client_name: "Jane Doe",
      });
      const fc = {
        id: "fc9b4",
        name: "cancel_appointment_db",
        args: { appointment_id: "appt-1", client_name: "Somebody Else", phone_last4: "0000" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(false);
    });

    it("reschedule_appointment_db: same second-factor rule — name alone is denied, name + last-4 is allowed", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-2",
        client_phone: "+19995551111",
        client_name: "Jane Doe",
      });
      mockUpdateAppointment.mockResolvedValue(true);

      const denied = await executeToolCall(
        {
          id: "fc10c",
          name: "reschedule_appointment_db",
          args: { appointment_id: "appt-2", new_scheduled_at: FUTURE_SLOT, client_name: "Jane Doe" },
        },
        baseCtx
      );
      expect(mockUpdateAppointment).not.toHaveBeenCalled();
      expect(denied.functionResponse.response.success).toBe(false);

      const allowed = await executeToolCall(
        {
          id: "fc10d",
          name: "reschedule_appointment_db",
          args: {
            appointment_id: "appt-2",
            new_scheduled_at: FUTURE_SLOT,
            client_name: "Jane Doe",
            phone_last4: "1111",
          },
        },
        baseCtx
      );
      expect(mockUpdateAppointment).toHaveBeenCalled();
      expect(allowed.functionResponse.response.success).toBe(true);
    });

    it("cancel_appointment_db: denies when neither phone nor name match — never calls updateAppointmentStatus", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+19995550000",
        client_name: "Someone Else",
      });
      const fc = { id: "fc9c", name: "cancel_appointment_db", args: { appointment_id: "appt-1" } };

      const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "I can only make changes to appointments booked under your number. Let me take a message instead.",
      });
      expect(stateEffects.toolResult.success).toBe(false);
    });

    it("cancel_appointment_db: denies when the appointment can't be found (fails closed)", async () => {
      mockGetAppointmentById.mockResolvedValue(null);
      const fc = { id: "fc9d", name: "cancel_appointment_db", args: { appointment_id: "does-not-exist" } };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(false);
    });

    it("reschedule_appointment_db: allows when identity matches", async () => {
      mockGetAppointmentById.mockResolvedValue({ id: "appt-2", client_phone: "+15551234567", client_name: null });
      mockUpdateAppointment.mockResolvedValue(true);
      const fc = {
        id: "fc10",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-2", new_scheduled_at: FUTURE_SLOT },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointment).toHaveBeenCalledWith("appt-2", { scheduled_at: FUTURE_SLOT_ANCHORED }, "biz-1");
      expect(functionResponse.response).toEqual({ success: true, message: "Rescheduled." });
    });

    it("reschedule_appointment_db: denies on identity mismatch — never calls updateAppointment", async () => {
      mockGetAppointmentById.mockResolvedValue({ id: "appt-2", client_phone: "+19995550000", client_name: "Nobody" });
      const fc = {
        id: "fc10b",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-2", new_scheduled_at: FUTURE_SLOT },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response).toEqual({
        success: false,
        message: "I can only make changes to appointments booked under your number. Let me take a message instead.",
      });
    });
  });

  // -------------------------------------------------------------------------
  // reschedule_appointment_db: timezone anchoring.
  //
  // THE REPORTED BUG. A caller on a UK number booked 1:00pm, then rescheduled
  // to 1:05pm on a later call. The AI afterwards read it back as "2:05pm".
  //
  // book_appointment routes its scheduled_at through validateBookingTime, which
  // anchors a naive wall-clock string to the business timezone. reschedule did
  // not: it passed the model's raw string to supabase.updateAppointment, and
  // scheduled_at is timestamptz, so PostgREST coerced the naive string using
  // the DB session zone (UTC on Supabase). A UK wall clock of 13:05 was
  // therefore stored as 13:05Z, which IS 14:05 in Europe/London during BST.
  // The read-back was faithful; the write was wrong.
  //
  // Wrong from late March to late October and self-correcting in winter, which
  // is exactly why it needs a test on both sides of the DST boundary rather
  // than a single spot check.
  //
  // The old tests could not catch this: every one of them passed an
  // already-offset-bearing value ("2026-08-02T10:00:00Z"), which skips the
  // naive branch entirely.
  // -------------------------------------------------------------------------
  describe("reschedule_appointment_db: timezone anchoring across DST", () => {
    const MON_FRI_9_5 = {
      mon: { open: "09:00", close: "17:00", closed: false },
      tue: { open: "09:00", close: "17:00", closed: false },
      wed: { open: "09:00", close: "17:00", closed: false },
      thu: { open: "09:00", close: "17:00", closed: false },
      fri: { open: "09:00", close: "17:00", closed: false },
      sat: { open: null, close: null, closed: true },
      sun: { open: null, close: null, closed: true },
    };
    const ukCtx = {
      ...baseCtx,
      config: { timezone: "Europe/London", businessHours: MON_FRI_9_5 },
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-01T09:00:00Z"));
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-uk",
        client_phone: "+15551234567",
        client_name: null,
      });
      mockUpdateAppointment.mockResolvedValue(true);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Extract the scheduled_at actually handed to the DB. */
    function storedScheduledAt() {
      expect(mockUpdateAppointment).toHaveBeenCalled();
      return mockUpdateAppointment.mock.calls[0][1].scheduled_at;
    }

    it("BST: a naive 1:05pm UK wall clock is stored as 12:05Z, not 13:05Z", async () => {
      // Monday 2026-08-10, British Summer Time (UTC+1).
      const fc = {
        id: "fcTz1",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-uk", new_scheduled_at: "2026-08-10T13:05:00" },
      };

      const { functionResponse } = await executeToolCall(fc, ukCtx);

      expect(functionResponse.response.success).toBe(true);
      // The whole bug in one assertion. 13:05Z would read back as "2:05 PM".
      expect(new Date(storedScheduledAt()).toISOString()).toBe("2026-08-10T12:05:00.000Z");
    });

    it("GMT: the same wall clock in winter is stored as 13:05Z — the offset is not hardcoded", async () => {
      // Monday 2027-01-11, Greenwich Mean Time (UTC+0). Same wall clock, a
      // different instant. A fix that subtracted a fixed hour would break here.
      const fc = {
        id: "fcTz2",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-uk", new_scheduled_at: "2027-01-11T13:05:00" },
      };

      const { functionResponse } = await executeToolCall(fc, ukCtx);

      expect(functionResponse.response.success).toBe(true);
      expect(new Date(storedScheduledAt()).toISOString()).toBe("2027-01-11T13:05:00.000Z");
    });

    it("an offset-bearing value is trusted as an instant, and a disagreement with the business zone is LOGGED not silently rewritten", async () => {
      // The second way a wrong hour could reach the DB: the model writes a UK
      // wall clock and appends "Z". We do NOT re-anchor it.
      //
      // Re-anchoring would fix that case and break its mirror image — a model
      // that correctly converted 10:00 America/Chicago to 15:00Z would have its
      // booking shoved five hours. The two are indistinguishable from the value
      // alone, so the ambiguity is measured rather than guessed at. This test
      // pins that decision so nobody "fixes" it later without reading why.
      const warn = vi.fn();
      const fc = {
        id: "fcTz3",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-uk", new_scheduled_at: "2026-08-10T13:05:00Z" },
      };

      const { functionResponse } = await executeToolCall(fc, {
        ...ukCtx,
        depsOverride: { ...capabilityDepsFake, log: { error: warn } },
      });

      expect(functionResponse.response.success).toBe(true);
      // Stored as the instant it literally denotes — verbatim, not rewritten.
      expect(new Date(storedScheduledAt()).toISOString()).toBe("2026-08-10T13:05:00.000Z");
      // ...but it did not pass unnoticed.
      expect(warn).toHaveBeenCalledWith(
        "booking_offset_disagrees_with_business_zone",
        expect.objectContaining({
          timezone: "Europe/London",
          wouldShiftByMinutes: -60,
          severity: "warn",
        })
      );
    });

    it("an offset that AGREES with the business zone is preserved and raises no warning", async () => {
      // +01:00 is correct for London in August, so nothing is ambiguous here
      // and the detector must stay quiet — otherwise it cries wolf on every
      // correctly-formed value and the log signal is worthless.
      const warn = vi.fn();
      const fc = {
        id: "fcTz4",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-uk", new_scheduled_at: "2026-08-10T13:05:00+01:00" },
      };

      const { functionResponse } = await executeToolCall(fc, {
        ...ukCtx,
        depsOverride: { ...capabilityDepsFake, log: { error: warn } },
      });

      expect(functionResponse.response.success).toBe(true);
      expect(new Date(storedScheduledAt()).toISOString()).toBe("2026-08-10T12:05:00.000Z");
      expect(warn).not.toHaveBeenCalled();
    });

    it("refuses a reschedule into the past and never touches the DB", async () => {
      // Bypassing validateBookingTime also bypassed its past-date guard, so the
      // AI could move an appointment backwards in time.
      const fc = {
        id: "fcTz5",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-uk", new_scheduled_at: "2026-07-01T13:05:00" },
      };

      const { functionResponse } = await executeToolCall(fc, ukCtx);

      expect(functionResponse.response.success).toBe(false);
      expect(mockUpdateAppointment).not.toHaveBeenCalled();
    });

    it("refuses a reschedule outside business hours and never touches the DB", async () => {
      // 3am on a Monday. Same bypass, same class of defect.
      const fc = {
        id: "fcTz6",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-uk", new_scheduled_at: "2026-08-10T03:00:00" },
      };

      const { functionResponse } = await executeToolCall(fc, ukCtx);

      expect(functionResponse.response.success).toBe(false);
      expect(mockUpdateAppointment).not.toHaveBeenCalled();
    });

    it("refuses a reschedule onto a closed day and never touches the DB", async () => {
      // Sunday 2026-08-16.
      const fc = {
        id: "fcTz7",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-uk", new_scheduled_at: "2026-08-16T13:05:00" },
      };

      const { functionResponse } = await executeToolCall(fc, ukCtx);

      expect(functionResponse.response.success).toBe(false);
      expect(mockUpdateAppointment).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Tenant scoping. lib/voice/session.js logs "no_business_found" and carries
  // on with state.businessId unset, so ctx.businessId can legitimately be
  // null mid-call. Every appointment tool must refuse to run at all in that
  // state — previously they passed `null` straight through to supabase.js,
  // whose `if (businessId)` guards then issued the query UNSCOPED, across
  // every tenant in the table.
  // -------------------------------------------------------------------------
  describe("appointment tools refuse to run without a business context", () => {
    const NO_BUSINESS_MESSAGE =
      "I'm not able to look that up right now. Let me take a message and someone will follow up.";
    const noBizCtx = { ...baseCtx, businessId: null };

    it("cancel_appointment_db: denies and never touches the DB", async () => {
      const fc = { id: "fcNB1", name: "cancel_appointment_db", args: { appointment_id: "appt-1" } };

      const { functionResponse, stateEffects } = await executeToolCall(fc, noBizCtx);

      expect(functionResponse.response).toEqual({ success: false, message: NO_BUSINESS_MESSAGE });
      expect(stateEffects.toolResult.success).toBe(false);
      expect(mockGetAppointmentById).not.toHaveBeenCalled();
      expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
    });

    it("reschedule_appointment_db: denies and never touches the DB", async () => {
      const fc = {
        id: "fcNB2",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-1", new_scheduled_at: FUTURE_SLOT },
      };

      const { functionResponse } = await executeToolCall(fc, noBizCtx);

      expect(functionResponse.response).toEqual({ success: false, message: NO_BUSINESS_MESSAGE });
      expect(mockGetAppointmentById).not.toHaveBeenCalled();
      expect(mockUpdateAppointment).not.toHaveBeenCalled();
    });

    it("get_caller_appointments_from_db: denies instead of silently returning an empty list", async () => {
      const fc = { id: "fcNB3", name: "get_caller_appointments_from_db", args: {} };

      const { functionResponse } = await executeToolCall(fc, noBizCtx);

      expect(functionResponse.response).toEqual({ success: false, message: NO_BUSINESS_MESSAGE });
      expect(mockListAppointmentsByCaller).not.toHaveBeenCalled();
    });

    it("book_appointment: denies instead of reporting a generic booking failure", async () => {
      const fc = {
        id: "fcNB4",
        name: "book_appointment",
        args: { scheduled_at: FUTURE_SLOT, client_name: "Jane" },
      };

      const { functionResponse, stateEffects } = await executeToolCall(fc, noBizCtx);

      expect(functionResponse.response).toEqual({ success: false, message: NO_BUSINESS_MESSAGE });
      expect(stateEffects.capabilityEffects).toBeUndefined();
      expect(mockCreateAppointment).not.toHaveBeenCalled();
    });
  });

  describe("request_transfer", () => {
    it("allowed: sets transferRequested state effect and reports success", async () => {
      const fc = { id: "fc11", name: "request_transfer", args: { reason: "caller asked for a person" } };
      const ctx = { ...baseCtx, transferAllowed: true };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.transferRequested).toEqual({ reason: "caller asked for a person" });
      expect(stateEffects.toolResult.success).toBe(true);
    });

    it("denied: ctx.transferAllowed=false yields failure and no transferRequested effect", async () => {
      const fc = { id: "fc11b", name: "request_transfer", args: { reason: "caller asked for a person" } };
      const ctx = { ...baseCtx, transferAllowed: false };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response).toEqual({
        success: false,
        message: "Transfer is not available right now. Offer to take a message instead.",
      });
      expect(stateEffects.transferRequested).toBeUndefined();
    });
  });

  describe("book_appointment: duplicate handling (Phase 2)", () => {
    it("a 23505 unique violation reports 'slot no longer available', not a generic error", async () => {
      const err = new Error("duplicate key value violates unique constraint");
      err.code = "23505";
      mockCreateAppointment.mockRejectedValue(err);
      const fc = {
        id: "fcD1",
        name: "book_appointment",
        args: { scheduled_at: FUTURE_SLOT, client_name: "Jane" },
      };

      const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

      expect(functionResponse.response.success).toBe(false);
      expect(functionResponse.response.message).toMatch(/no longer available/i);
      expect(stateEffects.capabilityEffects).toBeUndefined();
    });

    it("a generic DB error reports the follow-up message", async () => {
      mockCreateAppointment.mockRejectedValue(new Error("connection reset"));
      const fc = {
        id: "fcD2",
        name: "book_appointment",
        args: { scheduled_at: FUTURE_SLOT, client_name: "Jane" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(functionResponse.response.success).toBe(false);
      expect(functionResponse.response.message).toMatch(/error booking/i);
    });

    it("idempotency compares instants, not strings (naive-normalized vs offset-verbatim forms)", async () => {
      // Anchor stored as normalized UTC; the model re-sends the same moment
      // as an offset-bearing string (stored verbatim by validateBookingTime).
      const ctx = {
        ...baseCtx,
        capabilityState: {
          appointments: {
            lastBooked: { scheduled_at: FUTURE_SLOT_UTC, client_name: "Jane" },
          },
        },
      };
      const fc = {
        id: "fcD4",
        name: "book_appointment",
        args: { scheduled_at: FUTURE_SLOT_OFFSET, client_name: "Jane" },
      };

      const { functionResponse } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(true);
      expect(functionResponse.response.message).toMatch(/already booked/i);
    });

    it("re-booking the slot already booked this call short-circuits to success without inserting", async () => {
      const ctx = {
        ...baseCtx,
        capabilityState: {
          appointments: {
            // The ANCHORED instant, because that is what a real booking stores
            // — the effect carries validateBookingTime's output, not the
            // model's raw wall-clock string. Seeding the naive form here would
            // make the fixture describe a state the code cannot produce, and
            // the comparison would be naive-vs-anchored rather than the
            // instant-vs-instant check this test is about.
            lastBooked: { scheduled_at: FUTURE_SLOT_ANCHORED, client_name: "Jane" },
          },
        },
      };
      const fc = {
        id: "fcD3",
        name: "book_appointment",
        args: { scheduled_at: FUTURE_SLOT, client_name: "Jane" },
      };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(true);
      expect(functionResponse.response.message).toMatch(/already booked/i);
      // No booked effect: the original booking already fired the step
      // transition + notifications; the short-circuit must not re-fire them.
      expect(stateEffects.capabilityEffects).toBeUndefined();
    });
  });

  describe("ctx.depsOverride — capability deps injectability seam", () => {
    it("when present, pack.execute receives ctx.depsOverride as deps instead of the real CAPABILITY_DEPS", async () => {
      const fakeListAppointmentsByCaller = vi.fn().mockResolvedValue([{ id: "fake-appt" }]);
      const fc = { id: "fcDep1", name: "get_caller_appointments_from_db", args: {} };
      const ctx = {
        ...baseCtx,
        depsOverride: { listAppointmentsByCaller: fakeListAppointmentsByCaller },
      };

      const { stateEffects } = await executeToolCall(fc, ctx);

      expect(fakeListAppointmentsByCaller).toHaveBeenCalledWith("biz-1", { clientPhone: "+15551234567" });
      expect(mockListAppointmentsByCaller).not.toHaveBeenCalled();
      expect(stateEffects.capabilityState.appointments.selectedAppointmentId).toBe("fake-appt");
    });

    it("when absent, pack.execute receives the real CAPABILITY_DEPS", async () => {
      mockListAppointmentsByCaller.mockResolvedValue([{ id: "appt-9" }]);
      const fc = { id: "fcDep2", name: "get_caller_appointments_from_db", args: {} };

      await executeToolCall(fc, baseCtx);

      expect(mockListAppointmentsByCaller).toHaveBeenCalledWith("biz-1", { clientPhone: "+15551234567" });
    });
  });

  describe("identity persistence + end_call gating (Phase 2)", () => {
    it("cancel: a previously verified appointment skips the DB identity lookup", async () => {
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const ctx = {
        ...baseCtx,
        capabilityState: {
          appointments: { selectedAppointmentId: "appt-9", identityVerifiedApptId: "appt-9" },
        },
      };
      const fc = { id: "fcI1", name: "cancel_appointment_db", args: {} };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(mockGetAppointmentById).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.capabilityState.appointments.identityVerifiedApptId).toBe("appt-9");
      expect(stateEffects.toolResult.appointmentId).toBe("appt-9");
    });

    it("cancel: success records identityVerifiedApptId even when verified via caller-ID match", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-7",
        client_phone: "+15551234567",
        client_name: "Jane",
      });
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const ctx = { ...baseCtx, capabilityState: { appointments: { selectedAppointmentId: "appt-7" } } };
      const fc = { id: "fcI2", name: "cancel_appointment_db", args: {} };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.capabilityState.appointments.identityVerifiedApptId).toBe("appt-7");
    });

    it("end_call: allowed outside confirm/ending when an action already completed this turn", async () => {
      const ctx = { ...baseCtx, step: "gather_details", completedActionThisTurn: true };
      const fc = { id: "fcI3", name: "end_call", args: { reason: "done" } };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.endCallArgs).toEqual({ reason: "done" });
    });

    it("end_call: still refused in gather_details with no completed action", async () => {
      const ctx = { ...baseCtx, step: "gather_details", completedActionThisTurn: false };
      const fc = { id: "fcI4", name: "end_call", args: { reason: "done" } };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(false);
      expect(stateEffects.endCallArgs).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// The caller already has an upcoming appointment.
//
// The live symptom: a caller with a booked appointment rings back, asks about
// something else, is offered a "strategy call", says yes, and gets a SECOND
// row. Nothing in the handler ever looked the caller up — the only dedupe was
// the same-instant anchor, which is per-call and in-memory, so a callback
// defeated it completely.
// ---------------------------------------------------------------------------
describe("services/tools.js — book_appointment guards against a second appointment", () => {
  const soon = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
  const past = () => new Date(Date.now() - 3 * 86_400_000).toISOString();

  function ctxWith({ upcoming = null, policy = undefined, capabilityState = {} } = {}) {
    return {
      ...baseCtx,
      capabilityState,
      config: policy ? { capabilities: { appointments: { existingAppointment: policy } } } : {},
      ...(upcoming === null ? {} : { callerContext: { callCount: 1, lastCallSummary: null, upcomingAppointments: upcoming } }),
    };
  }

  const bookFc = (args = {}) => ({ id: "fcG", name: "book_appointment", args: { scheduled_at: FUTURE_SLOT, client_name: "Jane", ...args } });

  beforeEach(() => {
    // Several of these assert createAppointment was NOT called, which only
    // means anything against a counter reset per test.
    vi.clearAllMocks();
    mockCreateAppointment.mockResolvedValue("appt-guard");
  });

  it("books when there is no caller context at all — the guard fails OPEN", async () => {
    // Prefetch failed, database disabled, or a withheld number. Blocking on
    // missing data would refuse a legitimate booking, which is worse than the
    // duplicate it would prevent.
    const { functionResponse } = await executeToolCall(bookFc(), ctxWith({ upcoming: null }));
    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalled();
  });

  it("books when the caller has no upcoming appointments", async () => {
    const { functionResponse } = await executeToolCall(bookFc(), ctxWith({ upcoming: [] }));
    expect(functionResponse.response.success).toBe(true);
  });

  it("books when the caller's only appointment is in the past", async () => {
    // The snapshot is taken at call start and re-filtered against now, because
    // an appointment can pass during a long call.
    const { functionResponse } = await executeToolCall(
      bookFc(),
      ctxWith({ upcoming: [{ scheduled_at: past(), client_name: "Jane" }] })
    );
    expect(functionResponse.response.success).toBe(true);
  });

  it("confirm (the default, config untouched): refuses and never touches the database", async () => {
    const { functionResponse, stateEffects } = await executeToolCall(
      bookFc(),
      ctxWith({ upcoming: [{ scheduled_at: soon(), client_name: "Jane" }] })
    );

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/in_addition_to_existing/);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    // A caller-safe line is mandatory: without one a text-free turn falls
    // through to the generic can'"'"'t-complete apology, which would be a lie.
    expect(stateEffects.toolResult.callerSafe).toBe(true);
    expect(stateEffects.toolResult.message).toMatch(/already have an appointment/i);
  });

  it("confirm: books once the caller has confirmed they want a second one", async () => {
    const { functionResponse, stateEffects } = await executeToolCall(
      bookFc({ in_addition_to_existing: true }),
      ctxWith({ upcoming: [{ scheduled_at: soon(), client_name: "Jane" }] })
    );

    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalled();
    expect(stateEffects.capabilityEffects).toEqual([
      expect.objectContaining({ capability: "appointments", type: "booked" }),
    ]);
  });

  it("allow: books despite an existing appointment, and tells the model about it", async () => {
    const { functionResponse } = await executeToolCall(
      bookFc(),
      ctxWith({ upcoming: [{ scheduled_at: soon(), client_name: "Jane" }], policy: "allow" })
    );

    expect(functionResponse.response.success).toBe(true);
    expect(functionResponse.response.message).toMatch(/also has an existing upcoming appointment/i);
  });

  it("block: refuses, and the confirm flag is NOT a bypass", async () => {
    // The flag is never advertised under this policy, so honouring it would
    // turn an opt-in parameter into a way around the business'"'"'s own rule.
    const { functionResponse } = await executeToolCall(
      bookFc({ in_addition_to_existing: true }),
      ctxWith({ upcoming: [{ scheduled_at: soon(), client_name: "Jane" }], policy: "block" })
    );

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/does not\s+book a second one/i);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("block: still books for a caller who has none", async () => {
    const { functionResponse } = await executeToolCall(
      bookFc(),
      ctxWith({ upcoming: [], policy: "block" })
    );
    expect(functionResponse.response.success).toBe(true);
  });

  it("the same-call anchor wins over the guard, so a re-issued call is not refused", async () => {
    // The model re-issuing book_appointment for the slot it just booked must
    // hit the idempotency short-circuit. If the guard ran first it would refuse
    // the caller their own appointment.
    const anchored = new Date(
      zonedComponentsToUtcMs(parseNaiveDateTime(FUTURE_SLOT), "America/Chicago")
    ).toISOString();
    const { functionResponse, stateEffects } = await executeToolCall(
      bookFc(),
      ctxWith({
        upcoming: [{ scheduled_at: soon(), client_name: "Jane" }],
        capabilityState: { appointments: { lastBooked: { scheduled_at: anchored } } },
      })
    );

    expect(functionResponse.response.success).toBe(true);
    expect(functionResponse.response.message).toMatch(/already booked from earlier in this call/i);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    expect(stateEffects.capabilityEffects).toBeUndefined();
  });

  it("time validation wins over the guard, so a bad time gets its own error", async () => {
    const { functionResponse } = await executeToolCall(
      { id: "fcP", name: "book_appointment", args: { scheduled_at: "2020-01-01T10:00:00" } },
      ctxWith({ upcoming: [{ scheduled_at: soon(), client_name: "Jane" }] })
    );

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).not.toMatch(/in_addition_to_existing/);
  });

  it("leaks no identifier the model must never see", async () => {
    const { functionResponse, stateEffects } = await executeToolCall(
      bookFc(),
      ctxWith({
        upcoming: [
          { id: "8a13a7c6-dead-4beef-9999-000000000000", client_name: "Jane", client_phone: "+15551234567", scheduled_at: soon() },
        ],
      })
    );

    const seen = `${functionResponse.response.message} ${stateEffects.toolResult.message}`;
    expect(seen).not.toMatch(/8a13a7c6/);
    expect(seen).not.toMatch(/\+1555/);
    expect(seen).not.toMatch(/Jane/);
  });

  it("ignores a model-supplied phone number entirely", async () => {
    // The snapshot is keyed on call metadata. A caller cannot reach someone
    // else'"'"'s record, or dodge their own, by naming a different number.
    const { functionResponse } = await executeToolCall(
      bookFc({ caller_phone: "+19998887777" }),
      ctxWith({ upcoming: [{ scheduled_at: soon(), client_name: "Jane" }] })
    );
    expect(functionResponse.response.success).toBe(false);
  });
});
