import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import crypto from "node:crypto";

// The /twilio/live-voice unrouted branch (live_no_business_for_number): the
// voicemail TwiML must point its action at /twilio/message-done and its
// recordingStatusCallback at /twilio/voicemail?to=<the DIALLED number>.

const ALT_TOKEN = "alt_account_auth_token_for_the_second_twilio_account";
const BASE = "https://test.example.com";

process.env.TWILIO_VALIDATE_SIGNATURE = "true";
process.env.TWILIO_AUTH_TOKEN_ALT = ALT_TOKEN;
process.env.TWILIO_AUTH_TOKEN = "";
process.env.MEDIA_STREAM_SECRET = "";
process.env.CALLER_ALLOWLIST = "";
process.env.LIVE_BUSINESS_PHONE = "";
process.env.BASE_URL = BASE;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: () => true,
  lookupBusinessByPhone: async () => null,
  loadConfig: () => null,
  completeCall: async () => {},
  fetchCallTranscript: async () => [],
  updateCallSummary: async () => {},
  updateCallLatency: async () => {},
  startCall: async () => {},
}));

function sig(url, params) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return crypto.createHmac("sha1", ALT_TOKEN).update(Buffer.from(payload, "utf-8")).digest("base64");
}

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

describe("/twilio/live-voice unrouted number", () => {
  it("files voicemail with message-done action and the dialled number on the recording callback", async () => {
    const p = { CallSid: "CA00000000000000000000000000000001", From: "+15550000000", To: "+18176011171" };
    const path = "/twilio/live-voice";
    const res = await request(app).post(path).type("form").set("X-Twilio-Signature", sig(BASE + path, p)).send(p);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
    expect(res.text).toContain(`action="${BASE}/twilio/message-done"`);
    expect(res.text).toContain("recordingStatusCallback=");
    expect(res.text).toContain(`${BASE}/twilio/voicemail?to=%2B18176011171`);
    expect(res.text).not.toContain("live-stream");
  });
});
