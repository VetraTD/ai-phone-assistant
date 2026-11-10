// tests/outboundPostCallParty.test.js
/**
 * Fix round 1, I3 (D-c, post-call). lib/voice/live/index.js's teardown reads
 * state.callerNumber -- the CONTACT's phone on outbound -- and hands it to
 * verifyCall (which can text `appointment_request_pending` to it in "act"
 * mode) and recoverOwedBooking (which can WRITE a booking keyed to it),
 * unconditionally. Neither had a party check: an outbound call that ended
 * with the party never confirmed could still text the dialled number or book
 * an appointment for whoever picked up.
 *
 * Fixed: at call end, on outbound, when the party is not verified,
 * callerNumber is nulled before it reaches verify, and recover is skipped
 * outright (nulling callerNumber alone is not enough -- recoverOwedBooking
 * writes a booking with clientPhone: null regardless of whether a number was
 * given; only the NAME lookup inside it is gated on the number).
 *
 * Driven through the REAL session finish path (the `stop` event), per the
 * coordinator's instruction, with `verify`/`recover` injected the same way
 * tests/livePostCall.test.js already does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { clearStats } from "../lib/voice/metrics.js";

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
const BIZ = "biz-postcall-party";
const OUT_SID = "CAoutPostcallParty01";
const ATTEMPT_ID = "att-postcall-party-1";

const CONFIG = {
  businessName: "Riverside Family Clinic",
  timezone: "America/Chicago",
  allowedTasks: ["general_question", "book_appointment", "check_appointment"],
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
    listAppointmentsByCallId: vi.fn(async () => []),
    fetchCallTranscript: vi.fn(async () => []),
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
    // Task 20: the outbound finish() hook's own half of post-call.
    finishAttemptSession: async () => {},
    // I6 (fix wave, checkpoint 2b): the session's own answered stamp.
    stampAttemptAnswered: async () => {},
  };
}

/** Handles confirm_identity for real; everything else a generic success. */
function makeExecute() {
  return vi.fn(async (fc) => {
    if (fc.name === "confirm_identity") {
      const nameConfirmed = fc.args?.name_confirmed === true;
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: { partyVerified: nameConfirmed, toolResult: { name: fc.name, success: true, message: "ok" } },
      };
    }
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
    };
  });
}

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  const verify = vi.fn(async () => ({ verdict: "ok" }));
  const recover = vi.fn(async () => ({ ran: false, booked: false }));
  const judge = vi.fn(async () => ({ ran: true, agreedAction: "none" }));

  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    // OUTBOUND_FIRST_SPEAKER=live (2026-09-30, D-R2-3): under the default
    // "clip" mode nothing has been heard yet right after boot, so a
    // confirm_identity there is now REFUSED as coming from an unheard
    // generation (tests/liveOutboundStart.test.js "D-R2-3" owns that). This
    // file tests post-call's party gating, so it starts from a call where a
    // confirmation can legitimately land at once.
    env: { TWILIO_VALIDATE_SIGNATURE: "false", POSTCALL_VERIFY: "count", OUTBOUND_FIRST_SPEAKER: "live" },
    execute: makeExecute(),
    verify,
    recover,
    judge,
    // Task 20: never the REAL, wired-up singleton.
    postCall: { tryClaim: async () => false, tryClaimByAttempt: async () => false },
  });
  ws.deliver({
    event: "start",
    start: { callSid: OUT_SID, streamSid: "MZ1", customParameters: { direction: "outbound" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  return {
    live,
    verify,
    recover,
    settle,
    async callTool(name, args = {}) {
      live.push({ toolCall: { functionCalls: [{ id: `t-${name}-${Math.random()}`, name, args }] } });
      await settle();
    },
    async hangUp() {
      ws.deliver({ event: "stop" });
      await settle();
      await settle();
    },
  };
}

const arg = (fn) => fn.mock.calls[0][0];

beforeEach(() => clearStats());

describe("I3 (fix round 1): post-call read, party-gated on outbound", () => {
  it("unverified at call end: verify gets callerNumber: null, and recover is never called", async () => {
    const s = await boot();
    // No confirm_identity call at all: the party ends the call unverified.
    await s.hangUp();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(arg(s.verify).callerNumber).toBeNull();
    expect(s.recover).not.toHaveBeenCalled();
  });

  it("verified at call end (confirm_identity ran): verify gets the contact's number, and recover runs", async () => {
    const s = await boot();
    await s.callTool("confirm_identity", { name_confirmed: true });
    await s.hangUp();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(arg(s.verify).callerNumber).toBe(CONTACT_PHONE);
    expect(s.recover).toHaveBeenCalledTimes(1);
    expect(arg(s.recover).callerNumber).toBe(CONTACT_PHONE);
  });

  it("confirmed then revoked before the call ends: still treated as unverified at teardown", async () => {
    const s = await boot();
    await s.callTool("confirm_identity", { name_confirmed: true });
    await s.callTool("confirm_identity", { name_confirmed: false });
    await s.hangUp();

    expect(arg(s.verify).callerNumber).toBeNull();
    expect(s.recover).not.toHaveBeenCalled();
  });
});

// Fix round 5: an outbound call never saves a message, so the post-call message
// net (a caller's contact read back, nothing saved) must not run there. A contact
// who says "ring my mobile" and books a callback is not a lost lead.
describe("the message net is inbound only (round 5)", () => {
  it("an outbound call that reads a number back hands verify callerContactReadBack: false", async () => {
    const s = await boot();
    await s.callTool("confirm_identity", { name_confirmed: true });
    s.live.push({ serverContent: { outputTranscription: { text: "Got it, I'll ring you on 0 7 7 0 0, 9 0 0 1 2 3." } } });
    s.live.push({ serverContent: { turnComplete: true } });
    await s.settle();
    await s.hangUp();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(arg(s.verify).callerContactReadBack).toBe(false);
  });
});
