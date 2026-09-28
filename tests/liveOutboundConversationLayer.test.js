// tests/liveOutboundConversationLayer.test.js
/**
 * S3-1 (spec §19, S3-D1): the outbound conversation layer, proved through a
 * real Live session on fakes (tests/helpers/liveBoot.js) -- the same harness
 * tests/outboundSignoffGate.test.js and tests/liveOutboundStart.test.js use.
 *
 * Two things this file proves that services/tools.js's own unit tests
 * (tests/tools.test.js) cannot: the spelling nudge (D5), which lives entirely
 * in lib/voice/live/index.js's auditTurn(), and the per-assistant-turn
 * detector wiring (detectOutboundTurn), which only exists at the turnComplete
 * handler in the same file. The LVX132 ask-gate itself is proved at
 * services/tools.js (the controller ruling: the gate lives there, not here) --
 * this file's own inbound end_call test is the control that the wiring above
 * it did not change.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const logged = vi.hoisted(() => []);
vi.mock("../lib/logger.js", async (importOriginal) => {
  const rec = (level) => (event, fields = {}) => {
    logged.push({ level, event, ...fields });
  };
  return { ...(await importOriginal()), log: { debug: rec("DEBUG"), info: rec("INFO"), error: rec("ERROR") } };
});

import { bootLive, fakeDb, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const BIZ = "biz-s3-1";
const SID = "CAs3-1-conv-layer-01";
const CALLER_ID = "+441372656055"; // the campaign's own number
const CONTACT = "+15559876543"; // the person

const CONFIG = {
  businessId: BIZ,
  businessName: "Riverside Family Clinic",
  mainPhone: CALLER_ID,
  timezone: "Europe/London",
  businessHours: {},
  locale: null,
  liveVoice: null,
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};

const TOPIC = "your recent enquiry";

const CAMPAIGN_CONFIG = {
  persona_name: "Ava",
  caller_id: CALLER_ID,
  capabilities: ["messages"],
  topic: TOPIC,
  objective: "Follow up on the enquiry.",
};

const BUSINESS_ROW = { id: BIZ, name: "Riverside Family Clinic", timezone: "Europe/London", phone_number: CALLER_ID };

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

// CHANGED (final wave W1, A16): the call is now taken PAST THE FIRST SECONDS
// before any test here speaks. In clip mode Live never speaks first: until
// the backstop decision, any Live output is discarded, and since A16 its
// transcript is marked unheard as well (it used to slip through whenever it
// arrived before an audio chunk). Every test below was letting the assistant
// talk before anything had been decided -- a shape a real call cannot have --
// so the detectors and the nudge under test were judging text the caller
// could never hear. 1,400 ms of silence fires the no-clip silence backstop
// (this file's opener renders no clip), after which the assistant is heard.
async function bootOutbound() {
  const call = await bootLive({
    config: CONFIG,
    callSid: SID,
    customParameters: { direction: "outbound" },
    authorizedCallSid: SID,
    database: outboundDb(),
  });
  await call.feed(1400);
  return call;
}

function bootInbound() {
  return bootLive({ config: CONFIG, callSid: "CA_inbound_s3_1" });
}

beforeEach(() => {
  clearStats();
  logged.length = 0;
});

describe("S3-1 D5 — the spelling nudge is inbound-only", () => {
  it("inbound: still nudges once the caller gives a name (control -- byte-identical behaviour)", async () => {
    const call = await bootInbound();
    await call.callerSays("My name is Nathan Dodla");
    await call.assistantTurn("Thanks, let me help with that.");

    expect(counters().live_spelling_ask_nudged).toBe(1);
  });

  it("outbound: never nudges on the SAME name-giving shape", async () => {
    const call = await bootOutbound();
    await call.callTool("confirm_identity", { name_confirmed: true });
    await call.callerSays("My name is Nathan Dodla");
    await call.assistantTurn("Thanks, let me help with that.");

    expect(counters().live_spelling_ask_nudged ?? 0).toBe(0);
  });
});

describe("S3-1 — per-assistant-turn detector wiring (detectOutboundTurn)", () => {
  it("outbound: askedContactNumber fires + logs callSid and step", async () => {
    const call = await bootOutbound();
    await call.callTool("confirm_identity", { name_confirmed: true });
    await call.assistantTurn("What's the best number to reach you on?");

    expect(counters().outbound_asked_contact_number).toBe(1);
    const line = logged.find((l) => l.event === "outbound_asked_contact_number");
    expect(line).toBeTruthy();
    expect(line.callSid).toBe(SID);
    expect(line.step).toBeTruthy();
  });

  it("outbound: inboundClosing fires on the inbound ask-gate phrasing", async () => {
    const call = await bootOutbound();
    await call.callTool("confirm_identity", { name_confirmed: true });
    await call.assistantTurn("Is there anything else I can help you with today?");

    expect(counters().outbound_inbound_closing_phrase).toBe(1);
    const line = logged.find((l) => l.event === "outbound_inbound_closing_phrase");
    expect(line).toBeTruthy();
    expect(line.callSid).toBe(SID);
  });

  it("outbound: topicToUnverified fires when the assistant says the topic before the party is confirmed", async () => {
    const call = await bootOutbound();
    // NO confirm_identity yet -- party starts unverified.
    await call.assistantTurn(`I'm calling about ${TOPIC}.`);

    expect(counters().outbound_topic_to_unverified).toBe(1);
    const line = logged.find((l) => l.event === "outbound_topic_to_unverified");
    expect(line).toBeTruthy();
    expect(line.callSid).toBe(SID);
  });

  it("outbound: topicToUnverified does NOT fire once the party is verified", async () => {
    const call = await bootOutbound();
    await call.callTool("confirm_identity", { name_confirmed: true });
    await call.assistantTurn(`I'm calling about ${TOPIC}.`);

    expect(counters().outbound_topic_to_unverified ?? 0).toBe(0);
  });

  it("inbound: the detector never runs, even on the identical phrasing", async () => {
    const call = await bootInbound();
    await call.assistantTurn("What's the best number to reach you on? Is there anything else I can help you with?");

    expect(counters().outbound_asked_contact_number ?? 0).toBe(0);
    expect(counters().outbound_inbound_closing_phrase ?? 0).toBe(0);
    expect(counters().outbound_topic_to_unverified ?? 0).toBe(0);
  });
});
