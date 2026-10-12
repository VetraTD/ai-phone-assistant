import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";

// Inbound guards through the REAL server.js, /twilio/live-voice (batch 3 S4,
// Task 4.2). Signed requests, as in tests/liveUnroutedVoicemail.test.js. The
// cascade route lives in tests/inboundGuardRoutesCascade.test.js because it
// needs signature validation switched off at module load.

const ALT_TOKEN = "alt_account_auth_token_for_the_second_twilio_account";
const BASE = "https://test.example.com";

process.env.TWILIO_VALIDATE_SIGNATURE = "true";
process.env.TWILIO_AUTH_TOKEN_ALT = ALT_TOKEN;
process.env.TWILIO_AUTH_TOKEN = "";
process.env.MEDIA_STREAM_SECRET = "test-media-stream-secret-0123456789abcdef";
process.env.CALLER_ALLOWLIST = "";
process.env.LIVE_BUSINESS_PHONE = "";
process.env.BASE_URL = BASE;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

const mockLookup = vi.fn();
const mockFacts = vi.fn();

vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: () => true,
  lookupBusinessByPhone: (...a) => mockLookup(...a),
  inboundGuardFacts: (...a) => mockFacts(...a),
  loadConfig: () => null,
  completeCall: async () => {},
  fetchCallTranscript: async () => [],
  updateCallSummary: async () => {},
  updateCallLatency: async () => {},
  startCall: async () => {},
  createCall: vi.fn(async () => "never"),
}));

function sig(url, params) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return crypto.createHmac("sha1", ALT_TOKEN).update(Buffer.from(payload, "utf-8")).digest("base64");
}

function capture(...events) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") {
      for (const l of chunk.split("\n")) {
        if (events.some((e) => l.includes(`"event":"${e}"`))) lines.push(JSON.parse(l));
      }
    }
    return true;
  });
  return { of: (e) => lines.filter((l) => l.event === e), restore: () => spy.mockRestore() };
}

const P = { CallSid: "CA00000000000000000000000000000002", From: "+15559990000", To: "+18176011171" };

async function post(app) {
  const path = "/twilio/live-voice";
  return request(app).post(path).type("form").set("X-Twilio-Signature", sig(BASE + path, P)).send(P);
}

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

beforeEach(() => {
  mockLookup.mockReset().mockResolvedValue({ id: "biz-1", name: "Biz", phone_number: "+18176011171" });
  mockFacts.mockReset().mockResolvedValue({ blocked: false, bounced: false, callsToday: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("/twilio/live-voice inbound guards", () => {
  it("a forward-all bounce is refused as busy, and no stream is started", async () => {
    mockFacts.mockResolvedValue({ blocked: false, bounced: true, callsToday: 0 });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Reject reason="busy"/>');
    expect(res.text).not.toContain("live-stream");
    expect(res.text).not.toContain("media-stream");
    expect(mockFacts).toHaveBeenCalledWith({ businessId: "biz-1", from: P.From, countCalls: true });
  });

  it("a blocked caller is rejected, and no stream is started", async () => {
    mockFacts.mockResolvedValue({ blocked: true, bounced: false, callsToday: 0 });
    const res = await post(app);
    expect(res.text).toContain('<Reject reason="rejected"/>');
    expect(res.text).not.toContain("live-stream");
  });

  it("a throwing lookup answers on LIVE (not the cascade fallback) and logs inbound_guard_failed", async () => {
    mockFacts.mockRejectedValue(new Error("db down"));
    const cap = capture("inbound_guard_failed", "live_connect_fallback_cascade");
    const res = await post(app);
    cap.restore();
    expect(res.text).toContain("/twilio/live-stream");
    expect(res.text).not.toContain("media-stream");
    expect(cap.of("inbound_guard_failed")).toHaveLength(1);
    expect(cap.of("live_connect_fallback_cascade")).toHaveLength(0);
  });

  it("no facts (database not configured) answers on live", async () => {
    mockFacts.mockResolvedValue(null);
    const res = await post(app);
    expect(res.text).toContain("/twilio/live-stream");
  });

  it("a clean caller streams as before", async () => {
    const res = await post(app);
    expect(res.text).toContain("/twilio/live-stream");
  });

  it("a failed business lookup never asks the guard, and the call streams", async () => {
    mockLookup.mockRejectedValue(new Error("lookup down"));
    const res = await post(app);
    expect(mockFacts).not.toHaveBeenCalled();
    expect(res.text).toContain("/twilio/live-stream");
  });
});
