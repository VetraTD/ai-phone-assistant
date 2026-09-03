import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// Two ways to leave a call, and both were cutting the caller off.
//
// END_CALL. finish() ran the moment `generationComplete` arrived and called
// audioOut.stop(), which empties the local pacing queue. Gemini generates
// faster than realtime, so a four-second goodbye sits almost entirely in that
// queue while only LOOKAHEAD_MS has reached Twilio — the caller heard about a
// tenth of a second of it and then a hang-up. The comment above it claimed the
// opposite ("hang up only after the goodbye has actually been spoken"), which
// is how it survived review by the person who wrote it.
//
// TRANSFER. `stateEffects.transferRequested` was returned by the tool runner
// and read by nobody, so request_transfer succeeded, the assistant said
// "putting you through now", and the caller stayed on the line with the bot.
//
// Both are the same primitive: put a mark after the audio, act when the mark
// comes back, and keep a timer in case it never does. lib/voice/audioOut.js
// already provides it (sendMark / notifyMarkPlayed), and index.js already
// handled the inbound `mark` event — it just never sent one, so that handler
// was dead code.
// ---------------------------------------------------------------------------

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
  /** Every mark name audioOut has put on the wire. */
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

function fakeDb(config = CONFIG) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: "biz-1" }),
    loadConfig: () => config,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    markCallTransferred: async () => {},
  };
}

async function boot({ live = fakeLive(), execute, config, twilioClient, exitFallbackMs } = {}) {
  const ws = new FakeSocket();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: fakeDb(config),
    env: {},
    ...(execute ? { execute } : {}),
    ...(twilioClient ? { twilioClient } : {}),
    ...(exitFallbackMs !== undefined ? { exitFallbackMs } : {}),
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  return { ws, live, advance: (ms) => (clock += ms) };
}

/** A tool that reports success and asks for whatever effect the test wants. */
const toolReturning = (stateEffects) => async (fc) => ({
  functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
  stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" }, ...stateEffects },
});

async function callTool(live, name, args = {}) {
  live.push({ toolCall: { functionCalls: [{ id: "t1", name, args }] } });
  await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
}

describe("hanging up after end_call", () => {
  it("does not close the socket the instant the model stops generating", async () => {
    const live = fakeLive();
    const { ws } = await boot({ live, execute: toolReturning({ endCallArgs: {} }) });
    await callTool(live, "end_call");

    live.push({ serverContent: { outputTranscription: { text: "Thanks for calling, goodbye." }, turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(ws.readyState).toBe(1);
  });

  it("closes once the goodbye has actually played out", async () => {
    const live = fakeLive();
    const { ws } = await boot({ live, execute: toolReturning({ endCallArgs: {} }) });
    await callTool(live, "end_call");
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    const mark = ws.marks().at(-1);
    expect(mark).toBeTruthy();
    ws.deliver({ event: "mark", mark: { name: mark } });
    await new Promise((r) => setImmediate(r));

    expect(ws.readyState).not.toBe(1);
  });

  it("closes anyway if the mark never comes back", async () => {
    // Twilio not returning a mark must not hold a line open indefinitely --
    // the caller has been said goodbye to and is listening to nothing.
    //
    // The backstop is injected rather than faked: this handler awaits real
    // promises during start, and fake timers deadlock vi.waitFor against them.
    const live = fakeLive();
    const { ws } = await boot({ live, execute: toolReturning({ endCallArgs: {} }), exitFallbackMs: 20 });
    await callTool(live, "end_call");
    live.push({ serverContent: { turnComplete: true } });

    await vi.waitFor(() => expect(ws.readyState).not.toBe(1));
  });
});

describe("transfer", () => {
  it("actually redials, instead of only saying it will", async () => {
    const updates = [];
    const twilioClient = { calls: () => ({ update: async (opts) => updates.push(opts) }) };
    const live = fakeLive();
    const { ws } = await boot({
      live,
      twilioClient,
      execute: toolReturning({ transferRequested: { reason: "billing question" } }),
    });
    await callTool(live, "request_transfer");
    live.push({ serverContent: { outputTranscription: { text: "Putting you through now." }, turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    const mark = ws.marks().at(-1);
    ws.deliver({ event: "mark", mark: { name: mark } });
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(updates[0].twiml).toContain("+441111222333");
    expect(updates[0].twiml).toContain("<Dial");
  });

  it("does not redial before the caller has heard the announcement", async () => {
    const updates = [];
    const twilioClient = { calls: () => ({ update: async (opts) => updates.push(opts) }) };
    const live = fakeLive();
    await boot({ live, twilioClient, execute: toolReturning({ transferRequested: { reason: "x" } }) });
    await callTool(live, "request_transfer");
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(updates).toHaveLength(0);
  });

  it("does not transfer a business whose policy forbids it", async () => {
    // resolveTransferAllowed gates the TOOL in services/tools.js, and the same
    // answer must gate the redial -- a config that changed mid-call, or a tool
    // response the model fabricated, must not reach Twilio.
    const updates = [];
    const twilioClient = { calls: () => ({ update: async (opts) => updates.push(opts) }) };
    const live = fakeLive();
    await boot({
      live,
      twilioClient,
      config: { ...CONFIG, transferPolicy: "never" },
      execute: toolReturning({ transferRequested: { reason: "x" } }),
    });
    await callTool(live, "request_transfer");
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(updates).toHaveLength(0);
  });
});
