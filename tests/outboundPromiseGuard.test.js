// tests/outboundPromiseGuard.test.js
/**
 * Checkpoint 2b review, b25. The promise-without-tool guard
 * (lib/voice/live/index.js, the "promise backstop" tests/liveTurnDiscipline.
 * test.js already covers for inbound) reads `!realToolCallsThisTurn` --
 * which counts confirm_identity as a real tool call, exactly like any
 * caller-visible write. On outbound, a turn whose ONLY tool call was
 * confirm_identity carries no action a caller can perceive: the engine tool
 * flips a verification flag and says nothing to them. If that same turn ends
 * in a bare promise ("One moment, I'll get that sorted."), the caller is
 * left with an unfulfilled promise and the guard that exists to catch
 * exactly that shape stayed quiet because it saw ONE tool call.
 *
 * No `execute` override: the REAL confirm_identity engine path runs
 * (services/tools.js), so this is not the stubbed-execute trap this
 * codebase has already written down twice.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { bootLive, fakeDb, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const BIZ = "biz-b25-outbound";
const SID = "CAb25outbound0001";
const CALLER_ID = "+441372656055";
const CONTACT = "+15559876543";

const CONFIG = {
  businessId: BIZ,
  businessName: "Digile Media",
  mainPhone: CALLER_ID,
  timezone: "Europe/London",
  businessHours: {},
  locale: null,
  liveVoice: null,
  allowedTasks: ["general_question"],
  capabilities: {},
};

const CAMPAIGN_CONFIG = { persona_name: "Ava", caller_id: CALLER_ID, capabilities: [] };
const BUSINESS_ROW = { id: BIZ, name: "Digile Media", timezone: "Europe/London", phone_number: CALLER_ID };

function outboundDb() {
  const base = fakeDb(CONFIG, BIZ);
  return {
    ...base,
    addTranscriptEntry: vi.fn(async () => {}),
    withTenant: vi.fn(async (_id, fn) => fn()),
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === SID
        ? { businessId: BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
        : null
    ),
    outboundCallContext: vi.fn(async () => ({
      attemptNo: 1,
      openerAudio: null,
      toNumber: CONTACT,
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 1,
      contactId: "contact-1",
      trigger: {},
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config: CAMPAIGN_CONFIG,
      firstName: "Priya",
      contactTimezone: "America/Chicago",
    })),
    fetchBusinessById: vi.fn(async () => BUSINESS_ROW),
    fetchBusinessCapabilities: vi.fn(async () => []),
  };
}

function bootOutbound() {
  return bootLive({
    config: CONFIG,
    callSid: SID,
    customParameters: { direction: "outbound" },
    authorizedCallSid: SID,
    database: outboundDb(),
  });
}

const PROMISE_TEXT = "One moment, I'll get that sorted for you.";

describe("b25 (checkpoint 2b review) — confirm_identity does not mute the promise-without-tool guard", () => {
  beforeEach(() => clearStats());

  it("OUTBOUND: a turn whose only tool call was confirm_identity still trips the guard on a bare promise", async () => {
    const call = await bootOutbound();
    await call.callTool("confirm_identity", { name_confirmed: true });
    await call.assistantTurn(PROMISE_TEXT);

    expect(counters().live_promise_only_turns).toBe(1);
  });

  it("OUTBOUND: a REAL action tool in the same turn as confirm_identity still counts as backing the reply -- not a blanket 'ignore confirm_identity'", async () => {
    // confirm_identity, THEN a message write in the same turn: the write is
    // the action the promise would refer to, and the guard must not fire on
    // it just because confirm_identity is also present.
    const call = await bootOutbound();
    await call.callTool("confirm_identity", { name_confirmed: true });
    // Satisfy the write-order/silent-turn gates (unrelated to b25): a
    // non-empty caller turn immediately before the write.
    await call.callerSays("Yes, please.");
    await call.callTool("record_customer_request", { request_type: "message", message: "Call me back" });
    await call.assistantTurn(PROMISE_TEXT);

    expect(counters().live_promise_only_turns ?? 0).toBe(0);
  });

  it("INBOUND is unaffected: a turn with no tool calls at all still trips the guard exactly as before (regression proof)", async () => {
    const call = await bootLive({ config: CONFIG, businessPhone: CONFIG.mainPhone });
    await call.assistantTurn(PROMISE_TEXT);

    expect(counters().live_promise_only_turns).toBe(1);
  });
});
