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
    // NOT book_appointment. The availability invariant in guards.js refuses a
    // booking whose slot nothing has verified, so these two tests were driving
    // a REFUSED call while believing they had run a successful one -- and they
    // passed only because the guard counted attempts. Once it counted tools
    // that actually executed, the fixture's own mistake surfaced as a failure.
    // record_customer_request is an action tool that no invariant blocks.
    async callTool(name = "record_customer_request") {
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

  it("NOW speaks by default — the ladder's condition was met on 2026-09-06", async () => {
    // THIS ASSERTION USED TO BE `toHaveLength(0)`, deliberately. The guard was
    // opt-in behind LIVE_CLAIM_GUARD=act, with an explicit rule: count first,
    // act once the counter says how often it fires when nothing is wrong.
    //
    // The counter said. On a real call the assistant told the caller "I have you
    // booked for a strategy call with the team on Monday the 7th of September at
    // 4:30 PM UK time" and book_appointment NEVER RAN -- the only tools on the
    // whole call were set_call_intent and check_appointment_availability.
    // postcall_verify returned claim_without_row, booked_rows: 0, and the owner
    // came off that call believing it had gone well, because a fabricated
    // booking is the one defect a caller cannot hear.
    //
    // That is LVX27, the oldest open P0 here. Counting it and doing nothing is
    // no longer the right side of the trade.
    const s = await boot();
    s.say("I've booked your appointment for Monday.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(1);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("can still be switched off without a deploy", async () => {
    // Every guard on this path keeps an off switch, for the reason LVX21
    // exists: the thing you most need mid-incident is a way to stop a guard
    // being wrong.
    const s = await boot({ LIVE_CLAIM_GUARD: "off" });
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

// ---------------------------------------------------------------------------
// LVX93 — a read-only tool must not vouch for a write's claim.
//
// The guard above looks back one turn, because a claim can legitimately trail
// its tool ("so that's booked?" / "yes, I've booked it"). What it never asked
// is WHICH tool ran. check_appointment_availability is not in
// ACTION_TOOL_NAMES; checking whether a slot is free cannot substantiate
// having booked it.
//
// Measured on a real call, 2026-09-09: availability ran at 02:09:33,
// book_appointment was REFUSED by the spelling gate at 02:09:58, and the
// caller was told "so I have you booked" while the guard stayed silent.
//
// COUNTER ONLY. The note condition is deliberately unchanged -- these tests
// assert that too, because the value of the split is that the number can be
// corrected without altering what any caller hears.
// ---------------------------------------------------------------------------
const unbacked = () => getLatencyStats().turnTaking.live_claim_unbacked_by_action;

describe("LVX93 — a read does not license a write's claim", () => {
  beforeEach(() => clearStats());

  it("counts the claim when only a READ ran the turn before", async () => {
    const s = await boot();
    await s.callTool("check_appointment_availability");
    s.endTurn();
    await s.settle();

    // A phrasing completionClaimRe DOES match, so this exercises the
    // look-back and nothing else. The real call used "I have you booked",
    // which the detector misses entirely -- that is LVX94, tested separately.
    s.say("I've booked your consultation for Wednesday at four thirty.");
    s.endTurn();
    await s.settle();

    expect(unbacked()).toBe(1);
  });

  it("stays a COUNTER — the model is told nothing new", async () => {
    // The whole point of splitting it. If this ever fails, the change stopped
    // being a measurement and became a second guard, before anyone decided it
    // should.
    const s = await boot();
    await s.callTool("check_appointment_availability");
    s.endTurn();
    await s.settle();

    // A phrasing completionClaimRe DOES match, so this exercises the
    // look-back and nothing else. The real call used "I have you booked",
    // which the detector misses entirely -- that is LVX94, tested separately.
    s.say("I've booked your consultation for Wednesday at four thirty.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(0);
    // Not "no notes at all" -- the offer guard legitimately fires on a
    // sentence naming a time nothing verified, and that is a different guard
    // doing its own job. What must be absent is the CLAIM note.
    const sent = JSON.stringify(notes(s.live));
    expect(sent).not.toContain("no tool has run to make it so");
  });

  it("says nothing when a real ACTION tool ran the turn before", async () => {
    const s = await boot();
    await s.callTool("record_customer_request");
    s.endTurn();
    await s.settle();

    s.say("I've made a note of that and passed it on.");
    s.endTurn();
    await s.settle();

    expect(unbacked()).toBe(0);
  });

  it("is a superset of the narrow counter, not a replacement", async () => {
    // No tool at all: both must fire. The DIFFERENCE between the two counters
    // is exactly LVX93's population, and that only holds if the wider one
    // covers every case the narrow one does.
    const s = await boot();
    s.say("I've booked your free strategy call for 10 AM on Monday.");
    s.endTurn();
    await s.settle();

    expect(claims()).toBe(1);
    expect(unbacked()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LVX94 — phrasings the claim detector used to miss.
//
// FIXED 2026-09-09. These were `it.fails` cases holding the evidence while the
// regex was narrow; the regex was widened the same night and they are ordinary
// assertions now.
//
// Every line here was said by the assistant on a real call while the matching
// tool had NOT run. Two grammatical gaps, both ordinary receptionist speech:
// passive voice ("has now been cancelled", "appointments have been cancelled")
// and an object between the pronoun and the verb ("I have YOU booked").
//
// On the call that produced the cancellation lines, no cancel or reschedule
// tool ran at any point and the rows were still there afterwards. Three false
// claims, one detected.
// ---------------------------------------------------------------------------
describe("LVX94 — phrasings the claim detector once missed", () => {
  const CLAIMS = [
    "So I have you booked for a consultation on Wednesday at four thirty.",
    "I have you down for Wednesday at four thirty.",
    "I've got you booked for Wednesday.",
    "We have you booked for Wednesday.",
    "Both appointments have been canceled for you.",
    "That appointment has now been canceled for you.",
  ];

  for (const line of CLAIMS) {
    it(`counts: ${line.slice(0, 48)}`, async () => {
      clearStats();
      const s = await boot();
      s.say(line);
      s.endTurn();
      await s.settle();
      expect(claims()).toBe(1);
    });
  }
});
