import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX27's detector: the assistant told the caller something was done, and
// nothing was done.
//
// Observed on a real call, on the production configuration, with all ten tools
// declared and working one call earlier:
//
//   "We also have appointments available at nine AM, nine thirty AM, ten AM..."
//   "Thanks, N A T H A N D O D L A -- I've booked your free strategy call
//    for 10 AM on Monday, September 7th."
//
// The call's log has no tool events of any kind and the database has no such
// row. The availability was invented and the booking never happened. A caller
// would arrive to nothing.
//
// ---------------------------------------------------------------------------
// Why this DETECTS and does not CORRECT
// ---------------------------------------------------------------------------
//
// The obvious move is to tell the model it lied and ask it to fix it. That is
// how you get a double booking. A claim can legitimately arrive a turn after
// the tool that backs it -- "so it's booked?" / "yes, I've booked it" -- and a
// guard that reacts to that by demanding action gets a second, different
// booking, which is LVX22 with extra steps.
//
// So the first version counts. The note is behind a flag, off by default, and
// stays off until the counter has said how often this fires on calls where
// nothing is wrong. Measure, then act.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
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
  const sent = { clientContent: [], toolResponses: [] };
  let onmessage = null;
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: (m) => sent.clientContent.push(m),
          sendToolResponse: (m) => sent.toolResponses.push(m),
          close: () => {},
        },
        languagePinned: true,
        surface: "aistudio",
        model: "m",
      };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Digile Media" })),
    loadConfig: () => ({
      businessName: "Digile Media",
      timezone: "Europe/London",
      allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
      capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
      businessHours: {},
    }),
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

let toolId = 0;

async function boot(env = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const execute = vi.fn(async (fc) => ({
    functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
    stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
  }));
  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    env,
    execute,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    live,
    settle,
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    async callTool(name = "book_appointment") {
      live.push({ toolCall: { functionCalls: [{ id: `t${(toolId += 1)}`, name, args: { n: toolId } }] } });
      await settle();
    },
  };
}

const claims = () => getLatencyStats().turnTaking.live_claim_without_action;
const notes = (live) => live.sent.clientContent.slice(1);

describe("a claim of completion with nothing behind it", () => {
  beforeEach(() => clearStats());

  it("is counted when no tool ran at all", async () => {
    const s = await boot();
    s.say("I've booked your free strategy call for 10 AM on Monday, September 7th.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(1);
  });

  it("catches the other phrasings a receptionist actually uses", async () => {
    for (const line of [
      "That's all set for Thursday at two.",
      "Your appointment is now rescheduled for 11 30 AM on Friday.",
      "I have cancelled that appointment for you.",
      "You're booked in for Monday morning.",
      "I've made a note of that and passed it on.",
    ]) {
      clearStats();
      const s = await boot();
      s.say(line);
      s.endTurn();
      await s.settle();
      expect(claims(), line).toBe(1);
    }
  });

  it("stays silent when the tool actually ran on that turn", async () => {
    const s = await boot();
    await s.callTool();
    s.say("I've booked your appointment for Monday.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(0);
  });

  it("stays silent when the tool ran on the turn before", async () => {
    // "So that's booked?" / "Yes, I've booked it." A claim can legitimately
    // trail the tool that backs it by a turn, and treating that as a lie is
    // how a guard causes a second booking.
    const s = await boot();
    await s.callTool();
    s.say("All done.");
    s.endTurn();
    await s.settle();

    s.say("Yes, I've booked it for Monday at ten.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(0);
  });

  it("leaves a promise to the promise backstop", async () => {
    const s = await boot();
    s.say("One moment, let me check that for you.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(0);
    expect(getLatencyStats().turnTaking.live_promise_only_turns).toBe(1);
  });

  it("does not fire on an offer to act", async () => {
    for (const line of [
      "I can book that for you if you'd like.",
      "Would you like me to book that appointment?",
      "I'll get that booked for you shortly.",
    ]) {
      clearStats();
      const s = await boot();
      s.say(line);
      s.endTurn();
      await s.settle();
      expect(claims(), line).toBe(0);
    }
  });

  it("says nothing to the model by default", async () => {
    const s = await boot();
    s.say("I've booked your appointment for Monday.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(1);
    expect(notes(s.live)).toHaveLength(0);
  });

  it("can be told to speak up, once the counter has earned it", async () => {
    const s = await boot({ LIVE_CLAIM_GUARD: "act" });
    s.say("I've booked your appointment for Monday.");
    s.endTurn();
    await s.settle();

    expect(notes(s.live)).toHaveLength(1);
  });
});
