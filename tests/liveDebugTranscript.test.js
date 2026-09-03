import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));

import { log } from "../lib/logger.js";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// A diagnostic that records what the ASSISTANT said, and nothing the caller
// said. Off unless asked for, refused where it must never run.
//
// Why it exists: the LVX23 bisect turned on a question the owner had to notice
// while also driving the call -- whether the assistant asks one thing at a time
// or four -- and the honest answer that came back was "I don't remember". No
// number of extra calls fixes an instrument that depends on recall.
//
// Why it is guarded rather than simply added: backlog LVX21 flagged capturing
// this as needing a deliberate, time-boxed decision, and LVX24 is the fresh
// scar -- two sanitizers logging 200 characters of assistant speech, which
// carries the caller's name and number, past a lint that works on field names.
// This is that same category of data, so it is opt-in, refused in hipaa mode,
// and announced when it is on.
//
// The caller's own words are NOT captured. inputAudioTranscription is right
// there and is deliberately left alone: the question being answered is about
// what the assistant asks, and the narrower capture is the one to build.
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
  let onmessage = null;
  return {
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: () => {},
          sendToolResponse: () => {},
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

async function boot(env = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    env,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  return {
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    hear: (text) => live.push({ serverContent: { inputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
  };
}

const debugCalls = () => log.info.mock.calls.filter((c) => c[0] === "live_debug_assistant_turn");

describe("the assistant-turn diagnostic", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records nothing unless it is asked for", async () => {
    const s = await boot();
    s.say("And could I take your name?");
    s.endTurn();

    expect(debugCalls()).toHaveLength(0);
  });

  it("records what the assistant said when it is switched on", async () => {
    const s = await boot({ LIVE_DEBUG_TRANSCRIPT: "1" });
    s.say("And could I take your name, your company, and a preferred time?");
    s.endTurn();

    expect(debugCalls()).toHaveLength(1);
    expect(debugCalls()[0][1].text).toContain("your company");
  });

  it("records one entry per turn, not one per fragment", async () => {
    const s = await boot({ LIVE_DEBUG_TRANSCRIPT: "1" });
    s.say("And could I take ");
    s.say("your name?");
    s.endTurn();

    expect(debugCalls()).toHaveLength(1);
    expect(debugCalls()[0][1].text).toBe("And could I take your name?");
  });

  it("records the caller's own words too, on the same entry", async () => {
    // REVERSED DELIBERATELY. This used to assert the caller was never
    // recorded, and that restraint is what made LVX36 unresolvable: the
    // assistant offered three slots and booked a fourth, and there is no
    // record anywhere of which one the caller asked for. On a front-end whose
    // open P0 is saying things nobody asked for, one-sided evidence is not
    // evidence. Same flag, same hipaa refusal, same debug_only marking.
    const s = await boot({ LIVE_DEBUG_TRANSCRIPT: "1" });
    s.hear("My mobile is 07700 900123.");
    s.say("Thank you.");
    s.endTurn();

    expect(debugCalls()).toHaveLength(1);
    expect(debugCalls()[0][1].user_text).toContain("900123");
    expect(debugCalls()[0][1].text).toBe("Thank you.");
  });

  it("still records nothing at all when the flag is off", async () => {
    const s = await boot({});
    s.hear("My mobile is 07700 900123.");
    s.say("Thank you.");
    s.endTurn();

    expect(debugCalls()).toHaveLength(0);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("900123");
  });

  it("refuses the caller's half in hipaa mode along with everything else", async () => {
    const s = await boot({ LIVE_DEBUG_TRANSCRIPT: "1", DEPLOYMENT_MODE: "hipaa" });
    s.hear("My mobile is 07700 900123.");
    s.say("Thank you.");
    s.endTurn();

    expect(JSON.stringify(log.info.mock.calls)).not.toContain("900123");
  });

  it("refuses in hipaa mode, and says so", async () => {
    const s = await boot({ LIVE_DEBUG_TRANSCRIPT: "1", DEPLOYMENT_MODE: "hipaa" });
    s.say("And could I take your name?");
    s.endTurn();

    expect(debugCalls()).toHaveLength(0);
    expect(log.error.mock.calls.some((c) => c[0] === "live_debug_transcript_refused")).toBe(true);
  });
});
