// tests/outboundDoorServerMount.test.js
/**
 * Fix round 1, item 1 (controller, opus review). Every test in
 * tests/outboundDoor.test.js builds its OWN Express app with an injected
 * `validate` -- so nothing there would fail if server.js wired the WRONG
 * validator into registerOutboundDoorRoutes, or wired the outbound routes
 * into inbound's missed-call path. This file imports the REAL server.js
 * `app`, in the style of tests/twilioSignatureValidation.test.js (which does
 * not exercise the outbound routes at all, and stays untouched).
 *
 * Covers:
 *   - /twilio/outbound-answer and /twilio/outbound-status: unsigned and
 *     wrongly-signed POSTs refuse with 403 (not 500), a correctly signed one
 *     gets 200 -- the REAL twilioValidationAnyAccount, not a fake.
 *   - /twilio/live-voice is untouched: its TwiML still carries
 *     businessPhone/callerPhone and carries NO direction Parameter.
 *   - /twilio/status (inbound) with `busy` still calls notifyCallMissed AND
 *     sendCallerSms; /twilio/outbound-status with the identical body calls
 *     NEITHER -- the actual proof that Ruling P-2 holds at the server.js
 *     wiring level, not just inside doorRoutes.js's own unit tests.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import * as callState from "../lib/callState.js";

const AUTH_TOKEN = "outbound-door-mount-token";
const BASE = "https://outbound-mount.example.test";

process.env.TWILIO_VALIDATE_SIGNATURE = "true";
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.BASE_URL = BASE;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

const mockIsEnabled = vi.fn(() => true);
const mockLookupBusinessByPhone = vi.fn(async () => null);
const mockCompleteCall = vi.fn(async () => {});
const mockOutboundAttemptByCallSid = vi.fn(async () => null);

// A plain object, not a spread of importOriginal -- the same choice
// tests/twilioSignatureValidation.test.js makes, and for the same reason:
// this file asserts exactly what server.js calls on db, so an accidental
// extra real export sneaking through would hide a missing mock instead of
// failing loudly.
vi.mock("../services/db.js", () => ({
  // Launch guards (batch 3 S4): harmless defaults so a found business does not log guard failures.
  recordPendingDial: async () => "1",
  endPendingDial: async () => 0,
  inboundGuardFacts: async () => ({ blocked: false, bounced: false, callsToday: 0 }),
  aiSecondsToday: async () => ({ after: 0, before: 0 }),
  isEnabled: (...args) => mockIsEnabled(...args),
  lookupBusinessByPhone: (...args) => mockLookupBusinessByPhone(...args),
  loadConfig: (business) =>
    business
      ? {
          businessName: business.name || "Test Biz",
          smsFollowupEnabled: business.sms_followup_enabled ?? false,
          smsTemplates: {},
        }
      : null,
  completeCall: (...args) => mockCompleteCall(...args),
  fetchCallTranscript: async () => [],
  updateCallSummary: async () => {},
  updateCallLatency: async () => {},
  withTenantSafe: async (_businessId, fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  },
  withTenant: async (_businessId, fn) => fn(),
  // The outbound door's own functions (Task 12). A miss (null) by default:
  // every test here is about the WIRE, not about a specific attempt row.
  outboundAttemptByCallSid: (...args) => mockOutboundAttemptByCallSid(...args),
  stampAttemptStatus: async () => {},
  fetchAttemptVoicemailAudio: async () => null,
}));

const mockNotifyCallMissed = vi.fn(async () => {});
const mockSendCallerSms = vi.fn(async () => {});

vi.mock("../services/notifications.js", () => ({
  notifyCallMissed: (...args) => mockNotifyCallMissed(...args),
  sendCallerSms: (...args) => mockSendCallerSms(...args),
  HAS_SMS_CREDS: true,
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

/** Twilio's documented scheme: URL, then each POST param appended key+value in sorted key order. */
function twilioSignature(url, params, token = AUTH_TOKEN) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return crypto.createHmac("sha1", token).update(Buffer.from(payload, "utf-8")).digest("base64");
}

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

beforeEach(() => {
  mockIsEnabled.mockReset().mockReturnValue(true);
  mockLookupBusinessByPhone.mockReset().mockResolvedValue(null);
  mockCompleteCall.mockReset().mockResolvedValue();
  mockOutboundAttemptByCallSid.mockReset().mockResolvedValue(null);
  mockNotifyCallMissed.mockReset().mockResolvedValue();
  mockSendCallerSms.mockReset().mockResolvedValue();
});

describe("server.js's real mount: the outbound doors carry the real Twilio signature check", () => {
  const answerParams = { CallSid: "CAoutmount0001", From: "+15550001111", To: "+15550002222" };
  const statusParams = { CallSid: "CAoutmount0002", CallStatus: "completed", From: "+15550001111", To: "+15550002222" };

  it("POST /twilio/outbound-answer: no signature -> 403", async () => {
    const res = await request(app).post("/twilio/outbound-answer").type("form").send(answerParams);
    expect(res.status).toBe(403);
  });

  it("POST /twilio/outbound-answer: wrong signature -> 403, NOT 500", async () => {
    const res = await request(app)
      .post("/twilio/outbound-answer")
      .type("form")
      .set("X-Twilio-Signature", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=")
      .send(answerParams);
    expect(res.status).toBe(403);
  });

  it("POST /twilio/outbound-answer: correctly signed -> 200", async () => {
    const sig = twilioSignature(BASE + "/twilio/outbound-answer", answerParams);
    const res = await request(app).post("/twilio/outbound-answer").type("form").set("X-Twilio-Signature", sig).send(answerParams);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response>");
  });

  it("POST /twilio/outbound-status: no signature -> 403", async () => {
    const res = await request(app).post("/twilio/outbound-status").type("form").send(statusParams);
    expect(res.status).toBe(403);
  });

  it("POST /twilio/outbound-status: wrong signature -> 403, NOT 500", async () => {
    const res = await request(app)
      .post("/twilio/outbound-status")
      .type("form")
      .set("X-Twilio-Signature", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=")
      .send(statusParams);
    expect(res.status).toBe(403);
  });

  it("POST /twilio/outbound-status: correctly signed -> 200", async () => {
    const sig = twilioSignature(BASE + "/twilio/outbound-status", statusParams);
    const res = await request(app).post("/twilio/outbound-status").type("form").set("X-Twilio-Signature", sig).send(statusParams);
    expect(res.status).toBe(200);
  });

  // O-26/C17 (post-2c): confirm ONLY -- change nothing about signature
  // validation itself. twilioValidationAnyAccount (server.js) already
  // accepts EITHER token; this proves an outbound door callback signed with
  // account B's token (TWILIO_AUTH_TOKEN_ALT) is accepted exactly as one
  // signed with account A's is above.
  it("POST /twilio/outbound-status: signed with account B's token (TWILIO_AUTH_TOKEN_ALT) -> 200 (confirm only, nothing changed here)", async () => {
    const ALT_TOKEN = "outbound-door-mount-token-B";
    process.env.TWILIO_AUTH_TOKEN_ALT = ALT_TOKEN;
    try {
      const sig = twilioSignature(BASE + "/twilio/outbound-status", statusParams, ALT_TOKEN);
      const res = await request(app).post("/twilio/outbound-status").type("form").set("X-Twilio-Signature", sig).send(statusParams);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.TWILIO_AUTH_TOKEN_ALT;
    }
  });
});

describe("server.js's real mount: /twilio/live-voice is untouched by the outbound mount", () => {
  it("its TwiML still carries businessPhone/callerPhone and carries NO direction Parameter", async () => {
    mockLookupBusinessByPhone.mockResolvedValueOnce({ id: "biz-live", name: "Live Biz", phone_number: "+15550003333" });
    const params = { CallSid: "CAoutmount0003", From: "+15550004444", To: "+15550003333" };
    const sig = twilioSignature(BASE + "/twilio/live-voice", params);
    const res = await request(app).post("/twilio/live-voice").type("form").set("X-Twilio-Signature", sig).send(params);

    expect(res.status).toBe(200);
    expect(res.text).toContain("<Connect><Stream");
    expect(res.text).toContain('<Parameter name="businessPhone"');
    expect(res.text).toContain('<Parameter name="callerPhone"');
    expect(res.text).not.toMatch(/name="direction"/);
  });
});

describe("server.js's real mount: /twilio/status keeps its missed-call path; /twilio/outbound-status never runs it", () => {
  // The SAME CallSid, the SAME CallStatus, the SAME From/To on both requests
  // -- proving the independence holds even when nothing about the body would
  // distinguish the two routes, only which door received it.
  const callSid = "CAoutmount0004";
  const busyBody = { CallSid: callSid, CallStatus: "busy", From: "+15550005555", To: "+15550006666" };

  it("/twilio/status with CallStatus=busy calls notifyCallMissed AND sendCallerSms", async () => {
    mockLookupBusinessByPhone.mockResolvedValue({ id: "biz-missed", name: "Missed Biz", sms_followup_enabled: true });
    await callState.writeShared(callSid, { businessId: "biz-missed" });
    await callState.flushShared(callSid);

    const sig = twilioSignature(BASE + "/twilio/status", busyBody);
    const res = await request(app).post("/twilio/status").type("form").set("X-Twilio-Signature", sig).send(busyBody);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockSendCallerSms).toHaveBeenCalled());

    expect(mockNotifyCallMissed).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-missed",
        call: expect.objectContaining({ callerNumber: "+15550005555", twilioNumber: "+15550006666" }),
        status: "busy",
      })
    );
    expect(mockSendCallerSms).toHaveBeenCalledWith(
      expect.objectContaining({ smsFollowupEnabled: true, businessName: "Missed Biz" }),
      "+15550005555",
      "missed_call",
      expect.any(Object)
    );
  });

  it("/twilio/outbound-status with the IDENTICAL body calls NEITHER", async () => {
    // mockOutboundAttemptByCallSid resets to null (unknown SID) in beforeEach
    // -- this CallSid was never an outbound attempt, and that alone must be
    // enough to prove the two paths share no wiring: even a SID that just
    // triggered inbound's missed-call block gets a plain 200 no-op here.
    const sig = twilioSignature(BASE + "/twilio/outbound-status", busyBody);
    const res = await request(app).post("/twilio/outbound-status").type("form").set("X-Twilio-Signature", sig).send(busyBody);
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    expect(mockNotifyCallMissed).not.toHaveBeenCalled();
    expect(mockSendCallerSms).not.toHaveBeenCalled();
  });
});
