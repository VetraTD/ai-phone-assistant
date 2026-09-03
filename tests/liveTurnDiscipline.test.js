import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// The four disciplines getReplyStreaming has and this path did not.
//
// docs/speech-to-speech-handoff.md section 8: "Extract the reply assembly from
// getReplyStreaming rather than duplicating it, or the two drivers drift."
// That was not done -- a simpler tool loop was built instead -- so the Live
// path lacked the round cap, the text-channel recovery, the promise backstop
// and the zero-text fallback.
//
// What is NOT claimed here: that any of this fixes LVX22. Three
// book_appointment calls with DIFFERENT arguments and duplicate_suppressed 0 is
// three genuinely different bookings across turns, not unbounded rounds inside
// one. The cap is still right -- the Live tool loop really is unbounded -- but
// it is not that bug's fix.
//
// The recovery is also weaker than the cascade's by construction: the cascade
// forces a retry with toolConfig mode ANY, and a Live session fixes its tools
// at connect, so all this can do is ask.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
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
}

function fakeLive() {
  const sent = { clientContent: [], toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: (m) => sent.clientContent.push(m),
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

const CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
  businessHours: {},
};

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Digile Media" })),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

function modelAudio(ms = 500) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
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
    ws,
    live,
    execute,
    settle,
    async callTool(name, args) {
      live.push({ toolCall: { functionCalls: [{ id: `t${(toolId += 1)}`, name, args }] } });
      await settle();
    },
    speak: () => live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio() } }] } } }),
    transcribe: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
  };
}

/** Notes the guards sent. clientContent[0] is the greeting kick. */
const notes = (live) => live.sent.clientContent.slice(1).map((m) => m.turns[0].parts[0].text);

describe("tool round cap", () => {
  beforeEach(() => clearStats());

  it("stops executing after the fifth round in one turn", async () => {
    const s = await boot();
    for (let i = 0; i < 6; i++) await s.callTool("record_customer_request", { note: `n${i}` });

    expect(s.execute).toHaveBeenCalledTimes(5);
    expect(getLatencyStats().turnTaking.live_tool_rounds_capped).toBe(1);
  });

  it("still answers the call it refused to run, so the line does not go quiet", async () => {
    const s = await boot();
    for (let i = 0; i < 6; i++) await s.callTool("record_customer_request", { note: `n${i}` });

    // A Live session left holding an unanswered tool call does not error --
    // it waits, and the caller hears silence.
    expect(s.live.sent.toolResponses).toHaveLength(6);
  });

  it("resets the count when the turn ends", async () => {
    const s = await boot();
    for (let i = 0; i < 6; i++) await s.callTool("record_customer_request", { note: `n${i}` });
    s.endTurn();
    await s.settle();
    await s.callTool("record_customer_request", { note: "after" });

    expect(s.execute).toHaveBeenCalledTimes(6);
  });

  it("takes its cap from the injected env", async () => {
    const s = await boot({ LIVE_MAX_TOOL_ROUNDS: "2" });
    for (let i = 0; i < 4; i++) await s.callTool("record_customer_request", { note: `n${i}` });

    expect(s.execute).toHaveBeenCalledTimes(2);
  });
});

describe("promise backstop", () => {
  beforeEach(() => clearStats());

  it("asks for the action when the turn promised one and called nothing", async () => {
    const s = await boot();
    s.speak();
    s.transcribe("One moment, let me check that for you.");
    s.endTurn();
    await s.settle();

    expect(getLatencyStats().turnTaking.live_promise_only_turns).toBe(1);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("stays out of the way when a tool actually ran", async () => {
    const s = await boot();
    s.speak();
    s.transcribe("One moment, let me check that for you.");
    await s.callTool("record_customer_request", { note: "n" });
    s.endTurn();
    await s.settle();

    expect(getLatencyStats().turnTaking.live_promise_only_turns).toBe(0);
    expect(notes(s.live)).toHaveLength(0);
  });

  it("stays out of the way when the turn said something ordinary", async () => {
    const s = await boot();
    s.speak();
    s.transcribe("Thursday afternoon is fine. What name shall I put it under?");
    s.endTurn();
    await s.settle();

    expect(notes(s.live)).toHaveLength(0);
  });
});

describe("zero-text fallback", () => {
  beforeEach(() => clearStats());

  it("asks the model to speak when a tool ran and nothing was said", async () => {
    const s = await boot();
    await s.callTool("record_customer_request", { note: "n" });
    s.endTurn();
    await s.settle();

    expect(getLatencyStats().turnTaking.live_zero_text_turns).toBe(1);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("does nothing on a turn that both ran a tool and spoke", async () => {
    const s = await boot();
    s.speak();
    s.transcribe("That is booked for Thursday at two.");
    await s.callTool("record_customer_request", { note: "n" });
    s.endTurn();
    await s.settle();

    expect(notes(s.live)).toHaveLength(0);
  });
});

describe("one note per turn, across every mechanism", () => {
  beforeEach(() => clearStats());

  it("does not add a promise note to a turn that already got a leak note", async () => {
    const s = await boot();
    s.speak();
    s.transcribe("One moment, let me check cancel_appointment_db for you.");
    s.endTurn();
    await s.settle();

    expect(getLatencyStats().turnTaking.live_outbound_leaks).toBe(1);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("names the tool the model described but never called", async () => {
    const s = await boot();
    s.speak();
    s.transcribe("I will now call cancel_appointment_db for you.");
    await s.settle();

    expect(notes(s.live)[0]).toContain("cancel_appointment_db");
  });

  it("does not ask for a tool the model actually called", async () => {
    const s = await boot();
    await s.callTool("record_customer_request", { note: "n" });
    s.speak();
    s.transcribe("I have recorded that with record_customer_request.");
    await s.settle();

    expect(notes(s.live)[0] || "").not.toContain("has not actually been called");
  });
});
