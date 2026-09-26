/**
 * ctx.party and confirm_identity — spec §9.6 (Task 18).
 *
 * Compliance-critical: an unverified outbound party must never get
 * phone-keyed data, bookings or texts. This file proves the gate at every
 * layer it has to hold at:
 *
 *   - the ONE helper (lib/capabilities/party.js) every consumer reads through;
 *   - the requirement kind (phone_on_file);
 *   - the scheduling adapter's lookup;
 *   - the engine tool (confirm_identity) and its wiring through the Live
 *     tool runner, across tool calls in the same call;
 *   - the DEFERRED capability effects (onEffect), which is where D-c lives:
 *     Task 14's review found the tool-layer fail-closed guarantee did not by
 *     itself cover these.
 *
 * Every test below either builds a ctx with NO `party` field at all (the
 * inbound shape every existing test in this repo already uses) or an
 * explicit outbound-shaped one. The former is the regression proof: nothing
 * here changes what an inbound ctx produces.
 */

import { describe, it, expect, vi } from "vitest";
import { partyOf } from "../lib/capabilities/party.js";
import { checkRequirements } from "../lib/capabilities/requirements.js";
import internalAdapter from "../adapters/scheduling/internal.js";
import appointmentsPack from "../capabilities/appointments.js";
import smsConsentPack from "../capabilities/smsConsent.js";
import { executeToolCall } from "../services/tools.js";
import { buildAllDeclarations, buildCallTools } from "../services/gemini.js";
import { makeFakeDeps } from "../lib/harness/fakeDeps.js";
import { createToolRunner } from "../lib/voice/live/tools.js";

const CONTACT_PHONE = "+15559876543";
const UNVERIFIED = { phone: CONTACT_PHONE, source: "dialed", verified: false };
const VERIFIED = { phone: CONTACT_PHONE, source: "dialed", verified: true };

const futureIso = (days = 3) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
};

// ---------------------------------------------------------------------------
// partyOf — the one helper
// ---------------------------------------------------------------------------
describe("partyOf — the one helper every consumer reads through", () => {
  it("returns ctx.party verbatim when present", () => {
    expect(partyOf({ party: UNVERIFIED })).toBe(UNVERIFIED);
  });

  it("inbound default: no party field, falls back to ctx.callerPhone, verified true — today's behaviour exactly", () => {
    expect(partyOf({ callerPhone: "+15551234567" })).toEqual({
      phone: "+15551234567",
      source: "caller_id",
      verified: true,
    });
  });

  it("accepts the effect-dispatch shape too (engine.call carries callerNumber, not callerPhone)", () => {
    expect(partyOf({ callerNumber: "+15551234567" })).toEqual({
      phone: "+15551234567",
      source: "caller_id",
      verified: true,
    });
  });

  it("a ctx with neither field, and no party, still returns a well-shaped verified party with a null phone", () => {
    expect(partyOf({})).toEqual({ phone: null, source: "caller_id", verified: true });
    expect(partyOf(undefined)).toEqual({ phone: null, source: "caller_id", verified: true });
  });
});

// ---------------------------------------------------------------------------
// phone_on_file — requires party.verified
// ---------------------------------------------------------------------------
const PHONE_ON_FILE_CFG = { require: { identity: { builtin: ["phone_on_file"] } } };

describe("phone_on_file requires party.verified on outbound", () => {
  it("refused before confirm_identity, even though a phone is present (the dialled number)", () => {
    expect(
      checkRequirements(PHONE_ON_FILE_CFG, {}, { toolName: "book_appointment", party: UNVERIFIED }).ok
    ).toBe(false);
  });

  it("satisfied once verified", () => {
    expect(
      checkRequirements(PHONE_ON_FILE_CFG, {}, { toolName: "book_appointment", party: VERIFIED }).ok
    ).toBe(true);
  });

  it("the model's callback_number argument does not bypass verification either", () => {
    expect(
      checkRequirements(
        PHONE_ON_FILE_CFG,
        { callback_number: "+15551112222" },
        { toolName: "book_appointment", party: UNVERIFIED }
      ).ok
    ).toBe(false);
  });

  it("callback_number still satisfies it once verified — same shape as today's callerPhone-present case", () => {
    expect(
      checkRequirements(
        PHONE_ON_FILE_CFG,
        { callback_number: "+15551112222" },
        { toolName: "book_appointment", party: { phone: null, source: "dialed", verified: true } }
      ).ok
    ).toBe(true);
  });

  it("self-verified change tools are unaffected regardless of party (unchanged: their own ownership check is the real gate)", () => {
    expect(
      checkRequirements(PHONE_ON_FILE_CFG, {}, { toolName: "cancel_appointment_db", party: UNVERIFIED }).ok
    ).toBe(true);
  });

  it("inbound (no party field) is untouched — the regression proof", () => {
    expect(
      checkRequirements(PHONE_ON_FILE_CFG, {}, { toolName: "book_appointment", callerPhone: "+15551234567" }).ok
    ).toBe(true);
    expect(checkRequirements(PHONE_ON_FILE_CFG, {}, { toolName: "book_appointment" }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lookupByCaller (internal adapter) — fails closed until verified
// ---------------------------------------------------------------------------
function seedRow() {
  return {
    business_id: "biz-outbound-lookup",
    client_phone: CONTACT_PHONE,
    client_name: "Priya Shah",
    scheduled_at: futureIso(),
    status: "scheduled",
  };
}

describe("adapters/scheduling/internal.js lookupByCaller — outbound party gate", () => {
  it("returns nothing before confirm_identity even though the party's phone matches a row", async () => {
    const { deps } = makeFakeDeps({ seedAppointments: [seedRow()] });
    const ctx = { businessId: "biz-outbound-lookup", party: UNVERIFIED, deps };
    expect(await internalAdapter.lookupByCaller(ctx)).toEqual([]);
  });

  it("returns the row once verified", async () => {
    const { deps } = makeFakeDeps({ seedAppointments: [seedRow()] });
    const ctx = { businessId: "biz-outbound-lookup", party: VERIFIED, deps };
    const found = await internalAdapter.lookupByCaller(ctx);
    expect(found).toHaveLength(1);
    expect(found[0].client_name).toBe("Priya Shah");
  });

  it("inbound (no party field) is untouched — the regression proof", async () => {
    const { deps } = makeFakeDeps({ seedAppointments: [{ ...seedRow(), client_phone: "+15551234567" }] });
    const found = await internalAdapter.lookupByCaller({
      businessId: "biz-outbound-lookup",
      callerPhone: "+15551234567",
      deps,
    });
    expect(found).toHaveLength(1);
  });
});

describe("get_caller_appointments_from_db — outbound party gate, through the real tool dispatch", () => {
  it("finds nothing before confirm_identity", async () => {
    const { deps } = makeFakeDeps({ seedAppointments: [seedRow()] });
    const ctx = {
      businessId: "biz-outbound-lookup",
      config: {},
      capabilityState: {},
      integrations: [],
      party: UNVERIFIED,
      depsOverride: deps,
    };
    const { functionResponse } = await executeToolCall(
      { id: "1", name: "get_caller_appointments_from_db", args: {} },
      ctx
    );
    expect(functionResponse.response.appointments).toEqual([]);
  });

  it("finds it once verified", async () => {
    const { deps } = makeFakeDeps({ seedAppointments: [seedRow()] });
    const ctx = {
      businessId: "biz-outbound-lookup",
      config: {},
      capabilityState: {},
      integrations: [],
      party: VERIFIED,
      depsOverride: deps,
    };
    const { functionResponse } = await executeToolCall(
      { id: "1", name: "get_caller_appointments_from_db", args: {} },
      ctx
    );
    expect(functionResponse.response.appointments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// book_appointment — refuses unverified (when phone_on_file is configured),
// and writes clientPhone = party.phone once verified
// ---------------------------------------------------------------------------
function makeBookDeps() {
  const createAppointmentIfAvailable = vi.fn(async () => ({ id: "appt-outbound-1" }));
  const deps = {
    createAppointmentIfAvailable,
    listAppointmentsByCaller: vi.fn(async () => []),
    getAppointmentById: vi.fn(async () => null),
    updateAppointment: vi.fn(async () => true),
    updateAppointmentStatus: vi.fn(async () => true),
    countScheduledOverlapping: vi.fn(async () => 0),
    listScheduledBetween: vi.fn(async () => []),
    executeIntegration: vi.fn(),
    captureException: vi.fn(),
  };
  return { deps, createAppointmentIfAvailable };
}

const REQUIRE_PHONE_ON_FILE_CONFIG = {
  capabilities: { appointments: { require: { identity: { builtin: ["phone_on_file"] } } } },
};

describe("book_appointment — outbound party gate (spec §9.6)", () => {
  it("refuses before confirm_identity when the business requires phone_on_file", async () => {
    const { deps } = makeBookDeps();
    const ctx = {
      businessId: "biz-outbound-book",
      callId: "call-outbound-1",
      integrations: [],
      capabilityState: {},
      config: REQUIRE_PHONE_ON_FILE_CONFIG,
      spellingSettled: true,
      party: UNVERIFIED,
      depsOverride: deps,
    };
    const fc = { id: "fc1", name: "book_appointment", args: { client_name: "Priya Shah", scheduled_at: futureIso() } };
    const { functionResponse } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(false);
    expect(deps.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("succeeds after confirm_identity and writes clientPhone = party.phone (the contact's number)", async () => {
    const { deps, createAppointmentIfAvailable } = makeBookDeps();
    const ctx = {
      businessId: "biz-outbound-book",
      callId: "call-outbound-1",
      integrations: [],
      capabilityState: {},
      config: REQUIRE_PHONE_ON_FILE_CONFIG,
      spellingSettled: true,
      party: VERIFIED,
      depsOverride: deps,
    };
    const fc = { id: "fc2", name: "book_appointment", args: { client_name: "Priya Shah", scheduled_at: futureIso() } };
    const { functionResponse } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(true);
    expect(createAppointmentIfAvailable).toHaveBeenCalledTimes(1);
    expect(createAppointmentIfAvailable.mock.calls[0][0].clientPhone).toBe(CONTACT_PHONE);
  });

  it("inbound (no party field, no phone_on_file requirement) is untouched — the regression proof", async () => {
    const { deps, createAppointmentIfAvailable } = makeBookDeps();
    const ctx = {
      businessId: "biz-inbound-book",
      callId: "call-inbound-1",
      callerPhone: "+15551234567",
      integrations: [],
      capabilityState: {},
      config: {},
      spellingSettled: true,
      depsOverride: deps,
    };
    const fc = { id: "fc3", name: "book_appointment", args: { client_name: "Jane Smith", scheduled_at: futureIso() } };
    const { functionResponse } = await executeToolCall(fc, ctx);
    expect(functionResponse.response.success).toBe(true);
    expect(createAppointmentIfAvailable.mock.calls[0][0].clientPhone).toBe("+15551234567");
  });
});

// ---------------------------------------------------------------------------
// confirm_identity — the engine tool
// ---------------------------------------------------------------------------
describe("confirm_identity — the engine tool (services/tools.js)", () => {
  it("name_confirmed: true reports partyVerified: true", async () => {
    const { stateEffects, functionResponse } = await executeToolCall(
      { id: "1", name: "confirm_identity", args: { name_confirmed: true } },
      {}
    );
    expect(functionResponse.response.success).toBe(true);
    expect(stateEffects.partyVerified).toBe(true);
  });

  it("name_confirmed: false reports partyVerified: false and tells the model to share nothing", async () => {
    const { stateEffects, functionResponse } = await executeToolCall(
      { id: "1", name: "confirm_identity", args: { name_confirmed: false } },
      {}
    );
    expect(functionResponse.response.success).toBe(true);
    expect(stateEffects.partyVerified).toBe(false);
    expect(functionResponse.response.message).toMatch(/share nothing/i);
  });

  it("is declared only when extras.outboundCall is present (buildCallTools)", () => {
    const outboundNames = buildCallTools(
      { allowedTasks: [] },
      { extras: { outboundCall: { config: { capabilities: [] } } } }
    ).functionDeclarations.map((d) => d.name);
    const inboundNames = buildCallTools({ allowedTasks: [] }, { extras: {} }).functionDeclarations.map(
      (d) => d.name
    );
    expect(outboundNames).toContain("confirm_identity");
    expect(inboundNames).not.toContain("confirm_identity");
  });

  it("is not declared on inbound calls even via the full buildAllDeclarations union", () => {
    const names = buildAllDeclarations({ allowedTasks: [] }, {}).map((d) => d.name);
    expect(names).not.toContain("confirm_identity");
  });
});

// ---------------------------------------------------------------------------
// The Live tool runner — party survives across tool calls within the call
// ---------------------------------------------------------------------------
const RUNNER_CONFIG = {
  businessName: "Riverside Family Clinic",
  timezone: "America/Chicago",
  allowedTasks: ["general_question", "take_message"],
};

describe("createToolRunner — ctx.party wiring (lib/voice/live/tools.js)", () => {
  it("starts unverified, from extras.outboundCall.contact.phone", async () => {
    const execute = vi.fn(async (fc) => ({
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: {},
    }));
    const runner = createToolRunner({
      config: RUNNER_CONFIG,
      extras: {
        integrations: [],
        businessId: "b1",
        callerPhone: "",
        callId: "c1",
        outboundCall: { contact: { phone: CONTACT_PHONE } },
      },
      execute,
      turnState: () => ({}),
    });
    await runner.handleToolCall({
      functionCalls: [{ id: "1", name: "record_customer_request", args: {} }],
    });
    const ctx = execute.mock.calls[0][1];
    expect(ctx.party).toEqual(UNVERIFIED);
    expect(runner.party).toEqual(UNVERIFIED);
  });

  it("is null on an inbound call (no extras.outboundCall) — the regression proof", async () => {
    const execute = vi.fn(async (fc) => ({
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: {},
    }));
    const runner = createToolRunner({
      config: RUNNER_CONFIG,
      extras: { integrations: [], businessId: "b1", callerPhone: "+14699338887", callId: "c1" },
      execute,
      turnState: () => ({}),
    });
    await runner.handleToolCall({
      functionCalls: [{ id: "1", name: "record_customer_request", args: {} }],
    });
    const ctx = execute.mock.calls[0][1];
    expect(ctx.party).toBeNull();
    expect(runner.party).toBeNull();
  });

  it("confirm_identity(true) flips ctx.party.verified for the NEXT tool call on the SAME call", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        functionResponse: { id: "1", name: "confirm_identity", response: { success: true } },
        stateEffects: { partyVerified: true },
      })
      .mockResolvedValueOnce({
        functionResponse: { id: "2", name: "record_customer_request", response: { success: true } },
        stateEffects: {},
      });
    const runner = createToolRunner({
      config: RUNNER_CONFIG,
      extras: {
        integrations: [],
        businessId: "b1",
        callerPhone: "",
        callId: "c1",
        outboundCall: { contact: { phone: CONTACT_PHONE } },
      },
      execute,
      turnState: () => ({}),
    });
    await runner.handleToolCall({
      functionCalls: [{ id: "1", name: "confirm_identity", args: { name_confirmed: true } }],
    });
    expect(runner.party.verified).toBe(true);

    await runner.handleToolCall({
      functionCalls: [{ id: "2", name: "record_customer_request", args: {} }],
    });
    const secondCtx = execute.mock.calls[1][1];
    expect(secondCtx.party).toEqual(VERIFIED);
  });
});

// ---------------------------------------------------------------------------
// Deferred capability effects — D-c: every text-sending effect on an outbound
// call requires party.verified. Task 14's review finding: the tool layer's
// fail-closed guarantee does not by itself cover these; they are gated
// separately (capabilities/appointments.js, smsConsent.js).
// ---------------------------------------------------------------------------
function makeBookedEffectEngine(party) {
  const notifications = {
    notifyAppointmentBooked: vi.fn(async () => {}),
    sendCallerSms: vi.fn(async () => {}),
  };
  const engine = {
    STEPS: { CONFIRM: "confirm" },
    setStep: vi.fn(),
    addHistoryNote: vi.fn(),
    call: {
      callSid: "CA-outbound-1",
      businessId: "biz-outbound-effects",
      party,
      config: { timezone: "America/Chicago", businessName: "Riverside Family Clinic" },
    },
    deps: {
      log: { error: vi.fn(), info: vi.fn() },
      captureException: vi.fn(),
      notifications,
    },
  };
  return { engine, notifications };
}

describe("appointments onEffect (booked) — outbound party gate on the confirmation SMS", () => {
  const EFFECT = {
    capability: "appointments",
    type: "booked",
    data: { scheduled_at: "2026-09-05T15:00:00.000Z", client_name: "Priya Shah" },
  };

  it("sends NO confirmation SMS while the party is unverified", async () => {
    const { engine, notifications } = makeBookedEffectEngine(UNVERIFIED);
    appointmentsPack.onEffect(EFFECT, engine);
    await new Promise((r) => setImmediate(r));
    expect(notifications.sendCallerSms).not.toHaveBeenCalled();
    // The owner alert is NOT a text-sending effect on the party — it still
    // fires, deliberately, whether or not the caller's identity is confirmed.
    expect(notifications.notifyAppointmentBooked).toHaveBeenCalled();
  });

  it("sends the confirmation SMS to party.phone once verified", async () => {
    const { engine, notifications } = makeBookedEffectEngine(VERIFIED);
    appointmentsPack.onEffect(EFFECT, engine);
    await new Promise((r) => setImmediate(r));
    expect(notifications.sendCallerSms).toHaveBeenCalledTimes(1);
    expect(notifications.sendCallerSms.mock.calls[0][1]).toBe(CONTACT_PHONE);
  });

  it("inbound (no party field on engine.call) sends exactly as before — the regression proof", async () => {
    const notifications = {
      notifyAppointmentBooked: vi.fn(async () => {}),
      sendCallerSms: vi.fn(async () => {}),
    };
    const engine = {
      STEPS: { CONFIRM: "confirm" },
      setStep: vi.fn(),
      addHistoryNote: vi.fn(),
      call: {
        callSid: "CA1",
        businessId: "biz-1",
        callerNumber: "+15551112222",
        twilioNumber: null,
        config: { timezone: "America/Chicago" },
      },
      deps: {
        log: { error: vi.fn(), info: vi.fn() },
        captureException: vi.fn(),
        notifications,
      },
    };
    appointmentsPack.onEffect(EFFECT, engine);
    await new Promise((r) => setImmediate(r));
    expect(notifications.sendCallerSms).toHaveBeenCalledTimes(1);
    expect(notifications.sendCallerSms.mock.calls[0][1]).toBe("+15551112222");
  });
});

describe("smsConsent onEffect (answered) — outbound party gate on releasing a held text", () => {
  function makeReleaseEngine(party) {
    const releaseHeldCallerSms = vi.fn(async () => 1);
    return {
      engine: {
        call: { businessId: "biz-outbound-effects", callSid: "CA-outbound-2", party },
        deps: { notifications: { releaseHeldCallerSms }, log: { error: vi.fn(), info: vi.fn() } },
      },
      releaseHeldCallerSms,
    };
  }

  it("does not release a held caller text for an unverified outbound party", () => {
    const { engine, releaseHeldCallerSms } = makeReleaseEngine(UNVERIFIED);
    smsConsentPack.onEffect({ capability: "sms_consent", type: "answered", data: { granted: true } }, engine);
    expect(releaseHeldCallerSms).not.toHaveBeenCalled();
  });

  it("releases it once the party is verified, using party.phone", () => {
    const { engine, releaseHeldCallerSms } = makeReleaseEngine(VERIFIED);
    smsConsentPack.onEffect({ capability: "sms_consent", type: "answered", data: { granted: true } }, engine);
    expect(releaseHeldCallerSms).toHaveBeenCalledWith("biz-outbound-effects", CONTACT_PHONE);
  });
});
