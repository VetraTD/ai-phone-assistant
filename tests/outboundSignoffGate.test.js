// tests/outboundSignoffGate.test.js
/**
 * Checkpoint 2b review, I2 (Controller Ruling, OVERNIGHT).
 *
 * Task 17 widened the SHARED signOffRe (lib/voice/strings.js) with an
 * outbound-only alternation -- "...for your time...bye for now/take
 * care/speak soon", and a bare end-anchored "speak soon" -- because those are
 * the phrasings D-a's outbound close and its paraphrases actually use ("...
 * you'll speak soon" is an outbound shape: WE placed the call). Appending it
 * to the shared regex also armed the INBOUND goodbye exit on those same
 * phrasings, which no inbound caller produces (tests/liveGoodbyeExit.test.js
 * proves that half is now fixed).
 *
 * The alternation itself is correct and still has to work -- it now lives at
 * OUTBOUND_STRINGS.signOffOutboundRe and is OR'd into the goodbye-exit
 * readers (lib/voice/live/index.js) only when state.outboundCall is set. This
 * file proves that OR still fires, through a real outbound Live session on
 * fakes (tests/helpers/liveBoot.js), the same harness
 * tests/liveOutboundStart.test.js and tests/outboundTransfer.test.js use.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { bootLive, fakeDb, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const BIZ = "biz-i2-outbound";
const SID = "CAi2outbound00001";
const CALLER_ID = "+441372656055"; // the campaign's own number
const CONTACT = "+15559876543"; // the person

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

const CAMPAIGN_CONFIG = {
  persona_name: "Ava",
  caller_id: CALLER_ID,
  // "messages" so completeAnAction() below has a real, cheap action tool to
  // call -- record_customer_request is CORE and needs only request_type.
  capabilities: ["messages"],
};

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

/**
 * ONE completed, caller-visible action, so the signoff-without-ask reader has
 * something to fire about. confirm_identity first: O-12 makes EVERY outbound
 * action tool refuse an unverified party regardless of configured
 * requirements, so record_customer_request would otherwise fail closed and
 * never increment completedActionCount. No caller_name in the second call --
 * deliberately, so this stays clear of the (unrelated) spelling gate.
 */
async function completeAnAction(call) {
  await call.callTool("confirm_identity", { name_confirmed: true });
  // Two consent gates in services/tools.js, unrelated to I2 but a real
  // precondition for completedActionCount to move at all: the write-order
  // gate (LVX95/LVX104) wants a read-back the caller then agrees to, or it
  // holds the write regardless of consent; the silent-turn gate (LVX117)
  // wants any non-empty caller turn immediately before the call.
  await call.assistantTurn("I'll pass that along. Shall I go ahead and confirm that?");
  await call.callerSays("Yes, please.");
  await call.callTool("record_customer_request", { request_type: "message", message: "Call me back" });
}

describe("I2 (checkpoint 2b review) — signOffOutboundRe still arms the OUTBOUND goodbye exit", () => {
  beforeEach(() => clearStats());

  it.each([
    "Thank you for your time, Priya. Speak soon!",
    "It was great chatting with you today. Speak soon.",
    "Thanks so much for your time, Priya. Take care.",
    "Thanks for your time, Priya. Bye for now.",
    "Thanks for your time. Bye for now.",
  ])("counts a farewell over a completed action with no ask behind it: %s", async (text) => {
    const call = await bootOutbound();
    await completeAnAction(call);
    await call.assistantTurn(text);

    expect(counters().live_completion_signoff_without_ask).toBe(1);
  });

  it("does not count an ordinary outbound turn", async () => {
    const call = await bootOutbound();
    await completeAnAction(call);
    await call.assistantTurn("Let me just note that down for you.");

    expect(counters().live_completion_signoff_without_ask ?? 0).toBe(0);
  });
});
