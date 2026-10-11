import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import twilio from "twilio";

// The recording-status callback target /twilio/voicemail carries the business in
// its QUERY (?to=) and must accept a signature from EITHER Twilio account. Like
// tests/twilioSignatureValidation.test.js this turns validation ON; the env must
// be set before server.js is first imported.
const TOKEN_A = "voicemail_test_token_account_a";
const TOKEN_B = "voicemail_test_token_account_b";
const BASE = "https://test.example.com";

process.env.TWILIO_VALIDATE_SIGNATURE = "true";
process.env.TWILIO_AUTH_TOKEN = TOKEN_A;
process.env.TWILIO_AUTH_TOKEN_ALT = TOKEN_B;
process.env.BASE_URL = BASE;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: () => false,
  lookupBusinessByPhone: async () => null,
  loadConfig: () => null,
}));

const PATH = "/twilio/voicemail?to=%2B441372656055";
const OTHER_PATH = "/twilio/voicemail?to=%2B15550001111";
const PARAMS = {
  CallSid: "CA00000000000000000000000000000001",
  AccountSid: "AC00000000000000000000000000000001",
  RecordingUrl: "https://api.twilio.com/recordings/RE1",
};
// Signs the FULL URL (base + path + query), exactly as Twilio does.
const sign = (token, path, params = PARAMS) => twilio.getExpectedTwilioSignature(token, BASE + path, params);

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

describe("POST /twilio/voicemail signature (both accounts, full URL incl. ?to=)", () => {
  // Positive case FIRST: proves the validator lets a genuine callback through.
  it("ACCEPTS a callback signed with account B's token", async () => {
    const res = await request(app).post(PATH).type("form").set("X-Twilio-Signature", sign(TOKEN_B, PATH)).send(PARAMS);
    expect(res.status).toBe(200);
  });

  it("ACCEPTS a callback signed with account A's token", async () => {
    const res = await request(app).post(PATH).type("form").set("X-Twilio-Signature", sign(TOKEN_A, PATH)).send(PARAMS);
    expect(res.status).toBe(200);
  });

  it("REFUSES the same signature sent to a different ?to= (the query is signed)", async () => {
    const res = await request(app).post(OTHER_PATH).type("form").set("X-Twilio-Signature", sign(TOKEN_B, PATH)).send(PARAMS);
    expect(res.status).toBe(403);
  });

  it("REFUSES a callback with no signature", async () => {
    const res = await request(app).post(PATH).type("form").send(PARAMS);
    expect(res.status).toBe(403);
  });
});

describe("POST /twilio/message-done sits behind the validator", () => {
  const MD = "/twilio/message-done";
  it("ACCEPTS a signature from account B", async () => {
    const res = await request(app).post(MD).type("form").set("X-Twilio-Signature", sign(TOKEN_B, MD)).send(PARAMS);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Hangup/>");
  });
  it("REFUSES unsigned", async () => {
    expect((await request(app).post(MD).type("form").send(PARAMS)).status).toBe(403);
  });
  it("REFUSES a wrong signature", async () => {
    const res = await request(app).post(MD).type("form").set("X-Twilio-Signature", sign("some_other_token", MD)).send(PARAMS);
    expect(res.status).toBe(403);
  });
});
