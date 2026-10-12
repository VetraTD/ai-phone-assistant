import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// U4 (finding B): the Live inbound transfer's REST update must use the call's
// OWN Twilio account. This file observes the real client resolution (the
// default router, and the account-A fallback) by mocking the `twilio` module,
// which tests/outboundTransfer.test.js deliberately does not do.
const mockUpdate = vi.fn(async () => ({}));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({ calls: () => ({ update: (...a) => mockUpdate(...a) }) })),
}));

import twilio from "twilio";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.authorizedCallSid = null;
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  marks() {
    return this.sent.filter((m) => m.event === "mark").map((m) => m.mark?.name);
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

const CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message", "transfer_human"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
  transferPhoneNumber: "+441111222333",
  transferPolicy: "always",
};

const fakeDb = () => ({
  isEnabled: () => true,
  lookupBusinessByPhone: async () => ({ id: "biz-1" }),
  loadConfig: () => CONFIG,
  // Pending dial (batch 3 S4): a transfer records the dial before it starts.
  recordPendingDial: async () => "1",
  withTenantSafe: async (_id, fn) => fn(),
  createCall: async () => "call-1",
  listIntegrationsForBusiness: async () => [],
  fetchBusinessKnowledge: async () => [],
  fetchCallerContext: async () => null,
  markCallTransferred: async () => {},
});

const SID_A = "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SID_B = "ACbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];

/** Boots an inbound Live call (no injected twilioClient) and drives a transfer. */
async function transferWith({ accountSid, env = {} }) {
  const live = fakeLive();
  const ws = new FakeSocket();
  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    env,
    execute: async (fc) => ({
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message: "ok" },
        transferRequested: { reason: "x" },
      },
    }),
  });
  ws.deliver({
    event: "start",
    start: {
      callSid: "CA1",
      streamSid: "MZ1",
      ...(accountSid ? { accountSid } : {}),
      customParameters: { businessPhone: "+441372656055", callerPhone: "+15559990000" },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  live.push({ toolCall: { functionCalls: [{ id: "t1", name: "request_transfer", args: {} }] } });
  await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
  live.push({ serverContent: { outputTranscription: { text: "Putting you through now." }, turnComplete: true } });
  await new Promise((r) => setImmediate(r));
  ws.deliver({ event: "mark", mark: { name: ws.marks().at(-1) } });
  await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalled());
}

describe("Live inbound transfer: which Twilio account", () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.TWILIO_ACCOUNT_SID = SID_A;
    process.env.TWILIO_AUTH_TOKEN = "tokA";
    twilio.mockClear();
    mockUpdate.mockClear();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("an unknown account SID falls back to account A, exactly as before", async () => {
    // BOTH accounts configured, so the router is live and the null comes from
    // the SID matching neither -- not from an empty router.
    await transferWith({
      accountSid: "ACzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      env: {
        TWILIO_ACCOUNT_SID: SID_A,
        TWILIO_AUTH_TOKEN: "tokA",
        TWILIO_ACCOUNT_SID_ALT: SID_B,
        TWILIO_AUTH_TOKEN_ALT: "tokB",
      },
    });
    expect(twilio).toHaveBeenCalledWith(SID_A, "tokA");
    expect(twilio).not.toHaveBeenCalledWith(SID_B, "tokB");
  });

  it("a THROWING account getter fails OPEN: the transfer still goes out on account A", async () => {
    // The matching ALT account's client constructor throws (malformed SID).
    twilio.mockImplementationOnce(() => {
      throw new Error("malformed alt sid");
    });
    await transferWith({
      accountSid: SID_B,
      env: {
        TWILIO_ACCOUNT_SID: SID_A,
        TWILIO_AUTH_TOKEN: "tokA",
        TWILIO_ACCOUNT_SID_ALT: SID_B,
        TWILIO_AUTH_TOKEN_ALT: "tokB",
      },
    });
    expect(twilio).toHaveBeenCalledWith(SID_A, "tokA");
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("no account SID on the start event falls back to account A", async () => {
    await transferWith({});
    expect(twilio).toHaveBeenCalledWith(SID_A, "tokA");
  });

  it("the default router resolves account B's SID to account B's credentials", async () => {
    await transferWith({
      accountSid: SID_B,
      env: {
        TWILIO_ACCOUNT_SID: SID_A,
        TWILIO_AUTH_TOKEN: "tokA",
        TWILIO_ACCOUNT_SID_ALT: SID_B,
        TWILIO_AUTH_TOKEN_ALT: "tokB",
      },
    });
    expect(twilio).toHaveBeenCalledWith(SID_B, "tokB");
    expect(twilio).not.toHaveBeenCalledWith(SID_A, "tokA");
  });
});
