import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import * as callState from "../lib/callState.js";

// The owner's email is sent from Twilio's status callback, through the REAL
// server.js. The flush itself is mocked: lib/ownerNotices.js has its own suite,
// and what is unproven here is the WIRE (when the handler calls it, and with
// which business and call).

process.env.TWILIO_VALIDATE_SIGNATURE = "false";

const mockFlush = vi.fn(async () => ({ sent: 1, failed: 0, off: 0 }));
const mockLookup = vi.fn(async () => ({ id: "biz-from-to", phone_number: "+15550001111" }));

vi.mock("../lib/ownerNotices.js", () => ({
  flushOwnerNotices: (...a) => mockFlush(...a),
}));

vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: () => true,
  withTenantSafe: async (_b, fn) => fn(),
  endPendingDial: async () => 1,
  completeCall: async () => {},
  aiSecondsToday: async () => ({ before: 0, after: 0 }),
  lookupBusinessByPhone: (...a) => mockLookup(...a),
  fetchCallTranscript: async () => [],
  updateCallSummary: async () => {},
  updateCallLatency: async () => {},
  inboundGuardFacts: async () => ({ blocked: false, bounced: false, callsToday: 0 }),
  loadConfig: () => null,
}));

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

beforeEach(() => {
  mockFlush.mockReset().mockResolvedValue({ sent: 1, failed: 0, off: 0 });
  mockLookup.mockReset().mockResolvedValue({ id: "biz-from-to", phone_number: "+15550001111" });
});

const post = (over = {}) =>
  request(app)
    .post("/twilio/status")
    .type("form")
    .send({ CallSid: "CA_notice_1", CallStatus: "completed", To: "+15550001111", From: "+15559990000", ...over });

describe("POST /twilio/status owner notices", () => {
  it("completed flushes for the business found from To (the Live case: shared store empty)", async () => {
    const res = await post({ CallSid: "CA_notice_live" });
    expect(res.status).toBe(200);
    expect(mockLookup).toHaveBeenCalledWith("+15550001111");
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockFlush.mock.calls[0][0]).toMatchObject({ businessId: "biz-from-to", callSid: "CA_notice_live" });
  });

  it("completed with the business in the shared store flushes for it without a lookup", async () => {
    callState.writeShared("CA_notice_shared", { businessId: "biz-shared" });
    const res = await post({ CallSid: "CA_notice_shared" });
    expect(res.status).toBe(200);
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockFlush.mock.calls[0][0]).toMatchObject({ businessId: "biz-shared", callSid: "CA_notice_shared" });
    expect(mockLookup).not.toHaveBeenCalledWith("+15550001111");
  });

  it.each(["busy", "failed", "no-answer"])("%s does not flush", async (status) => {
    const res = await post({ CallSid: `CA_notice_${status}`, CallStatus: status });
    expect(res.status).toBe(200);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("an unknown To answers 200 without flushing", async () => {
    mockLookup.mockResolvedValue(null);
    const res = await post({ CallSid: "CA_notice_unknown" });
    expect(res.status).toBe(200);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("a throwing lookup answers 200 without flushing", async () => {
    mockLookup.mockRejectedValue(new Error("db down"));
    const res = await post({ CallSid: "CA_notice_lookup" });
    expect(res.status).toBe(200);
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("a throwing flush still answers 200", async () => {
    mockFlush.mockRejectedValue(new Error("boom"));
    const res = await post({ CallSid: "CA_notice_throw" });
    expect(res.status).toBe(200);
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });
});
