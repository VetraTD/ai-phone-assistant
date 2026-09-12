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
    stateEffects: {
      toolResult: { name: fc.name, success: true, message: "ok" },
      // end_call ARMS THE EXIT, and it does so through stateEffects rather than
      // through the tool name -- services/tools.js returns `endCallArgs: fc.args
      // ?? {}` on the success branch, and lib/voice/live/tools.js only sets it
      // when the key is present. A fake that returns a bare success for end_call
      // leaves endCallArmed false, so the session never looks like it is signing
      // off. Modelled here because the sign-off suppressor reads that flag, and a
      // mock missing a side effect makes the test fail for a reason that has
      // nothing to do with the code under test.
      ...(fc.name === "end_call" ? { endCallArgs: fc.args ?? {} } : {}),
    },
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

  it("NOW SPEAKS — a read cannot license a write's claim (LVX127)", async () => {
    // This assertion used to be `.not.toContain(...)`, deliberately: the wider
    // condition was split off as a MEASUREMENT so the number could be corrected
    // without altering what any caller hears. The number has now been read.
    //
    // CA41622e81, 2026-09-12: three completions claimed on a call that wrote
    // nothing (booked_rows 0, changed_rows 0), and the guard said nothing on
    // two of them because a read had run. LVX93's deferral condition -- "the
    // shared note budget might silence it anyway" -- was measured on that same
    // call: MAX_NOTES_PER_CALL is 8, the call spent 3, and both false claims
    // fell on turns where noteSentThisTurn was clear.
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
    // The narrow counter still measures the OLD condition, so its series stays
    // comparable with every call taken before this change and the DIFFERENCE
    // between the two counters is still exactly LVX93's population.
    expect(claims()).toBe(0);
    // Not "some note at all" -- the offer guard legitimately fires on a
    // sentence naming a time nothing verified, and that is a different guard
    // doing its own job. What must be PRESENT is the CLAIM note.
    const sent = JSON.stringify(notes(s.live));
    expect(sent).toContain("no tool has run to make it so");
  });

  it("set_call_intent is bookkeeping and cannot vouch for a cancellation", async () => {
    // CA41622e81, 17:50:44, and the sharper of that call's two cases.
    // cancel_appointment_db was REFUSED; set_call_intent succeeded on the same
    // turn; the net tool count stayed above zero, so the guard read the turn as
    // backed. set_call_intent cannot change anything at all -- it is pure
    // bookkeeping, and it vouched for a cancellation that never happened.
    const s = await boot();
    await s.callTool("set_call_intent");
    s.endTurn();
    await s.settle();

    s.say("I've gone ahead and cancelled your strategy call.");
    s.endTurn();
    await s.settle();

    expect(unbacked()).toBe(1);
    expect(JSON.stringify(notes(s.live))).toContain("no tool has run to make it so");
  });

  it("an interrupted turn does not carry its action count into the next one", async () => {
    // applyTurn clears actionToolCallsThisTurn; the interruption path did not,
    // and an interrupted turn never reaches applyTurn. So the action count
    // survived into the next turn and actionToolsRanThisTurn() read high.
    //
    // Harmless while that condition was only a counter. Now that the claim
    // guard ACTS on it, it is the guard going quiet on barged turns
    // specifically -- which is a large share of real calls.
    const s = await boot();
    await s.callTool("record_customer_request");
    // The vendor decided the caller interrupted. applyTurn never runs for this
    // turn, so nothing else clears the accumulators.
    s.live.push({ serverContent: { interrupted: true } });
    await s.settle();

    s.say("I've booked your appointment for Monday.");
    s.endTurn();
    await s.settle();

    expect(unbacked()).toBe(1);
    expect(JSON.stringify(notes(s.live))).toContain("no tool has run to make it so");
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
// THE SIGN-OFF RESTATEMENT, and it is a regression this guard caused.
//
// CAbef3df47, production, 2026-09-12 22:42:37. The assistant booked an
// appointment for real at 22:42:06, confirmed it, and then said goodbye with
// "We have Nithin Dodla booked for a strategy call on Monday, September 14th at
// 1 00 PM Central Time." Every word of that was TRUE -- postcall_verify returned
// ok with booked_rows 1, and the judge recorded claims 2, claims_tool_backed 2.
//
// The guard fired anyway and told the model to retract it. The look-back is one
// turn deep, the write was two turns back, and the only tool on the sign-off
// turn was end_call -- which is not an action tool.
//
// live_claim_without_action stayed 0 on that call, so the OLD any-tool condition
// would have been silent: it counted end_call and was right by accident. Moving
// the note to the action-only condition is what exposed this.
//
// MEASURED EXPOSURE: 9 of 64 production calls end on a claim-shaped turn --
// "Perfect. Your appointment is rescheduled for September sixteenth at four PM",
// "All done, your consultation is booked". One call in seven.
//
// The rule: at the exit, a restatement is not a new claim, PROVIDED this call
// actually completed an action. One of those nine is CA41622e81 itself, whose
// sign-off "I've gone ahead and cancelled your strategy call" was a genuine lie
// -- and on that call every write was refused, so nothing ever completed. That
// is the case the second half of the condition keeps catching.
// ---------------------------------------------------------------------------
describe("a restatement at sign-off is not a new claim", () => {
  beforeEach(() => clearStats());

  it("stays silent when the call actually completed an action", async () => {
    const s = await boot();

    // The write lands, and is confirmed on its own turn -- backed, no note.
    await s.callTool("record_customer_request");
    s.say("I've booked your appointment for Monday at one PM.");
    s.endTurn();
    await s.settle();

    // A turn in between, so the one-turn look-back can no longer see the write.
    s.say("Is there anything else I can help you with?");
    s.endTurn();
    await s.settle();

    // The goodbye RESTATES it, in the shape CAbef3df47 used. end_call is the
    // only tool on this turn, and end_call is not an action tool.
    await s.callTool("end_call");
    s.say("So I have you booked for Monday at one PM. Thanks for calling, have a great day.");
    s.endTurn();
    await s.settle();

    expect(JSON.stringify(notes(s.live))).not.toContain("no tool has run to make it so");
    // The suppression has to be COUNTABLE. A guard that quietly declines to
    // speak reads identically to one that never ran -- the trap recover_declined
    // was added to close -- so the wider condition still counts and the
    // suppression counts beside it. The difference between the two is what the
    // model was actually told about.
    expect(unbacked()).toBe(1);
    expect(getLatencyStats().turnTaking.live_claim_signoff_restatement).toBe(1);
  });

  it("STILL fires at sign-off when nothing was ever completed — CA41622e81", async () => {
    // The same shape with the second half of the condition removed by the call
    // itself: no action tool ever ran, so the restatement is a fabrication.
    const s = await boot();

    // set_call_intent SUCCEEDS here, exactly as it did on CA41622e81, and
    // end_call succeeds below. Neither is in ACTION_TOOL_NAMES, so neither
    // reaches completedToolsThisCall -- which is the whole reason the
    // suppressor cannot be talked round by bookkeeping. This is the same
    // distinction that let a set_call_intent vouch for a cancellation before
    // the guard moved to the action-only condition.
    await s.callTool("set_call_intent");
    s.say("Let me take a look at that for you.");
    s.endTurn();
    await s.settle();

    await s.callTool("end_call");
    s.say("I've gone ahead and cancelled your strategy call for Monday.");
    s.endTurn();
    await s.settle();

    expect(JSON.stringify(notes(s.live))).toContain("no tool has run to make it so");
  });

  it("still fires MID-CALL after a completed action, which is the narrower hole", async () => {
    // The suppression is scoped to the exit deliberately. A call that completes
    // one action and then fabricates a different one MID-CALL is still caught,
    // which "any completed action suppresses" would have given away.
    const s = await boot();

    await s.callTool("record_customer_request");
    s.endTurn();
    await s.settle();

    s.say("One moment.");
    s.endTurn();
    await s.settle();

    s.say("I've cancelled that appointment for you.");
    s.endTurn();
    await s.settle();

    expect(JSON.stringify(notes(s.live))).toContain("no tool has run to make it so");
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
