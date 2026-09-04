import { describe, it, expect, vi } from "vitest";
import { callToolNames } from "../services/gemini.js";
import { buildLiveTools, createToolRunner } from "../lib/voice/live/tools.js";

// ---------------------------------------------------------------------------
// Declare all TEN tools -- and prove it with a COUNT.
//
// Probe rounds 1 and 2 declared six. The model therefore could not check
// availability, and every behavioural observation from those two rounds is
// suspect as a result: it was measuring a receptionist that had been given no
// calendar. That is harness defect #1 in
// docs/speech-to-speech-handoff.md section 11, and it cost two rounds.
//
// The fix that holds is not "remember to list ten". It is to build from
// production's own union -- buildCallTools + buildIntegrationTools +
// buildDbAppointmentTools, joined at services/gemini.js buildAllDeclarations --
// so a business that gains a capability gains the tool here automatically and
// there is no second list to drift.
//
// The assertion is a COUNT and an exact name set, not a presence check.
// Asserting presence is precisely what hid 2.5's duplicate bookings: the suite
// scored 15/15 and 20/20 while the model re-fired tools in half its trials,
// because nothing ever counted.
// ---------------------------------------------------------------------------

/** Digile Media's shape: appointments on the built-in calendar, plus messages. */
const APPOINTMENTS_CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: [
    "general_question",
    "take_message",
    "book_appointment",
    "cancel_appointment",
    "reschedule_appointment",
    "check_appointment",
  ],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
  businessHours: {},
};

/** A business that takes messages and nothing else. */
const MESSAGES_ONLY_CONFIG = {
  businessName: "Somewhere Small",
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
};

const EXTRAS = { integrations: [] };

describe("buildLiveTools", () => {
  it("declares exactly what production declares, name for name and in order", () => {
    const declared = buildLiveTools(APPOINTMENTS_CONFIG, EXTRAS)[0].functionDeclarations;

    expect(declared.map((d) => d.name)).toEqual(callToolNames(APPOINTMENTS_CONFIG, EXTRAS));
  });

  // Ten and eleven, not "at least ten". The count is the assertion, for the
  // reason in the header: presence checks are what hid the duplicate bookings.
  //
  // The pair is new on 2026-09-04 and the DIFFERENCE is the whole point.
  // record_sms_consent is now withheld from a tenant that cannot send texts at
  // all -- because on a real call to exactly such a tenant the assistant opened
  // by asking for SMS consent, the tool failed twice, and the caller's confused
  // "Hello." was read as an answer (LVX52). Asserting both numbers means a
  // future change cannot quietly restore the tool for the tenants it was taken
  // away from, nor remove it from the ones that use it.
  it("declares ten for an appointments business that cannot text", () => {
    const declared = buildLiveTools(APPOINTMENTS_CONFIG, EXTRAS)[0].functionDeclarations;

    expect(declared).toHaveLength(10);
    expect(declared.map((d) => d.name)).not.toContain("record_sms_consent");
  });

  it("declares eleven once that business can text", () => {
    const texting = { ...APPOINTMENTS_CONFIG, smsFollowupEnabled: true };
    const declared = buildLiveTools(texting, EXTRAS)[0].functionDeclarations;

    expect(declared).toHaveLength(11);
    expect(declared.map((d) => d.name)).toContain("record_sms_consent");
  });

  it("includes the availability check, whose absence is what broke rounds 1 and 2", () => {
    const names = buildLiveTools(APPOINTMENTS_CONFIG, EXTRAS)[0].functionDeclarations.map((d) => d.name);

    expect(names).toContain("check_appointment_availability");
  });

  it("declares fewer for a business with fewer capabilities", () => {
    // Guards against the lazy fix: hardcoding ten would pass every assertion
    // above and be wrong for every business that is not this one.
    const declared = buildLiveTools(MESSAGES_ONLY_CONFIG, EXTRAS)[0].functionDeclarations;

    expect(declared.length).toBeLessThan(10);
    expect(declared.map((d) => d.name)).toEqual(callToolNames(MESSAGES_ONLY_CONFIG, EXTRAS));
  });

  it("wraps them in the shape a Live session config expects", () => {
    const tools = buildLiveTools(APPOINTMENTS_CONFIG, EXTRAS);

    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(Array.isArray(tools[0].functionDeclarations)).toBe(true);
  });
});

describe("the tool runner", () => {
  /** A stub standing in for executeToolCallGuarded, recording its context. */
  function recorder(responses = {}) {
    const seen = [];
    return {
      seen,
      execute: vi.fn(async (fc, ctx) => {
        seen.push({ fc, ctx });
        return (
          responses[fc.name] || {
            functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
            stateEffects: {},
          }
        );
      }),
    };
  }

  function runner(overrides = {}) {
    const rec = overrides.recorder || recorder();
    return {
      rec,
      runner: createToolRunner({
        config: APPOINTMENTS_CONFIG,
        extras: EXTRAS,
        execute: rec.execute,
        turnState: () => ({ step: "greeting", callerTurnCount: 2, ...(overrides.turnState || {}) }),
        ...overrides.opts,
      }),
    };
  }

  it("returns one functionResponse per call, so the model is never left waiting", async () => {
    // A Live session that gets fewer responses than calls hangs the turn. The
    // caller hears silence, which the spike's own notes flag as the failure
    // mode a tool bridge must not have.
    const { runner: r } = runner();
    const out = await r.handleToolCall({
      functionCalls: [
        { id: "a", name: "check_appointment_availability", args: { requested_at: "2026-09-15" } },
        { id: "b", name: "set_call_intent", args: { intent: "book_appointment" } },
      ],
    });

    expect(out.functionResponses.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("passes the business config and tenant through to the tool", async () => {
    const { runner: r, rec } = runner({
      opts: { extras: { ...EXTRAS, businessId: "biz-1", callerPhone: "+447700900000", callId: "call-1" } },
    });
    await r.handleToolCall({ functionCalls: [{ id: "a", name: "set_call_intent", args: {} }] });

    const ctx = rec.execute.mock.calls[0][1];
    expect(ctx.businessId).toBe("biz-1");
    expect(ctx.callerPhone).toBe("+447700900000");
    expect(ctx.config.businessName).toBe("Digile Media");
  });

  it("threads capabilityState from one call into the next in the same round", async () => {
    // "Look up my appointment, then cancel it" arrives as two calls in one
    // round. Without the thread the second fails with "Which appointment?" --
    // services/gemini.js rebuilds toolCtx per call for exactly this reason.
    const rec = recorder({
      get_caller_appointments_from_db: {
        functionResponse: { id: "a", name: "get_caller_appointments_from_db", response: { success: true } },
        stateEffects: { capabilityState: { appointments: { selectedAppointmentId: "appt-9" } } },
      },
    });
    const { runner: r } = runner({ recorder: rec });

    await r.handleToolCall({
      functionCalls: [
        { id: "a", name: "get_caller_appointments_from_db", args: {} },
        { id: "b", name: "cancel_appointment_db", args: {} },
      ],
    });

    expect(rec.seen[1].ctx.capabilityState.appointments.selectedAppointmentId).toBe("appt-9");
  });

  it("carries capability state across turns, not just within a round", async () => {
    const rec = recorder({
      get_caller_appointments_from_db: {
        functionResponse: { id: "a", name: "get_caller_appointments_from_db", response: { success: true } },
        stateEffects: { capabilityState: { appointments: { selectedAppointmentId: "appt-9" } } },
      },
    });
    const { runner: r } = runner({ recorder: rec });

    await r.handleToolCall({ functionCalls: [{ id: "a", name: "get_caller_appointments_from_db", args: {} }] });
    await r.handleToolCall({ functionCalls: [{ id: "b", name: "cancel_appointment_db", args: {} }] });

    expect(rec.seen[1].ctx.capabilityState.appointments.selectedAppointmentId).toBe("appt-9");
  });

  it("does not execute a call the availability invariant blocked", async () => {
    const { runner: r, rec } = runner();
    const out = await r.handleToolCall({
      functionCalls: [{ id: "a", name: "book_appointment", args: { scheduled_at: "2026-09-15T15:00:00" } }],
    });

    expect(rec.execute).not.toHaveBeenCalled();
    expect(out.functionResponses[0].response.success).toBe(false);
    expect(out.functionResponses[0].response.message).toMatch(/check_appointment_availability/);
  });

  it("executes a booking once the availability check has verified the slot", async () => {
    const rec = recorder({
      check_appointment_availability: {
        functionResponse: {
          id: "a",
          name: "check_appointment_availability",
          response: { success: true, available: true, message: "That time is available." },
        },
        stateEffects: {},
      },
    });
    const { runner: r } = runner({ recorder: rec });

    await r.handleToolCall({
      functionCalls: [{ id: "a", name: "check_appointment_availability", args: { requested_at: "2026-09-15T14:00:00" } }],
    });
    const out = await r.handleToolCall({
      functionCalls: [{ id: "b", name: "book_appointment", args: { scheduled_at: "2026-09-15T14:00:00" } }],
    });

    expect(out.functionResponses[0].response.success).toBe(true);
    expect(rec.execute).toHaveBeenCalledTimes(2);
  });

  it("suppresses a doubled end_call without executing it twice", async () => {
    // Measured: 3.1 doubled end_call in 2 of 26 trials.
    const { runner: r, rec } = runner();
    await r.handleToolCall({ functionCalls: [{ id: "a", name: "end_call", args: {} }] });
    await r.handleToolCall({ functionCalls: [{ id: "b", name: "end_call", args: {} }] });

    expect(rec.execute).toHaveBeenCalledTimes(1);
  });

  it("surfaces the state effects the reply reducer needs", async () => {
    const rec = recorder({
      set_call_intent: {
        functionResponse: { id: "a", name: "set_call_intent", response: { success: true } },
        stateEffects: { intentArgs: { intent: "book_appointment" }, toolResult: { name: "set_call_intent", success: true } },
      },
    });
    const { runner: r } = runner({ recorder: rec });

    const out = await r.handleToolCall({ functionCalls: [{ id: "a", name: "set_call_intent", args: {} }] });

    expect(out.intentArgs).toEqual({ intent: "book_appointment" });
    expect(out.toolResults).toHaveLength(1);
  });

  it("answers with a failure rather than throwing when a tool blows up", async () => {
    // A throw here leaves the Live session with an unanswered call, and the
    // caller hears nothing at all. A failed response at least lets the model
    // apologise.
    const rec = recorder();
    rec.execute.mockRejectedValueOnce(new Error("boom"));
    const { runner: r } = runner({ recorder: rec });

    const out = await r.handleToolCall({ functionCalls: [{ id: "a", name: "set_call_intent", args: {} }] });

    expect(out.functionResponses).toHaveLength(1);
    expect(out.functionResponses[0].response.success).toBe(false);
  });
});
