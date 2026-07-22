/**
 * The quotes capability — and through it, a test of the capability contract
 * itself.
 *
 * quotes was written after the engine was carved up, using only the seams the
 * contract provides. These tests drive the pack directly with a fake engine,
 * which is possible precisely because packs take no service imports: they
 * receive their data surface through ctx.deps and engine.deps. If a pack had to
 * be tested by mocking services/supabase.js, the isolation would be a fiction.
 */

import { describe, it, expect, vi } from "vitest";
import quotes from "../capabilities/quotes.js";
import { STEPS } from "../lib/callState.js";
import { collectTools } from "../capabilities/index.js";
import { collectStepGuidance } from "../lib/capabilities/promptAssembler.js";

const ENABLED = { allowedTasks: ["general_question", "quote_request"] };
const DISABLED = { allowedTasks: ["general_question"] };

/** A stand-in for the engine primitives lib/voice/session.js supplies. */
function makeEngine(overrides = {}) {
  const calls = {
    steps: [],
    notes: [],
    createCustomerRequest: vi.fn().mockResolvedValue("req-1"),
    notifyCustomerRequest: vi.fn().mockResolvedValue(undefined),
    sendCallerSms: vi.fn().mockResolvedValue(undefined),
    errors: [],
  };

  const engine = {
    STEPS,
    setStep: (step, trigger) => calls.steps.push({ step, trigger }),
    addHistoryNote: (note) => calls.notes.push(note),
    setCapabilityState: vi.fn(),
    call: {
      businessId: "biz-1",
      callId: "call-1",
      callerNumber: "+15551234567",
      twilioNumber: "+15559999999",
      config: { businessName: "Dave's Plumbing" },
      ...(overrides.call || {}),
    },
    deps: {
      db: { createCustomerRequest: calls.createCustomerRequest },
      notifications: {
        notifyCustomerRequest: calls.notifyCustomerRequest,
        sendCallerSms: calls.sendCallerSms,
        MESSAGE_SLA_TEXT: "within one business day",
      },
      log: { error: (e, d) => calls.errors.push({ e, d }), info: () => {}, warn: () => {} },
      captureException: (err) => calls.errors.push({ err }),
    },
  };

  return { engine, calls };
}

describe("quotes — registration", () => {
  it("contributes a tool only when the module is enabled", () => {
    expect(collectTools(ENABLED).map((d) => d.name)).toContain("record_quote_request");
    expect(collectTools(DISABLED).map((d) => d.name)).not.toContain("record_quote_request");
  });

  it("contributes flow guidance only when enabled", () => {
    expect(collectStepGuidance(ENABLED, { integrations: [] })).toHaveProperty("quote_request");
    expect(collectStepGuidance(DISABLED, { integrations: [] })).not.toHaveProperty(
      "quote_request"
    );
  });

  it("the flow forbids quoting a price", () => {
    // The single most damaging thing this capability could do is invent a
    // number the business then has to honor or argue about.
    const guidance = collectStepGuidance(ENABLED, { integrations: [] }).quote_request;
    expect(guidance).toContain("NEVER give a price");
  });
});

describe("quotes — execution", () => {
  it("refuses to record without something to price", async () => {
    // A callback the team cannot act on is worse than none: the caller believes
    // a number is coming.
    const result = await quotes.execute({ id: "1", name: "record_quote_request", args: {} });

    expect(result.functionResponse.response.success).toBe(false);
    expect(result.stateEffects.capabilityEffects).toBeUndefined();
    expect(result.stateEffects.toolResult.message).toContain("what specifically");
  });

  it("emits a capability effect rather than a named engine field", async () => {
    const args = {
      service_description: "replace a water heater",
      caller_name: "Mike",
      callback_number: "555-0134",
    };
    const result = await quotes.execute({ id: "1", name: "record_quote_request", args });

    expect(result.functionResponse.response.success).toBe(true);
    expect(result.stateEffects.capabilityEffects).toEqual([
      { capability: "quotes", type: "requested", data: args },
    ]);
    // The whole point: nothing here is a field services/gemini.js or
    // lib/voice/session.js knows the name of.
    expect(result.stateEffects).not.toHaveProperty("appointmentArgs");
    expect(result.stateEffects).not.toHaveProperty("customerRequestArgs");
  });

  it("records what it asked about so a repeat ask is visible", async () => {
    const result = await quotes.execute({
      id: "1",
      name: "record_quote_request",
      args: { service_description: "water heater" },
    });
    expect(result.stateEffects.capabilityState).toEqual({
      quotes: { lastRequested: "water heater" },
    });
  });
});

describe("quotes — effects", () => {
  const effect = {
    capability: "quotes",
    type: "requested",
    data: {
      service_description: "replace a water heater",
      caller_name: "Mike",
      callback_number: "555-0134",
      service_address: "412 Oak Street",
      urgency: "not an emergency",
    },
  };

  it("advances the step and leaves a note so the model does not re-record", async () => {
    const { engine, calls } = makeEngine();
    quotes.onEffect(effect, engine);

    expect(calls.steps).toEqual([{ step: STEPS.CONFIRM, trigger: "record_quote_request" }]);
    expect(calls.notes[0]).toContain("Do not record it again");
    expect(calls.notes[0]).toContain("replace a water heater");
  });

  it("persists into the existing follow-up queue with the detail folded in", async () => {
    const { engine, calls } = makeEngine();
    quotes.onEffect(effect, engine);
    await vi.waitFor(() => expect(calls.notifyCustomerRequest).toHaveBeenCalled());

    const row = calls.createCustomerRequest.mock.calls[0][0];
    expect(row.requestType).toBe("quote");
    expect(row.businessId).toBe("biz-1");
    expect(row.callbackNumber).toBe("555-0134");
    // Address and urgency change the price, so they must survive into what the
    // team actually reads.
    expect(row.message).toContain("replace a water heater");
    expect(row.message).toContain("412 Oak Street");
    expect(row.message).toContain("not an emergency");
  });

  it("falls back to the number the caller rang from", async () => {
    const { engine, calls } = makeEngine();
    quotes.onEffect(
      { ...effect, data: { service_description: "water heater" } },
      engine
    );
    await vi.waitFor(() => expect(calls.createCustomerRequest).toHaveBeenCalled());

    expect(calls.createCustomerRequest.mock.calls[0][0].callbackNumber).toBe("+15551234567");
  });

  it("does not notify when the persist returns no id", async () => {
    const { engine, calls } = makeEngine();
    calls.createCustomerRequest.mockResolvedValue(null);
    quotes.onEffect(effect, engine);
    await new Promise((r) => setImmediate(r));

    // Telling the caller someone will ring back, having stored nothing, is the
    // failure this guards against.
    expect(calls.notifyCustomerRequest).not.toHaveBeenCalled();
  });

  it("ignores effects it does not own", () => {
    const { engine, calls } = makeEngine();
    quotes.onEffect({ capability: "quotes", type: "something_else", data: {} }, engine);
    expect(calls.steps).toEqual([]);
    expect(calls.createCustomerRequest).not.toHaveBeenCalled();
  });

  it("does nothing without a tenant", () => {
    const { engine, calls } = makeEngine({ call: { businessId: null } });
    quotes.onEffect(effect, engine);
    expect(calls.createCustomerRequest).not.toHaveBeenCalled();
  });
});
