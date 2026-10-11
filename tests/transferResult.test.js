import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// POST /twilio/transfer-result against the REAL app. Signature validation is
// orthogonal here (tests/voicemailSignature.test.js covers it ON).
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.BASE_URL = "https://test.example.com";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

const mockIsEnabled = vi.fn(() => true);
const mockLookup = vi.fn(async () => null);

vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: (...a) => mockIsEnabled(...a),
  lookupBusinessByPhone: (...a) => mockLookup(...a),
  loadConfig: (business) => (business ? { locale: business.locale, businessName: business.name } : null),
}));

import { CALL_LINES, buildMessageTwiml } from "../lib/twiml.js";

const BASE = "https://test.example.com";
const UK = "+441372656055";
const US = "+15550001111";
const FROM = "+447700900123";
const post = (app, body) => request(app).post("/twilio/transfer-result").type("form").send(body);
const expected = (voice, to) =>
  buildMessageTwiml({
    line: CALL_LINES.noAnswer,
    sayVoice: voice,
    callbackUrl: `${BASE}/twilio/voicemail?to=${encodeURIComponent(to)}`,
    actionUrl: `${BASE}/twilio/message-done`,
  });

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 30000);

beforeEach(() => {
  mockIsEnabled.mockReset().mockReturnValue(true);
  mockLookup.mockReset().mockResolvedValue(null);
});

describe("POST /twilio/transfer-result", () => {
  it("completed -> exactly a Hangup, text/xml, and no business lookup", async () => {
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toBe("<Response><Hangup/></Response>");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each(["no-answer", "busy", "failed", "canceled"])("%s with a UK business -> message in Polly.Amy", async (status) => {
    mockLookup.mockResolvedValue({ id: "b1", name: "Biz", locale: "en-GB" });
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: status });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toBe(expected("Polly.Amy", UK));
    expect(res.text).toContain('recordingStatusCallback="https://test.example.com/twilio/voicemail?to=%2B441372656055"');
    expect(res.text).toContain('action="https://test.example.com/twilio/message-done"');
    expect(res.text).not.toContain(encodeURIComponent(FROM));
    expect(mockLookup).toHaveBeenCalledWith(UK);
  });

  it("a US business -> Polly.Joanna", async () => {
    mockLookup.mockResolvedValue({ id: "b2", name: "Biz", locale: "en-US" });
    const res = await post(app, { CallSid: "CA1", To: US, From: "+15557778888", DialCallStatus: "no-answer" });
    expect(res.text).toBe(expected("Polly.Joanna", US));
  });

  it("lookup throws -> still 200 message, guess voice from the dialled UK number", async () => {
    mockLookup.mockRejectedValue(new Error("db down"));
    const res = await post(app, { CallSid: "CA1", To: UK, From: "+15557778888", DialCallStatus: "no-answer" });
    expect(res.status).toBe(200);
    expect(res.text).toBe(expected("Polly.Amy", UK));
  });

  it("unknown business -> guess voice (UK caller) ", async () => {
    const res = await post(app, { CallSid: "CA1", To: US, From: FROM, DialCallStatus: "busy" });
    expect(res.text).toBe(expected("Polly.Amy", US));
  });

  it("unknown business, US both ends -> en-US voice", async () => {
    const res = await post(app, { CallSid: "CA1", To: US, From: "+15557778888", DialCallStatus: "busy" });
    expect(res.text).toBe(expected("Polly.Joanna", US));
  });

  it("DB disabled -> no lookup, guess voice", async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "failed" });
    expect(mockLookup).not.toHaveBeenCalled();
    expect(res.text).toBe(expected("Polly.Amy", UK));
  });

  it("missing DialCallStatus -> message, never empty", async () => {
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
  });

  it("missing To -> message with an empty ?to=, no lookup, no crash", async () => {
    const res = await post(app, { CallSid: "CA1", DialCallStatus: "no-answer" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
