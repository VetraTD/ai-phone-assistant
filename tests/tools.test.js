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

    it("cancel_appointment_db: allows when the model-supplied client_name matches (phone mismatch)", async () => {
      mockGetAppointmentById.mockResolvedValue({
        id: "appt-1",
        client_phone: "+19995550000", // does not match ctx.callerPhone
        client_name: "Jane Doe",
      });
      mockUpdateAppointmentStatus.mockResolvedValue(true);
      const fc = { id: "fc9b", name: "cancel_appointment_db", args: { appointment_id: "appt-1", client_name: "jane doe" } };

      const { functionResponse } = await executeToolCall(fc, baseCtx);

      expect(mockUpdateAppointmentStatus).toHaveBeenCalled();
      expect(functionResponse.response.success).toBe(true);
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
});
