// tests/outboundPartyEffectsWire.test.js
/**
 * Fix round 1, I4. The party -> engine.call wire (lib/voice/live/index.js's
 * dispatchEffects, `call: { ..., party: runner ? runner.party : null }`) is
 * what lets a DEFERRED capability effect (messages, quotes, appointments,
 * sms_consent) see the SAME verification state the tool layer saw. It was
 * untested: deleting it would silently fall back to partyOf's INBOUND
 * default (verified: true, using engine.call.callerNumber -- the CONTACT's
 * own phone on outbound) -- exactly the shape an unverified outbound party
 * must never get.
 *
 * Driven through the REAL session (handleLiveSessionConnection), not a
 * hand-built engine.call: confirm_identity runs for real (the actual
 * services/tools.js case, so runner.party is the actual thing being wired),
 * and effect DISPATCH is the real dispatchCapabilityEffects and the real
 * capabilities/messages.js / capabilities/quotes.js onEffect. Only the
 * ACTION TOOL's own execute() is stubbed, to isolate this test from O-12 (the
 * new implicit phone_on_file gate, which would otherwise refuse the write
 * itself before any effect existed to dispatch -- O-12 is covered separately
 * in tests/outboundParty.test.js, and so is O-13's stamping). The stub
 * deliberately does NOT stamp the effect's own `party` (O-13's mechanism), so
 * what these tests see is purely what the WIRE supplies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  notifyCustomerRequest: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import * as notifications from "../services/notifications.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function fakeLive() {
  const sent = { toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: () => {},
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (m) => onmessage?.(m),
  };
}

const CONTACT_PHONE = "+15559876543";
const BIZ = "biz-wire-effects";
const OUT_SID = "CAoutWireEffects0001";
const ATTEMPT_ID = "att-wire-effects-1";

const CONFIG = {
  businessName: "Riverside Family Clinic",
  timezone: "America/Chicago",
  allowedTasks: ["general_question"],
  capabilities: {},
  businessHours: {},
};

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: BIZ, name: CONFIG.businessName }),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    withTenant: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    // b2 (checkpoint 2b fix wave): teardown flushes the transcript on every
    // stop, this session included -- an unstubbed method threw and printed
    // live_transcript_write_failed on every test in this file.
    addTranscriptEntry: async () => {},
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    outboundAttemptByCallSid: async (sid) =>
      sid === OUT_SID
        ? { businessId: BIZ, attemptId: ATTEMPT_ID, outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
        : null,
    outboundCallContext: async () => ({
      attemptNo: 1,
      openerAudio: null,
      toNumber: CONTACT_PHONE,
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 1,
      contactId: "contact-1",
      trigger: {},
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config: { persona_name: "Ava", caller_id: "+441372656055", capabilities: ["appointments", "transfer"] },
      firstName: "Priya",
      contactTimezone: "America/Chicago",
    }),
    fetchBusinessById: async () => ({ id: BIZ, name: CONFIG.businessName, timezone: CONFIG.timezone }),
    fetchBusinessCapabilities: async () => [],
    // Round A1 S3: what a same-call correction is matched against. Nothing filed yet.
    listCallCustomerRequests: vi.fn(async () => []),
    updateCustomerRequest: vi.fn(async () => null),
    createCustomerRequest: vi.fn(async () => "req-1"),
    // Task 20: the outbound finish() hook's own half of post-call.
    finishAttemptSession: async () => {},
    // I6 (fix wave, checkpoint 2b): the session's own answered stamp.
    stampAttemptAnswered: async () => {},
  };
}

/**
 * Stubbed `execute`: real confirm_identity semantics (so runner.party is the
 * real thing under test), canned effects for the two tools under test, a
 * generic success for anything else. Bypasses services/tools.js entirely --
 * deliberately, see the file header.
 */
function makeExecute() {
  return vi.fn(async (fc) => {
    if (fc.name === "confirm_identity") {
      const nameConfirmed = fc.args?.name_confirmed === true;
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: { partyVerified: nameConfirmed, toolResult: { name: fc.name, success: true, message: "ok" } },
      };
    }
    if (fc.name === "record_customer_request") {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          toolResult: { name: fc.name, success: true, message: "ok" },
          capabilityEffects: [
            {
              capability: "messages",
              type: "recorded",
              data: { request_type: "message", caller_name: "Priya", callback_number: null, message: "call me back" },
            },
          ],
        },
      };
    }
    if (fc.name === "request_quote") {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          toolResult: { name: fc.name, success: true, message: "ok" },
          capabilityEffects: [
            { capability: "quotes", type: "requested", data: { service_description: "a quote", caller_name: "Priya" } },
          ],
        },
      };
    }
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
    };
  });
}

async function boot({ execute = makeExecute() } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: fakeDb(),
    env: { TWILIO_VALIDATE_SIGNATURE: "false" },
    execute,
    // Task 20: never the REAL, wired-up singleton.
    postCall: { tryClaim: async () => false, tryClaimByAttempt: async () => false },
  });
  ws.deliver({
    event: "start",
    start: { callSid: OUT_SID, streamSid: "MZ1", customParameters: { direction: "outbound" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  // CHANGED (final wave W1, A16/A19): the call is taken PAST THE FIRST
  // SECONDS before any test here acts. In clip mode Live never speaks first:
  // until the backstop decision, Live's output is discarded, its transcript
  // is unheard (A16), and a caller-visible action tool from it is refused
  // (A19). 1,400 ms of Twilio silence frames fires the no-clip silence
  // backstop (this file's opener renders no clip); from then on the model's
  // turns are heard, which is what these wire tests are about.
  const SILENCE = Buffer.alloc(160, 0xff).toString("base64");
  for (let i = 0; i < 70; i++) {
    clock += 20;
    ws.deliver({ event: "media", media: { payload: SILENCE } });
  }
  await new Promise((r) => setImmediate(r));

  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  return {
    ws,
    live,
    settle,
    async callTool(name, args = {}) {
      live.push({ toolCall: { functionCalls: [{ id: `t-${name}-${Math.random()}`, name, args }] } });
      await settle();
    },
    // applyTurn() (lib/voice/live/index.js) early-returns, and never calls
    // dispatchEffects, when the turn carried no text at all
    // (`if (!replyText && !userText) return;`) -- so the model must actually
    // say something before turnComplete, exactly as tests/livePostCall.test.js's
    // own `book()` + `say()` pair does.
    say(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
    },
    async endTurn() {
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("I4 (fix round 1): the party -> engine.call wire, through a real outbound session", () => {
  it("messages: unverified -- no confirmation SMS is sent", async () => {
    const s = await boot();
    await s.callTool("record_customer_request", { request_type: "message", message: "call me back" });
    s.say("I'll make sure they get your message.");
    await s.endTurn();
    await s.settle();
    expect(notifications.sendCallerSms).not.toHaveBeenCalled();
  });

  it("messages: verified (confirm_identity ran first) -- SMS goes to the contact's number", async () => {
    const s = await boot();
    await s.callTool("confirm_identity", { name_confirmed: true });
    await s.callTool("record_customer_request", { request_type: "message", message: "call me back" });
    s.say("I'll make sure they get your message.");
    await s.endTurn();
    await vi.waitFor(() => expect(notifications.sendCallerSms).toHaveBeenCalled());
    expect(notifications.sendCallerSms.mock.calls[0][1]).toBe(CONTACT_PHONE);
  });

  it("quotes: unverified -- no SMS", async () => {
    const s = await boot();
    await s.callTool("request_quote", { service_description: "a quote" });
    s.say("I'll get that over to the team.");
    await s.endTurn();
    await s.settle();
    expect(notifications.sendCallerSms).not.toHaveBeenCalled();
  });

  it("quotes: verified -- SMS goes to the contact's number", async () => {
    const s = await boot();
    await s.callTool("confirm_identity", { name_confirmed: true });
    await s.callTool("request_quote", { service_description: "a quote" });
    s.say("I'll get that over to the team.");
    await s.endTurn();
    await vi.waitFor(() => expect(notifications.sendCallerSms).toHaveBeenCalled());
    expect(notifications.sendCallerSms.mock.calls[0][1]).toBe(CONTACT_PHONE);
  });
});
