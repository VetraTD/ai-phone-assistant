import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// The other half of LVX27, and the earlier one.
//
// On the fabricated call the assistant said:
//
//   "We also have appointments available at nine AM, nine thirty AM, ten AM,
//    ten thirty AM, and eleven AM that day. Do any of those work for you?"
//
// with no tool call anywhere in the session. The claim guard cannot see that --
// it is not a claim of completion, it is an OFFER, and it happens before the
// caller has committed to anything. By the time the claim guard fires the
// caller has already chosen an invented slot.
//
// ---------------------------------------------------------------------------
// Why this does not parse times out of prose
// ---------------------------------------------------------------------------
//
// The obvious design is to pull the times out of what was said and compare
// them against the verified set. Speech renders them as "nine AM", "ten thirty
// AM", "11 30 AM", "2 P M" -- and times appear in sentences that are not
// offers at all ("we're open nine to five", "your appointment is at ten").
// A parser there is a false-positive generator.
//
// The precision comes from the tool record instead. guards.js already keeps
// `verifiedSlots`, filled ONLY from a real availability tool's response, and
// the booking invariant already gates on it. So the question becomes: did the
// assistant offer specific times when NOTHING has ever verified a slot on this
// call. That is answerable exactly, with no parsing.
//
// What it therefore does NOT catch, stated so nobody assumes otherwise: a
// wrong time quoted AFTER a real availability call. That needs the parser, and
// it is a smaller hole than the one being closed.
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
  const sent = { clientContent: [] };
  let onmessage = null;
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: (m) => sent.clientContent.push(m),
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

let toolId = 0;

async function boot(env = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const execute = vi.fn(async (fc) => ({
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response:
        fc.name === "check_appointment_availability"
          ? { open_times: ["2026-09-07T10:00:00+01:00", "2026-09-07T10:30:00+01:00"] }
          : { success: true },
    },
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
    async checkAvailability() {
      live.push({
        toolCall: {
          functionCalls: [
            { id: `t${(toolId += 1)}`, name: "check_appointment_availability", args: { requested_at: "2026-09-07T10:00:00+01:00" } },
          ],
        },
      });
      await settle();
    },
  };
}

const offers = () => getLatencyStats().turnTaking.live_offer_unverified;
const notes = (live) => live.sent.clientContent.slice(1);

describe("times offered that nothing ever verified", () => {
  beforeEach(() => clearStats());

  it("counts the exact sentence from the fabricated call", async () => {
    const s = await boot();
    s.say(
      "We also have appointments available at nine AM, nine thirty AM, ten AM, ten thirty AM, and eleven AM that day. Do any of those work for you?"
    );
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(1);
  });

  it("catches the other ways it offers a slot", async () => {
    for (const line of [
      "I have an opening this coming Monday, September 7th, at nine AM — does that work for you?",
      "We have times available at 12 AM, 11 30 AM, or 11 PM.",
      "I've got a free slot at two o'clock on Thursday.",
    ]) {
      clearStats();
      const s = await boot();
      s.say(line);
      s.endTurn();
      await s.settle();
      expect(offers(), line).toBe(1);
    }
  });

  it("stays silent once an availability call has verified something", async () => {
    const s = await boot();
    await s.checkAvailability();
    s.say("We have times available at ten AM and ten thirty AM. Do either work?");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(0);
  });

  it("does not fire on stating the opening hours", async () => {
    const s = await boot();
    s.say("Strategy calls are thirty minutes and available between nine AM and five PM UK time.");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(0);
  });

  it("does not fire on ordinary conversation", async () => {
    for (const line of [
      "Is there anything else I can help you with today?",
      "Thanks, Nathan — could you spell your surname for me?",
      "Your appointment is at ten AM on Monday.",
    ]) {
      clearStats();
      const s = await boot();
      s.say(line);
      s.endTurn();
      await s.settle();
      expect(offers(), line).toBe(0);
    }
  });

  it("NOW speaks, like its sibling — same switch, same evidence", async () => {
    // Flipped with the claim guard on 2026-09-06. An offer of times nothing
    // verified is the same defect one step earlier in the call: the caller is
    // told something that is not backed by anything, and cannot tell.
    const s = await boot();
    s.say("We have times available at nine AM or ten AM.");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(1);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("stays silent when the guard is switched off", async () => {
    const s = await boot({ LIVE_CLAIM_GUARD: "off" });
    s.say("We have times available at nine AM or ten AM.");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(1);
    expect(notes(s.live)).toHaveLength(0);
  });
});
