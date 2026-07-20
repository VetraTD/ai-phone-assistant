import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Twilio signature validation is orthogonal to what this file tests — disable
// it so requests don't need a real X-Twilio-Signature header. Must be set
// before server.js is first imported (it reads this at module-eval time).
process.env.TWILIO_VALIDATE_SIGNATURE = "false";

const mockIsEnabled = vi.fn(() => true);
const mockLookupBusinessByPhone = vi.fn();
const mockCreateCustomerRequest = vi.fn();
const mockNotifyCustomerRequest = vi.fn(async () => {});

vi.mock("../services/supabase.js", () => ({
  isEnabled: (...args) => mockIsEnabled(...args),
  lookupBusinessByPhone: (...args) => mockLookupBusinessByPhone(...args),
  createCustomerRequest: (...args) => mockCreateCustomerRequest(...args),
}));

vi.mock("../services/notifications.js", () => ({
  notifyCustomerRequest: (...args) => mockNotifyCustomerRequest(...args),
  notifyCallMissed: vi.fn(async () => {}),
}));

import { buildDegradedVoicemailTwiml } from "../lib/twiml.js";
import { setDegraded, clearDegraded, isDegraded } from "../lib/voice/health.js";

describe("lib/voice/health.js — degraded-mode flag", () => {
  afterEach(() => clearDegraded());

  it("starts non-degraded, flips on setDegraded, clears on clearDegraded", () => {
    expect(isDegraded()).toBe(false);
    setDegraded("stt_down");
    expect(isDegraded()).toBe(true);
    clearDegraded();
    expect(isDegraded()).toBe(false);
  });
});

describe("buildDegradedVoicemailTwiml", () => {
  it("shapes: apology <Say>, <Record> with the callback URL, then <Hangup/>", () => {
    const twiml = buildDegradedVoicemailTwiml("https://example.com/twilio/voicemail");

    expect(twiml).toContain("<Response>");
    expect(twiml).toContain("<Say");
    expect(twiml).toContain("leave your name, number, and a brief message");
    expect(twiml).toContain('<Record maxLength="120"');
    expect(twiml).toContain('recordingStatusCallback="https://example.com/twilio/voicemail"');
    expect(twiml).toContain("<Hangup/>");
    // Record must come after the apology and before Hangup.
    expect(twiml.indexOf("<Say")).toBeLessThan(twiml.indexOf("<Record"));
    expect(twiml.indexOf("<Record")).toBeLessThan(twiml.indexOf("<Hangup/>"));
  });

  it("escapes the callback URL for XML safety", () => {
    const twiml = buildDegradedVoicemailTwiml("https://example.com/x?a=1&b=2");
    expect(twiml).toContain("a=1&amp;b=2");
    expect(twiml).not.toContain("a=1&b=2");
  });
});

describe("POST /twilio/voice — degraded mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => clearDegraded());

  it("returns the voicemail-fallback TwiML instead of <Connect><Stream> when degraded", async () => {
    setDegraded("tts_down");
    const { app } = await import("../server.js");

    const res = await request(app)
      .post("/twilio/voice")
      .type("form")
      .send({ CallSid: "CA_degraded_1", To: "+15550001111", From: "+15559998888" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
    expect(res.text).toContain("/twilio/voicemail");
    expect(res.text).not.toContain("<Connect>");
  });

  it("returns <Connect><Stream> as normal when not degraded", async () => {
    const { app } = await import("../server.js");

    const res = await request(app)
      .post("/twilio/voice")
      .type("form")
      .send({ CallSid: "CA_normal_1", To: "+15550001111", From: "+15559998888" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("<Connect><Stream");
    expect(res.text).not.toContain("<Record");
  });
});

describe("POST /twilio/voicemail — degraded-mode recording callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
  });

  it("looks up the business by the dialed number and records a customer request + notifies", async () => {
    mockLookupBusinessByPhone.mockResolvedValue({ id: "biz-123" });
    mockCreateCustomerRequest.mockResolvedValue("req-1");
    const { app } = await import("../server.js");

    const res = await request(app)
      .post("/twilio/voicemail")
      .type("form")
      .send({
        CallSid: "CA_vm_1",
        To: "+15550001111",
        From: "+15559998888",
        RecordingUrl: "https://api.twilio.com/recordings/RE123",
      });

    expect(res.status).toBe(200);
    expect(mockLookupBusinessByPhone).toHaveBeenCalledWith("+15550001111");
    expect(mockCreateCustomerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-123",
        requestType: "message",
        callbackNumber: "+15559998888",
        message: expect.stringContaining("https://api.twilio.com/recordings/RE123"),
      })
    );
    expect(mockNotifyCustomerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-123",
        customerRequest: expect.objectContaining({
          request_type: "message",
          callback_number: "+15559998888",
        }),
      })
    );
  });

  it("skips gracefully (still 200) when no business matches the dialed number", async () => {
    mockLookupBusinessByPhone.mockResolvedValue(null);
    const { app } = await import("../server.js");

    const res = await request(app)
      .post("/twilio/voicemail")
      .type("form")
      .send({ CallSid: "CA_vm_2", To: "+15550009999", From: "+15559998888" });

    expect(res.status).toBe(200);
    expect(mockCreateCustomerRequest).not.toHaveBeenCalled();
    expect(mockNotifyCustomerRequest).not.toHaveBeenCalled();
  });
});
