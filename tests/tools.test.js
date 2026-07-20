import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();
const mockListAppointmentsByCaller = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
const mockUpdateAppointment = vi.fn();
const mockExecuteIntegration = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("../services/supabase.js", () => ({
  createAppointment: (...args) => mockCreateAppointment(...args),
  listAppointmentsByCaller: (...args) => mockListAppointmentsByCaller(...args),
  updateAppointmentStatus: (...args) => mockUpdateAppointmentStatus(...args),
  updateAppointment: (...args) => mockUpdateAppointment(...args),
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

  it("get_caller_appointments_from_db: preserves the TODO(phase2) positional-arg bug", async () => {
    mockListAppointmentsByCaller.mockResolvedValue([{ id: "appt-9" }]);
    const fc = { id: "fc6", name: "get_caller_appointments_from_db", args: {} };

    const { stateEffects } = await executeToolCall(fc, baseCtx);

    // Bug preserved verbatim: callerPhone is passed as the bare second
    // positional arg, not { clientPhone, clientName }.
    expect(mockListAppointmentsByCaller).toHaveBeenCalledWith("biz-1", "+15551234567");
    expect(stateEffects.selectedAppointmentId).toBe("appt-9");
  });
});
