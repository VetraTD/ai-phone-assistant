import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX34. A refused write answered with "someone will call you back".
//
// From a real call. book_appointment was refused by the spelling gate, whose
// message says in words: "ask the caller to spell it, and read the letters
// back... Ask them now and wait for their answer." The model instead told the
// caller someone would ring them back, twice, and only asked for the spelling
// once the caller pushed.
//
// Two separate reasons nothing caught it, and neither is the one first written
// down:
//
//   1. promiseRe is "I am about to do something" -- one moment, let me check.
//      "Someone will call you back" is a different speech act and does not
//      match it in any phrasing. There was no pattern for it at all.
//   2. The promise guard is gated on !realToolCallsThisTurn, and that count
//      includes ATTEMPTS. A refused call still increments it, so the guard was
//      switched off by the very thing it should have fired on.
//
// The near miss is worse than what was heard: spellMissCap is 2, so a less
// persistent caller runs the gate out of refusals and is written to the
// database exactly as they were misheard.
// ---------------------------------------------------------------------------

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
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Brightwork Family Dental" })),
    loadConfig: () => ({
      businessName: "Brightwork Family Dental",
      timezone: "America/Chicago",
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

/**
 * @param {"allow"|"refuse"} verdict - what the tool layer does with a write
 */
async function boot(verdict = "refuse") {
  const ws = new FakeSocket();
  const live = fakeLive();
  // The shape services/tools.js returns when the spelling gate holds a write
  // back: success:false on both halves, with the instruction as the message.
  const execute = vi.fn(async (fc) =>
    verdict === "refuse"
      ? {
          functionResponse: {
            id: fc.id,
            name: fc.name,
            response: { success: false, message: "[not caller speech] Before recording it, get the spelling." },
          },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message: "get the spelling" },
            toolCallEvent: { name: fc.name, args: fc.args, silent: true },
          },
        }
      : {
          functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
          stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
        }
  );

  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    env: {},
    execute,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+18176011171" } },
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
    hear: (text) => live.push({ serverContent: { inputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    // `args` is spread over the default so every existing caller keeps the
    // exact payload it had; only a test that asks for arguments gets them.
    async callTool(name = "book_appointment", args = {}) {
      live.push({
        toolCall: { functionCalls: [{ id: `d${(toolId += 1)}`, name, args: { n: toolId, ...args } }] },
      });
      await settle();
    },
  };
}

const stat = (name) => getLatencyStats().turnTaking[name];
// clientContent[0] is the greeting kick; anything after it is a turn note.
const notes = (live) => live.sent.clientContent.slice(1);

describe("a refused write answered with a callback promise", () => {
  beforeEach(() => clearStats());

  it("is counted when the TOOL LAYER refuses, and the model is pointed back at it", async () => {
    // The spelling gate's shape: services/tools.js hands back success:false
    // with an instruction, and the write never runs.
    const s = await boot("refuse");
    await s.callTool("record_customer_request");
    s.say("Thanks. Someone will call you back within the next business day to confirm that.");
    s.endTurn();
    await s.settle();

    expect(stat("live_tool_refusals")).toBe(1);
    expect(stat("live_deferral_after_refusal")).toBe(1);
    expect(JSON.stringify(notes(s.live))).toContain("refused this turn");
  });

  it("is counted when the LIVE GUARD refuses, which never reaches the tool layer", async () => {
    // book_appointment with no verified slot is stopped by the availability
    // invariant in guards.js, which returns a functionResponse and no
    // toolResult at all. Counting only what the tool layer sees would miss it.
    const s = await boot("allow");
    await s.callTool("book_appointment");
    s.say("Someone will get back to you about that.");
    s.endTurn();
    await s.settle();

    expect(stat("live_guard_availability_blocked")).toBe(1);
    expect(stat("live_tool_refusals")).toBe(1);
    expect(stat("live_deferral_after_refusal")).toBe(1);
  });

  it("says nothing when the same words follow a write that SUCCEEDED", async () => {
    // A receptionist offering a callback after doing the thing is not a defect.
    // The pairing is the whole signal.
    const s = await boot("allow");
    await s.callTool("record_customer_request");
    s.say("That is noted. Someone will call you back tomorrow to confirm.");
    s.endTurn();
    await s.settle();

    expect(stat("live_tool_refusals")).toBe(0);
    expect(stat("live_deferral_after_refusal")).toBe(0);
  });

  it("says nothing when a refusal is answered by asking, which is the wanted behaviour", async () => {
    const s = await boot("refuse");
    await s.callTool("record_customer_request");
    s.say("Could you spell your last name for me?");
    s.endTurn();
    await s.settle();

    expect(stat("live_tool_refusals")).toBe(1);
    expect(stat("live_deferral_after_refusal")).toBe(0);
  });

  it("does not fire for a refused LOOKUP, only for a write the caller asked for", async () => {
    // get_caller_appointments_from_db is not an action tool. A failed lookup
    // leaves nothing outstanding, so offering a callback after one is a
    // judgement call rather than a defect.
    const s = await boot("refuse");
    await s.callTool("get_caller_appointments_from_db");
    s.say("Someone will call you back later today.");
    s.endTurn();
    await s.settle();

    expect(stat("live_tool_refusals")).toBe(0);
    expect(stat("live_deferral_after_refusal")).toBe(0);
  });

  it("a claim after a REFUSED call is counted — LVX31, seen on a real call", async () => {
    // The guard used to ask "did the model call anything", when the question it
    // needed answered was "did anything actually happen". A refused call answers
    // yes to the first and no to the second, so a refusal switched the guard
    // off -- and on the deployed build the spelling gate refused a write, the
    // assistant claimed something was done, and the post-call read found no row
    // while this counter read 0.
    const s = await boot("refuse");
    await s.callTool("record_customer_request");
    s.say("All set — I've noted that down for you.");
    s.endTurn();
    await s.settle();

    expect(stat("live_claim_without_action")).toBe(1);
  });

  it("a claim after a call that SUCCEEDED is still none of the guard's business", async () => {
    const s = await boot("allow");
    await s.callTool("record_customer_request");
    s.say("All set — I've noted that down for you.");
    s.endTurn();
    await s.settle();

    expect(stat("live_claim_without_action")).toBe(0);
  });

  it("a refused turn does not grant the NEXT turn's claim immunity", async () => {
    // The second half of the same fix. Leaving toolRanPrevTurn on attempts
    // would be a new blind spot in the shape of the one being closed.
    const s = await boot("refuse");
    await s.callTool("record_customer_request");
    s.say("One moment.");
    s.endTurn();
    await s.settle();

    s.say("That's booked for you.");
    s.endTurn();
    await s.settle();

    expect(stat("live_claim_without_action")).toBe(1);
  });

  it("nudges for the spelling in the turn the caller gives their name", async () => {
    // LVX-owner-2026-09-03. The prompt already says to ask right then, and on a
    // real call the model collected everything, said "that's all confirmed,
    // anything else?", heard "no", and only THEN asked. A prompt line is a
    // request; this is the counted nudge at the moment the name arrives.
    const s = await boot("allow");
    s.hear("Hi, it's Jane Fitzgerald.");
    s.say("Lovely, thanks. What day suits you?");
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(1);
    // "spell their FULL name" as of 2026-09-05. The note used to say "spell it
    // NOW", and on a real call the model read "it" as the first name only: the
    // caller spelled "N-I-T-H-I-N", the surname went into the row exactly as the
    // vendor had misheard it, and the gate was satisfied because SOME letters had
    // arrived. The gate cannot tell which part of a name was spelled, and
    // assembling the letters to find out is what LVX62 rules out.
    expect(JSON.stringify(notes(s.live))).toContain("spell their FULL name");
  });

  it("does NOT force a second spoken turn to deliver that nudge", async () => {
    // 2026-09-05, and the loudest complaint of the session. This note fires
    // because the model has JUST SAID a name, so it has always already spoken
    // this turn. Sent with turnComplete:true it made the model speak AGAIN with
    // nothing new to say, and what came out was the previous turn reworded:
    //
    //   18:26:27  "Thanks, Nitin Dadlani. And what's the best number...?"  + NOTE
    //   18:26:35  "Thanks, Nitin Dadlani. Can you spell your full name...?
    //              And what's the best number to reach you on?"
    //   18:26:40  the caller's first word of the entire exchange
    //
    // Three assistant turns, sixteen seconds, no caller speech between any of
    // them. The debug log calls that three turns; the caller hears one stream
    // repeating itself, and reported it as the worst thing about the call.
    const s = await boot("allow");
    s.hear("Hi, it's Jane Fitzgerald.");
    s.say("Lovely, thanks. What day suits you?");
    s.endTurn();
    await s.settle();

    const frame = s.live.sent.clientContent
      .slice(1)
      .find((m) => /spell their FULL name/.test(m.turns[0].parts[0].text));
    expect(frame).toBeTruthy();
    expect(frame.turnComplete).toBe(false);
  });

  // -------------------------------------------------------------------------
  // THE THIRD TRIGGER, 2026-09-09. A tool argument is not a phrasing.
  //
  // The nudge fired on `nameGivenRe(caller) || nameReadBackRe(assistant)`, and
  // the second half watched for the assistant repeating the name back — which
  // the prompt DEMANDED until this date and no longer does, because demanding a
  // full name before the model has one is what makes it invent the missing
  // half ("Nithin Dodla" -> "Nitin Dadlani", then "Nitin Gadkari").
  //
  // Removing that instruction would otherwise have quietly halved the trigger
  // coverage, leaving `nameGivenRe` alone — which is already recorded as having
  // missed two consecutive calls, because "let's do uh Nathan Dodla" has no
  // lead-in to anchor on and widening the pattern to a bare capitalised word
  // would fire on every weekday and place name a caller mentions.
  //
  // A name in a tool argument cannot be phrased around.
  // -------------------------------------------------------------------------
  it("nudges off a name in a tool argument when neither regex can see one", async () => {
    const s = await boot("allow");
    // The exact phrasing that defeated nameGivenRe on two real calls, and an
    // assistant reply that repeats no name at all — which is now the norm.
    s.hear("let's do uh Nathan Dodla");
    s.say("What day were you thinking of?");
    await s.callTool("book_appointment", { client_name: "Nathan Dodla" });
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(1);
  });

  it("reads caller_name as well, because the write gate does", async () => {
    // Same two argument names as services/tools.js's callerNameFromArgs. A
    // nudge that watched a different set from the gate it is trying to get
    // ahead of would nudge for writes that were never going to be refused.
    const s = await boot("allow");
    s.hear("it's for a callback");
    s.say("Sure, what day suits?");
    await s.callTool("record_customer_request", { caller_name: "Nathan Dodla" });
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(1);
  });

  it("does not fire on a tool call carrying no name", async () => {
    // The control. A trigger that fired on any tool call would spend the
    // call's single nudge on an availability check.
    const s = await boot("allow");
    s.hear("do you have anything Tuesday?");
    s.say("Let me check.");
    await s.callTool("check_appointment_availability");
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(0);
  });

  it("does not fire on a blank name argument", async () => {
    // `""` and `"   "` are what an argument the model declined to fill looks
    // like, and neither is a name in play.
    const s = await boot("allow");
    s.hear("do you have anything Tuesday?");
    s.say("Let me check.");
    await s.callTool("book_appointment", { client_name: "   " });
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(0);
  });

  it("stays quiet when the assistant already asked for the spelling itself", async () => {
    const s = await boot("allow");
    s.hear("Hi, it's Jane Fitzgerald.");
    s.say("Thanks. Could you spell that for me?");
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(0);
  });

  it("does not fire on a capitalised word that is not a name", async () => {
    // "It's Tuesday" is the false positive a booking call produces constantly.
    const s = await boot("allow");
    s.hear("It's Tuesday that works best for me.");
    s.say("Tuesday it is.");
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(0);
  });

  it("spends the nudge at most once per call", async () => {
    const s = await boot("allow");
    s.hear("It's Jane Fitzgerald.");
    s.say("Lovely.");
    s.endTurn();
    await s.settle();

    s.hear("Sorry, my name is Jane Fitzgerald.");
    s.say("Got it.");
    s.endTurn();
    await s.settle();

    expect(stat("live_spelling_ask_nudged")).toBe(1);
  });

  it("the count does not survive the turn it belongs to", async () => {
    // Otherwise a refusal on turn 2 would condemn a perfectly good callback
    // offer on turn 9.
    const s = await boot("refuse");
    await s.callTool("record_customer_request");
    s.say("Could you spell that for me?");
    s.endTurn();
    await s.settle();

    s.say("Of course - someone will call you back about the other thing.");
    s.endTurn();
    await s.settle();

    expect(stat("live_deferral_after_refusal")).toBe(0);
  });
});
