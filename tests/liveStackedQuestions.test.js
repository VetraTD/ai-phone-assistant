import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX25 -- three or four questions in one breath -- and the "anything else"
// tic, which closed nearly every turn of all nine calls in the 2026-09-04
// round and had never been counted at all.
//
// WHY THIS IS A COUNTER AND NOT PROMPT TEXT. Seven separate instructions
// already tell the model to ask one question at a time:
//
//   services/gemini.js:906        "One question at a time. Never stack questions."
//   services/gemini.js:1705       "ONE question, not two" + do not pair an open
//                                 "how can I help you?" with a specific one
//   capabilities/appointments.js  :597, :605, :628
//   capabilities/quotes.js:74
//   capabilities/messages.js:83
//
// It stacks them anyway. An eighth instruction makes the other seven weaker,
// which is this repository's standing rule about adding prompt text that
// competes with prompt text already there. And on this front-end the prompt is
// frozen at connect (LVX46), so a prompt fix is turn-0 text that cannot be
// reinforced later even in principle.
//
// Counting "?" is exact, free, and needs no phrasing list. It is also immune to
// LVX73 -- a vendor transcription fragment that was never spoken cannot
// manufacture a question mark. The tic regex is NOT immune to that, which is
// why the two are counted separately rather than as one "verbal tic" number.
//
// COUNT ONLY. No turn note is sent. Act once the counter says how often this
// fires when nothing is wrong.
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
  const sent = { clientContent: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: (m) => sent.clientContent.push(m),
    sendToolResponse: () => {},
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
  businessName: "Brightwork Family Dental",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  allowedTasks: ["general_question", "take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
};

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Brightwork Family Dental" })),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  await handleLiveSessionConnection(
    ws,
    {},
    {
      now: () => 0,
      connect: live.connect,
      database: fakeDb(),
      env: {},
      execute: vi.fn(async (fc) => ({
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      })),
    }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_q", streamSid: "MZ1", customParameters: { businessPhone: "+18176011171" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  return {
    live,
    /** One assistant turn: what it said, then the turn boundary. */
    async say(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      live.push({ serverContent: { turnComplete: true } });
      await new Promise((r) => setImmediate(r));
    },
    notes: () => live.sent.clientContent.slice(1).map((m) => m.turns[0].parts[0].text),
  };
}

const c = () => getLatencyStats().turnTaking;

describe("LVX25 — stacked questions, counted rather than instructed", () => {
  beforeEach(() => clearStats());

  it("counts a turn carrying two questions", async () => {
    const s = await boot();
    await s.say("Of course. What's your name? And what day were you hoping for?");

    expect(c().live_reply_turns_checked).toBe(1);
    expect(c().live_stacked_questions).toBe(1);
  });

  it("does not count a turn with a single question", async () => {
    const s = await boot();
    await s.say("Of course. Can I take your name?");

    // The positive twin is what makes this assertion mean something. Without
    // it, "no stacked questions" and "auditTurn never ran" are the same result.
    expect(c().live_reply_turns_checked).toBe(1);
    expect(c().live_stacked_questions).toBe(0);
  });

  it("undercounts the observed shape, and that is recorded rather than widened", async () => {
    const s = await boot();
    // The real one, verbatim from the call: three asks, ONE question mark.
    await s.say("Can I start with your name, company, and what industry you're in?");

    expect(c().live_reply_turns_checked).toBe(1);
    // Zero. A conjunction parser would catch it and would be the phrasing
    // treadmill this repository already warns about; two question marks is the
    // case a prospect most obviously hears as being interrogated, and it is
    // exact. The gap is written down so nobody reads a low number as a fix.
    expect(c().live_stacked_questions).toBe(0);
  });

  it("sends no turn note — this is count-only", async () => {
    const s = await boot();
    await s.say("What's your name? And your number? And the day?");

    expect(c().live_stacked_questions).toBe(1);
    // An eighth instruction, delivered in the one channel that costs a
    // round-trip on the happy path where reply p50 is 1.3-2.5 s.
    expect(s.notes()).toHaveLength(0);
  });
});

describe('the "anything else" tic', () => {
  beforeEach(() => clearStats());

  it("counts the closing tic", async () => {
    const s = await boot();
    await s.say("We're open until five on Thursday. Is there anything else I can help you with today?");

    expect(c().live_reply_turns_checked).toBe(1);
    expect(c().live_closing_tic).toBe(1);
  });

  it("counts it mid-turn, not only at the end", async () => {
    const s = await boot();
    // LVX35's inverted ordering arriving through the spelling gate rather than
    // through end_call: "anything else" asked BEFORE the booking was made.
    await s.say("Could you spell that for me, and is there anything else you need today?");

    expect(c().live_closing_tic).toBe(1);
  });

  it("leaves an ordinary turn alone", async () => {
    const s = await boot();
    await s.say("We're open until five on Thursday.");

    expect(c().live_reply_turns_checked).toBe(1);
    expect(c().live_closing_tic).toBe(0);
  });

  it("counts nothing at all on a turn with no assistant text", async () => {
    const s = await boot();
    await s.say("");

    expect(c().live_reply_turns_checked).toBe(0);
    expect(c().live_closing_tic).toBe(0);
    expect(c().live_stacked_questions).toBe(0);
  });
});
