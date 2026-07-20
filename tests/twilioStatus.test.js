import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import * as callState from "../lib/callState.js";

// Twilio signature validation is orthogonal to what this file tests — see
// tests/degradedMode.test.js for the same pattern/rationale.
process.env.TWILIO_VALIDATE_SIGNATURE = "false";

const mockCompleteCall = vi.fn(async () => {});
const mockLookupBusinessByPhone = vi.fn(async () => null);
const mockFetchCallTranscript = vi.fn(async () => []);
const mockUpdateCallSummary = vi.fn(async () => {});
const mockUpdateCallLatency = vi.fn(async () => {});
const mockIsEnabled = vi.fn(() => true);

vi.mock("../services/supabase.js", () => ({
  isEnabled: (...args) => mockIsEnabled(...args),
  completeCall: (...args) => mockCompleteCall(...args),
  lookupBusinessByPhone: (...args) => mockLookupBusinessByPhone(...args),
  fetchCallTranscript: (...args) => mockFetchCallTranscript(...args),
  updateCallSummary: (...args) => mockUpdateCallSummary(...args),
  updateCallLatency: (...args) => mockUpdateCallLatency(...args),
  loadConfig: (business) =>
    business
      ? {
          businessName: business.name || "Test Biz",
          smsFollowupEnabled: business.sms_followup_enabled ?? false,
          smsTemplates: {},
        }
      : null,
}));

const mockNotifyCallMissed = vi.fn(async () => {});
const mockSendCallerSms = vi.fn(async () => {});

vi.mock("../services/notifications.js", () => ({
  notifyCallMissed: (...args) => mockNotifyCallMissed(...args),
  sendCallerSms: (...args) => mockSendCallerSms(...args),
  // Required so server.js's missed-call block doesn't short-circuit before
  // ever calling lookupBusinessByPhone/sendCallerSms (see MINOR c fix).
  HAS_SMS_CREDS: true,
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

const mockGenerateSummaryAndSentiment = vi.fn(async () => ({
  summary: "Caller asked about hours.",
  sentiment: "neutral",
  outcome: "general_inquiry",
}));

vi.mock("../services/gemini.js", () => ({
  generateSummaryAndSentiment: (...args) => mockGenerateSummaryAndSentiment(...args),
}));

const mockGetCallStats = vi.fn(() => null);

vi.mock("../lib/voice/metrics.js", () => ({
  getLatencyStats: vi.fn(() => ({ count: 0, byStage: {}, recent: [] })),
  getCallStats: (...args) => mockGetCallStats(...args),
  createTurnMetrics: vi.fn(() => ({ mark: vi.fn(), finishTurn: vi.fn() })),
}));

// server.js's cold import pulls in a large dependency graph — see
// tests/degradedMode.test.js / tests/phone-numbers-api.test.js for why this
// is hoisted to beforeAll with a generous hookTimeout instead of imported
// lazily inside each it().
let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockGetCallStats.mockReturnValue(null);
});

describe("POST /twilio/status", () => {
  describe("missed-call caller text-back", () => {
    it("texts the caller on no-answer with zero/absent duration when smsFollowupEnabled", async () => {
      mockLookupBusinessByPhone.mockResolvedValue({ id: "biz-1", name: "Test Biz", sms_followup_enabled: true });

      const res = await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_miss_1", CallStatus: "no-answer", To: "+15550001111", From: "+15559998888" });

      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(mockLookupBusinessByPhone).toHaveBeenCalledWith("+15550001111");
      expect(mockSendCallerSms).toHaveBeenCalledWith(
        expect.objectContaining({ smsFollowupEnabled: true }),
        "+15559998888",
        "missed_call",
        expect.objectContaining({ business: "Test Biz" })
      );
    });

    it("does not text when CallDuration is nonzero (not a pure miss)", async () => {
      mockLookupBusinessByPhone.mockResolvedValue({ id: "biz-1", name: "Test Biz", sms_followup_enabled: true });

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_miss_2", CallStatus: "failed", CallDuration: "12", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockSendCallerSms).not.toHaveBeenCalled();
    });

    it("does not text for a completed call", async () => {
      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_miss_3", CallStatus: "completed", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockSendCallerSms).not.toHaveBeenCalled();
    });

    it("gating: sendCallerSms itself no-ops when smsFollowupEnabled is false (delegated) — handler still calls it", async () => {
      mockLookupBusinessByPhone.mockResolvedValue({ id: "biz-1", name: "Test Biz", sms_followup_enabled: false });

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_miss_4", CallStatus: "busy", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      // The handler always calls sendCallerSms (gating lives inside it, per
      // tests/notifications.sms.test.js) — assert it was invoked with the
      // disabled config rather than asserting a specific side effect here.
      expect(mockSendCallerSms).toHaveBeenCalledWith(
        expect.objectContaining({ smsFollowupEnabled: false }),
        "+15559998888",
        "missed_call",
        expect.any(Object)
      );
    });
  });

  describe("spam-likely detection", () => {
    it("tags outcome=spam and skips Gemini when there are zero caller transcript rows and duration < 8s", async () => {
      mockFetchCallTranscript.mockResolvedValue([{ speaker: "ai", message: "Hi, thanks for calling!", sequence: 1 }]);
      // The summary/spam path only runs when this call went through the
      // pipeline far enough to get a DB call row (state.dbCallId) — set
      // directly since this test posts straight to /twilio/status.
      callState.getState("CA_spam_1").dbCallId = "call-db-1";

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_spam_1", CallStatus: "completed", CallDuration: "3", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockGenerateSummaryAndSentiment).not.toHaveBeenCalled();
      expect(mockUpdateCallSummary).toHaveBeenCalledWith(
        "CA_spam_1",
        "No caller speech (likely spam/robocall)",
        null,
        "spam"
      );
    });

    it("does NOT tag spam when sawCallerFinal is true, even if the transcript read raced ahead of the fire-and-forget insert (zero caller rows)", async () => {
      // Simulates the exact race the fix guards against: call_transcripts
      // inserts are fire-and-forget during the live call, so a legitimate
      // short call where the caller DID speak can have its status callback
      // read zero caller rows if that insert hasn't landed yet. The
      // in-memory sawCallerFinal flag (set live, well before the call
      // ends — see lib/callState.js) must override the stale DB read.
      mockFetchCallTranscript.mockResolvedValue([{ speaker: "ai", message: "Hi, thanks for calling!", sequence: 1 }]);
      const state = callState.getState("CA_spam_race");
      state.dbCallId = "call-db-race";
      state.sawCallerFinal = true;

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_spam_race", CallStatus: "completed", CallDuration: "3", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockUpdateCallSummary).not.toHaveBeenCalledWith(
        "CA_spam_race",
        "No caller speech (likely spam/robocall)",
        null,
        "spam"
      );
      // Not spam-tagged, so it correctly falls through to the normal
      // summary path — the (mocked) transcript read still has the AI's
      // greeting row, so there's something to summarize even though the
      // caller's own row hasn't landed yet.
      expect(mockGenerateSummaryAndSentiment).toHaveBeenCalled();
    });

    it("still tags spam when sawCallerFinal is false (genuine silent/robo call) and the DB read agrees (zero caller rows)", async () => {
      mockFetchCallTranscript.mockResolvedValue([{ speaker: "ai", message: "Hi, thanks for calling!", sequence: 1 }]);
      const state = callState.getState("CA_spam_genuine");
      state.dbCallId = "call-db-genuine";
      state.sawCallerFinal = false;

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_spam_genuine", CallStatus: "completed", CallDuration: "3", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockUpdateCallSummary).toHaveBeenCalledWith(
        "CA_spam_genuine",
        "No caller speech (likely spam/robocall)",
        null,
        "spam"
      );
    });

    it("still runs the normal Gemini summary path when the caller did speak", async () => {
      mockFetchCallTranscript.mockResolvedValue([
        { speaker: "ai", message: "Hi!", sequence: 1 },
        { speaker: "caller", message: "What are your hours?", sequence: 2 },
      ]);
      callState.getState("CA_spam_2").dbCallId = "call-db-2";

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_spam_2", CallStatus: "completed", CallDuration: "3", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockGenerateSummaryAndSentiment).toHaveBeenCalled();
      expect(mockUpdateCallSummary).toHaveBeenCalledWith(
        "CA_spam_2",
        "Caller asked about hours.",
        "neutral",
        "general_inquiry"
      );
    });

    it("does not tag spam when duration is >= 8s even with zero caller turns", async () => {
      mockFetchCallTranscript.mockResolvedValue([{ speaker: "ai", message: "Hi, thanks for calling!", sequence: 1 }]);
      callState.getState("CA_spam_3").dbCallId = "call-db-3";

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_spam_3", CallStatus: "completed", CallDuration: "30", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockUpdateCallSummary).not.toHaveBeenCalledWith(
        "CA_spam_3",
        "No caller speech (likely spam/robocall)",
        null,
        "spam"
      );
    });
  });

  describe("latency rollup", () => {
    it("writes avg/p95 turn latency for a completed call when stats are available", async () => {
      mockGetCallStats.mockReturnValue({ avgMs: 450, p95Ms: 900, count: 4 });

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_lat_1", CallStatus: "completed", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockGetCallStats).toHaveBeenCalledWith("CA_lat_1");
      expect(mockUpdateCallLatency).toHaveBeenCalledWith("CA_lat_1", 450, 900);
    });

    it("skips the write when no stats are available for the call", async () => {
      mockGetCallStats.mockReturnValue(null);

      await request(app)
        .post("/twilio/status")
        .type("form")
        .send({ CallSid: "CA_lat_2", CallStatus: "completed", To: "+15550001111", From: "+15559998888" });

      await new Promise((r) => setImmediate(r));
      expect(mockUpdateCallLatency).not.toHaveBeenCalled();
    });
  });
});
