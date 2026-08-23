import { describe, it, expect, vi } from "vitest";
import pack from "../capabilities/smsConsent.js";
import { SMS_CONSENT_SCRIPT, SMS_CONSENT_SCRIPT_VERSION } from "../lib/smsConsent.js";

// The asking half of ledger O25. The gate it feeds lives in
// services/notifications.js and is tested in tests/notifications.sms.test.js;
// the store it writes to is tested against a real database under FORCE row
// level security in tests/db/smsConsent.test.js.
//
// Every refusal here is paired with the corresponding acceptance. A pack whose
// execute() returned success=false unconditionally would satisfy half of this
// file, which is the failure mode the ledger's own contract names: "a gate
// built only from negative cases is not a gate".

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const ENABLED = { smsFollowupEnabled: true, businessName: "Test Clinic" };
const DISABLED = { smsFollowupEnabled: false, businessName: "Test Clinic" };

function makeCtx(overrides = {}) {
  return {
    businessId: BUSINESS_ID,
    callId: "call-1",
    callerPhone: "+15551234567",
    config: ENABLED,
    deps: { recordSmsConsent: vi.fn(async () => "consent-1") },
    ...overrides,
  };
}

const fc = (granted) => ({ id: "fc1", name: "record_sms_consent", args: { granted } });

describe("sms_consent pack — registration", () => {
  it("registers its tool regardless of configuration (the core-pack contract)", () => {
    expect(pack.tools(DISABLED).map((t) => t.name)).toEqual(["record_sms_consent"]);
    expect(pack.tools(ENABLED).map((t) => t.name)).toEqual(["record_sms_consent"]);
  });

  it("is not an action tool — agreeing to a text must not unlock a same-turn hangup", () => {
    expect(pack.actionTools).toEqual([]);
  });
});

describe("sms_consent pack — prompt", () => {
  it("teaches the protocol, verbatim, when the tenant sends texts", () => {
    const { static: stat } = pack.prompt(ENABLED);
    expect(stat.protocols.join("\n")).toContain(SMS_CONSENT_SCRIPT);
    expect(stat.capabilities.length).toBe(1);
  });

  it("tells the model it cannot text at all when the tenant does not", () => {
    const { static: stat } = pack.prompt(DISABLED);
    expect(stat.protocols).toBeUndefined();
    expect(stat.capabilities).toBeUndefined();
    expect(stat.guardrails.join("\n")).toMatch(/cannot send text messages/i);
  });

  // The disclosure has to be reproducible next to a stored consent row years
  // later, so the words in the prompt and the words written to the row are one
  // constant and not two strings that happen to agree today.
  it("puts the same words in the prompt that execute writes to the row", async () => {
    const ctx = makeCtx();
    await pack.execute(fc(true), ctx);
    const written = ctx.deps.recordSmsConsent.mock.calls[0][0];
    expect(pack.prompt(ENABLED).static.protocols.join("\n")).toContain(written.script);
  });
});

describe("sms_consent pack — execute", () => {
  it("records a YES and reports success", async () => {
    const ctx = makeCtx();
    const out = await pack.execute(fc(true), ctx);

    expect(ctx.deps.recordSmsConsent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      callId: "call-1",
      phoneNumber: "+15551234567",
      granted: true,
      script: SMS_CONSENT_SCRIPT,
      scriptVersion: SMS_CONSENT_SCRIPT_VERSION,
    });
    expect(out.functionResponse.response.success).toBe(true);
    expect(out.stateEffects.capabilityEffects).toEqual([
      { capability: "sms_consent", type: "answered", data: { granted: true } },
    ]);
  });

  // A refusal is a record, not a no-op: it is what supersedes an earlier grant
  // and what stops the receptionist asking twice.
  it("records a NO and still reports success", async () => {
    const ctx = makeCtx();
    const out = await pack.execute(fc(false), ctx);

    expect(ctx.deps.recordSmsConsent.mock.calls[0][0].granted).toBe(false);
    expect(out.functionResponse.response.success).toBe(true);
    expect(out.stateEffects.capabilityEffects[0].data.granted).toBe(false);
  });

  it("refuses, and writes nothing, when the tenant does not send texts", async () => {
    const ctx = makeCtx({ config: DISABLED });
    const out = await pack.execute(fc(true), ctx);

    expect(ctx.deps.recordSmsConsent).not.toHaveBeenCalled();
    expect(out.functionResponse.response.success).toBe(false);
    expect(out.stateEffects.capabilityEffects).toBeUndefined();
  });

  // Twilio reports a withheld caller ID as a non-E.164 string. There is no
  // number to consent FOR, so no row may claim there is one.
  it("refuses, and writes nothing, for a withheld caller ID", async () => {
    const ctx = makeCtx({ callerPhone: "anonymous" });
    const out = await pack.execute(fc(true), ctx);

    expect(ctx.deps.recordSmsConsent).not.toHaveBeenCalled();
    expect(out.functionResponse.response.success).toBe(false);
  });

  // The reason this write is awaited instead of deferred like
  // record_customer_request: a failed insert must reach the model, or it tells
  // the caller a text is coming that the gate will then refuse to send.
  it("reports failure to the model when the write does not land", async () => {
    const ctx = makeCtx({ deps: { recordSmsConsent: vi.fn(async () => null) } });
    const out = await pack.execute(fc(true), ctx);

    expect(out.functionResponse.response.success).toBe(false);
    expect(out.stateEffects.capabilityEffects).toBeUndefined();
  });

  it("records the answer on the call so the model stops re-asking", async () => {
    const out = await pack.execute(fc(true), makeCtx());
    expect(out.stateEffects.capabilityState.sms_consent.granted).toBe(true);
    expect(out.stateEffects.capabilityState.sms_consent.callerFacts["Text confirmation"]).toMatch(
      /agreed/
    );
  });
});

describe("sms_consent pack — onEffect releases what the gate held", () => {
  function makeEngine() {
    return {
      call: { businessId: BUSINESS_ID, callerNumber: "+15551234567", callSid: "CA1" },
      deps: {
        notifications: { releaseHeldCallerSms: vi.fn(async () => 1) },
        log: { error: vi.fn(), info: vi.fn() },
      },
    };
  }

  it("releases the held text after a grant", () => {
    const engine = makeEngine();
    pack.onEffect({ capability: "sms_consent", type: "answered", data: { granted: true } }, engine);
    expect(engine.deps.notifications.releaseHeldCallerSms).toHaveBeenCalledWith(
      BUSINESS_ID,
      "+15551234567"
    );
  });

  it("releases nothing after a refusal", () => {
    const engine = makeEngine();
    pack.onEffect({ capability: "sms_consent", type: "answered", data: { granted: false } }, engine);
    expect(engine.deps.notifications.releaseHeldCallerSms).not.toHaveBeenCalled();
  });

  it("ignores effect types it does not own", () => {
    const engine = makeEngine();
    pack.onEffect({ capability: "sms_consent", type: "recorded", data: { granted: true } }, engine);
    expect(engine.deps.notifications.releaseHeldCallerSms).not.toHaveBeenCalled();
  });

  it("does not throw when there is no tenant on the call", () => {
    const engine = makeEngine();
    engine.call.businessId = null;
    expect(() =>
      pack.onEffect({ capability: "sms_consent", type: "answered", data: { granted: true } }, engine)
    ).not.toThrow();
    expect(engine.deps.notifications.releaseHeldCallerSms).not.toHaveBeenCalled();
  });
});
