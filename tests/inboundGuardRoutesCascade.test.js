import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Inbound guards through the REAL server.js, /twilio/voice (batch 3 S4, Task
// 4.2). Signature validation is switched off at module load, as in
// tests/degradedMode.test.js; the Live route is in tests/inboundGuardRoutes.test.js.
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.CALLER_ALLOWLIST = "";

const mockLookup = vi.fn();
const mockFacts = vi.fn();
const mockCreateCall = vi.fn(async () => "never");

vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: () => true,
  lookupBusinessByPhone: (...a) => mockLookup(...a),
  inboundGuardFacts: (...a) => mockFacts(...a),
  createCall: (...a) => mockCreateCall(...a),
  loadConfig: () => null,
}));

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

let app;
let n = 0;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

beforeEach(() => {
  mockLookup.mockReset().mockResolvedValue({ id: "biz-1", name: "Biz", phone_number: "+18176011171" });
  mockFacts.mockReset().mockResolvedValue({ blocked: false, bounced: false, callsToday: 0 });
  mockCreateCall.mockClear();
});
afterEach(() => vi.restoreAllMocks());

// A fresh CallSid per request: the first webhook hit for a call is the only one
// that connects the stream.
function post() {
  n += 1;
  return request(app)
    .post("/twilio/voice")
    .type("form")
    .send({ CallSid: `CAcascadeguard${String(n).padStart(8, "0")}`, From: "+15559990000", To: "+18176011171" });
}

describe("/twilio/voice inbound guards", () => {
  it("a forward-all bounce is refused as busy, with no stream and no call row", async () => {
    mockFacts.mockResolvedValue({ blocked: false, bounced: true, callsToday: 0 });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Reject reason="busy"/>');
    expect(res.text).not.toContain("media-stream");
    expect(mockCreateCall).not.toHaveBeenCalled();
    expect(mockFacts).toHaveBeenCalledWith({ businessId: "biz-1", from: "+15559990000", countCalls: true });
  });

  it("a blocked caller is rejected, with no stream and no call row", async () => {
    mockFacts.mockResolvedValue({ blocked: true, bounced: false, callsToday: 0 });
    const res = await post();
    expect(res.text).toContain('<Reject reason="rejected"/>');
    expect(res.text).not.toContain("media-stream");
    expect(mockCreateCall).not.toHaveBeenCalled();
  });

  it("a throwing lookup answers the call and logs inbound_guard_failed", async () => {
    mockFacts.mockRejectedValue(new Error("db down"));
    const cap = capture("inbound_guard_failed");
    const res = await post();
    cap.restore();
    expect(res.text).toContain("/twilio/media-stream");
    expect(cap.of("inbound_guard_failed")).toHaveLength(1);
  });

  it("no facts (database not configured) answers the call", async () => {
    mockFacts.mockResolvedValue(null);
    const res = await post();
    expect(res.text).toContain("/twilio/media-stream");
  });

  it("a clean caller streams as before", async () => {
    const res = await post();
    expect(res.text).toContain("/twilio/media-stream");
  });

  it("a failed business lookup never asks the guard, and the call streams", async () => {
    mockLookup.mockRejectedValue(new Error("lookup down"));
    const res = await post();
    expect(mockFacts).not.toHaveBeenCalled();
    expect(res.text).toContain("/twilio/media-stream");
  });
});
