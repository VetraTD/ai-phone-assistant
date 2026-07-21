import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();
const mockListAppointmentsByCaller = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
const mockUpdateAppointment = vi.fn();
const mockGetAppointmentById = vi.fn();
const mockExecuteIntegration = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("../services/supabase.js", () => ({
  createAppointment: (...args) => mockCreateAppointment(...args),
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

const baseCtx = {
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  selectedAppointmentId: null,
  config: {},
};

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
    });
    expect(stateEffects.toolCallEvent).toEqual({
      name: "set_call_intent",
      args: { intent: "book_appointment" },
    });
  });

  it("record_customer_request: response shape and customerRequestArgs state effect", async () => {
    const args = { request_type: "message", caller_name: "Jane", message: "Call me back" };
    const fc = { id: "fc2", name: "record_customer_request", args };
    const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

    expect(functionResponse.response).toEqual({
      success: true,
      message: "I'll make sure they get your message.",
    });
    expect(stateEffects.customerRequestArgs).toEqual(args);
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
    });
    // Default branch always yields a toolCallEvent, unlike the validation-
    // failure early-returns in cancel/reschedule below.
    expect(stateEffects.toolCallEvent).toEqual({ name: "some_unregistered_tool", args: {} });
  });

  it("book_appointment: success path calls createAppointment and sets appointmentArgs", async () => {
    mockCreateAppointment.mockResolvedValue("appt-1");
    const args = { scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane", service_type: "cleaning" };
    const fc = { id: "fc4", name: "book_appointment", args };

    const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

    expect(mockCreateAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", callId: "call-1", scheduledAt: args.scheduled_at })
    );
    expect(functionResponse.response.success).toBe(true);
    expect(stateEffects.appointmentArgs).toEqual(args);
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
      expect(stateEffects.appointmentArgs.scheduled_at).toBe("2026-07-21T15:00:00.000Z");
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
      expect(stateEffects.appointmentArgs).toBeNull();
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
      expect(stateEffects.appointmentArgs).toBeNull();
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
    const ctx = { ...baseCtx, selectedAppointmentId: null };

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
    expect(stateEffects.selectedAppointmentId).toBe("appt-9");
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

  describe("end_call step-gating", () => {
    it("honors end_call during the confirm step", async () => {
      const fc = { id: "fc7", name: "end_call", args: { reason: "done" } };
      const ctx = { ...baseCtx, step: "confirm" };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response).toEqual({ success: true });
      expect(stateEffects.endCallArgs).toEqual({ reason: "done" });
      expect(stateEffects.toolResult).toEqual({ name: "end_call", success: true, message: "Goodbye!" });
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
        message: "Is there anything else I can help you with?",
      });
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
          args: { appointment_id: "appt-2", new_scheduled_at: "2026-08-02T10:00:00Z", client_name: "Jane Doe" },
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
            new_scheduled_at: "2026-08-02T10:00:00Z",
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
        args: { appointment_id: "appt-2", new_scheduled_at: "2026-08-02T10:00:00Z" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointment).toHaveBeenCalledWith("appt-2", { scheduled_at: "2026-08-02T10:00:00Z" }, "biz-1");
      expect(functionResponse.response).toEqual({ success: true, message: "Rescheduled." });
    });

    it("reschedule_appointment_db: denies on identity mismatch — never calls updateAppointment", async () => {
      mockGetAppointmentById.mockResolvedValue({ id: "appt-2", client_phone: "+19995550000", client_name: "Nobody" });
      const fc = {
        id: "fc10b",
        name: "reschedule_appointment_db",
        args: { appointment_id: "appt-2", new_scheduled_at: "2026-08-02T10:00:00Z" },
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
        args: { appointment_id: "appt-1", new_scheduled_at: "2026-08-02T10:00:00Z" },
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
        args: { scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane" },
      };

      const { functionResponse, stateEffects } = await executeToolCall(fc, noBizCtx);

      expect(functionResponse.response).toEqual({ success: false, message: NO_BUSINESS_MESSAGE });
      expect(stateEffects.appointmentArgs).toBeNull();
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
        args: { scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane" },
      };

      const { functionResponse, stateEffects } = await executeToolCall(fc, baseCtx);

      expect(functionResponse.response.success).toBe(false);
      expect(functionResponse.response.message).toMatch(/no longer available/i);
      expect(stateEffects.appointmentArgs).toBeNull();
    });

    it("a generic DB error reports the follow-up message", async () => {
      mockCreateAppointment.mockRejectedValue(new Error("connection reset"));
      const fc = {
        id: "fcD2",
        name: "book_appointment",
        args: { scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane" },
      };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(functionResponse.response.success).toBe(false);
      expect(functionResponse.response.message).toMatch(/error booking/i);
    });

    it("re-booking the slot already booked this call short-circuits to success without inserting", async () => {
      const ctx = {
        ...baseCtx,
        lastBookedAppointment: { scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane" },
      };
      const fc = {
        id: "fcD3",
        name: "book_appointment",
        args: { scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane" },
      };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(mockCreateAppointment).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(true);
      expect(functionResponse.response.message).toMatch(/already booked/i);
      // No appointmentArgs: the original booking already fired the step
      // transition + notifications; the short-circuit must not re-fire them.
      expect(stateEffects.appointmentArgs).toBeNull();
    });
  });

  describe("identity persistence + end_call gating (Phase 2)", () => {
    it("cancel: ctx.identityVerifiedApptId skips the DB identity lookup", async () => {
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const ctx = { ...baseCtx, selectedAppointmentId: "appt-9", identityVerifiedApptId: "appt-9" };
      const fc = { id: "fcI1", name: "cancel_appointment_db", args: {} };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(mockGetAppointmentById).not.toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.identityVerifiedApptId).toBe("appt-9");
      expect(stateEffects.toolResult.appointmentId).toBe("appt-9");
    });

    it("cancel: success records identityVerifiedApptId even when verified via caller-ID match", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-7",
        client_phone: "+15551234567",
        client_name: "Jane",
      });
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const ctx = { ...baseCtx, selectedAppointmentId: "appt-7" };
      const fc = { id: "fcI2", name: "cancel_appointment_db", args: {} };

      const { functionResponse, stateEffects } = await executeToolCall(fc, ctx);

      expect(functionResponse.response.success).toBe(true);
      expect(stateEffects.identityVerifiedApptId).toBe("appt-7");
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
