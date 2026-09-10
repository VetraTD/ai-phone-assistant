// ---------------------------------------------------------------------------
// LVX78's cutter — stop the caller HEARING the model restate itself.
//
// The counter (tests/liveRepeatedPhrase.test.js) told us how often this happens.
// This is the half that acts on it, and it exists because of one specific thing
// the owner described and the log then confirmed exactly:
//
//   18:28:04  "Yes, they have availability on Monday. Would you prefer 9:00 AM,
//              1:00 PM, or 4:30 PM? There are a few other times available..."
//   18:28:16  "Sure, we have slots open at 9:00 AM, 1:00 PM, or 4:30 PM. Do any
//              of those suit you?"
//   18:28:18  <- the caller's first word since 18:27:53
//
// Twelve seconds, two "turns" in the log, and the caller had not spoken between
// them. To an ear that is one stream saying the same thing twice. Their words:
// "it says the same thing twice in a row... that is a big issue."
//
// ---------------------------------------------------------------------------
// The condition that makes this safe enough to act on
// ---------------------------------------------------------------------------
//
// NO CALLER SPEECH SINCE THE LAST ASSISTANT TURN. That is structural rather than
// linguistic, and it is what separates a defect from the most obvious false
// positive: a caller who says "sorry, could you repeat that?" SHOULD hear the
// same thing again, and in that case they have spoken, so nothing cuts.
//
// Plus a long verbatim run, plus a hard cap per call. The cap matters more than
// it looks -- LVX21 is the standing record of what a hair trigger costs here,
// and a cutter that fires on every turn would be worse than the repeat.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

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
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: () => {},
    sendToolResponse: () => {},
    close: () => {},
  };
  return {
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

const CONFIG = {
  businessName: "Digile Media",
  mainPhone: "+441372656055",
  timezone: "Europe/London",
  // A CONFIGURED greeting, so greetingTextFor() is deterministic here. Without
  // it the opening is synthesized from the time of day and these tests would
  // pass or fail depending on the hour they run at.
  greeting: "Thanks for calling Digile Media. You are through to our AI receptionist. How can I help you today?",
  _hasCustomGreeting: true,
  allowedTasks: ["general_question"],
  capabilities: {},
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

async function boot(env = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const cleared = [];
  await handleLiveSessionConnection(
    ws,
    {},
    { now: () => 0, connect: live.connect, database: fakeDb(), env, execute: vi.fn() }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_cut", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  // audioOut is built during start; wrap clear() so the test can see a cut
  // without reaching into the module.
  const realClear = ws.liveAudioOut.clear.bind(ws.liveAudioOut);
  ws.liveAudioOut.clear = (opts) => {
    cleared.push(opts || {});
    return realClear(opts);
  };

  return {
    cleared,
    /** One transcription fragment, without ending the turn. */
    fragment(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
    },
    /** End the current turn. */
    async endTurn() {
      live.push({ serverContent: { turnComplete: true } });
      await new Promise((r) => setImmediate(r));
    },
    /** One complete assistant turn. */
    async say(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      live.push({ serverContent: { turnComplete: true } });
      await new Promise((r) => setImmediate(r));
    },
    /** The caller says something, which is what makes a restatement legitimate. */
    async caller(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await new Promise((r) => setImmediate(r));
    },
  };
}

const c = () => getLatencyStats().turnTaking;

/** Push several transcription fragments of ONE turn, without ending it. */
function live_fragments(s, parts) {
  for (const p of parts) s.fragment(p);
}

const SLOTS_A =
  "Yes, they have availability on Monday. Would you prefer 9:00 AM, 1:00 PM, or 4:30 PM? There are a few other times available as well.";
const SLOTS_B = "Sure, we have slots open at 9:00 AM, 1:00 PM, or 4:30 PM. Do any of those suit you?";

describe("LVX78 — cutting a repeat the caller has not asked for", () => {
  beforeEach(() => clearStats());

  it("cuts when the model restates itself with no caller speech in between", async () => {
    const s = await boot();
    await s.say(SLOTS_A);
    await s.say(SLOTS_B);

    expect(c().live_repeat_cut).toBe(1);
    expect(s.cleared).toHaveLength(1);
    // Tapered, not the leak guard's hard stop. A leak must not be heard at all;
    // a repeat is merely unwanted, and a hard clear on ordinary speech sounds
    // like the line dropping.
    expect(s.cleared[0].fadeMs).toBeGreaterThan(0);
  });

  it("does NOT cut when the caller asked to hear it again", async () => {
    // THE FALSE POSITIVE THIS IS BUILT AROUND. "Sorry, could you repeat that?"
    // must produce a repeat, and it does -- the caller spoke, so nothing fires.
    const s = await boot();
    await s.say(SLOTS_A);
    await s.caller("sorry could you say those times again");
    await s.say(SLOTS_B);

    expect(c().live_repeat_cut).toBe(0);
    expect(s.cleared).toHaveLength(0);
  });

  it("does not cut two consecutive turns that say different things", async () => {
    const s = await boot();
    await s.say("Of course, I can help with that.");
    await s.say("What day were you thinking of?");

    expect(c().live_repeat_cut).toBe(0);
    expect(s.cleared).toHaveLength(0);
  });

  it("counts the check even when nothing is cut", async () => {
    // The positive twin. Without it, "no repeats" and "the cutter never ran"
    // read identically -- which is what LVX45 turned out to be.
    const s = await boot();
    await s.say("Of course, I can help with that.");
    await s.say("What day were you thinking of?");

    expect(c().live_repeat_cut_checked).toBeGreaterThan(0);
  });

  it("stops after the per-call cap, however often the model repeats", async () => {
    // LVX21 is the standing record of what a hair trigger costs on this path. A
    // cutter that fires on every turn is worse than the thing it fixes, so it is
    // bounded and the bound is asserted rather than assumed.
    const s = await boot();
    for (let i = 0; i < 8; i += 1) {
      await s.say(SLOTS_A);
      await s.say(SLOTS_B);
    }

    expect(c().live_repeat_cut).toBeLessThanOrEqual(3);
  });

  it("cuts a turn that repeats ITSELF, which is what the owner heard", async () => {
    // 2026-09-05, one logged turn, verbatim. Confirmation, closing question, an
    // answer to its OWN question, a goodbye -- then all of it again with a
    // different sign-off. Reported as going "on a tangent and saying four things
    // it wasn't supposed to say".
    //
    // The across-turns check could not see this: it compares against the
    // PREVIOUS completed turn, and this never ended.
    const s = await boot();
    // A real call's FIRST assistant turn is always the greeting, which is never
    // cut. Anything testing a mid-call repeat needs a turn before it.
    await s.say("Of course. What day were you thinking of?");
    await s.caller("yes Monday at nine works");
    await s.say(
      "Great, so that's Monday, September 7th at 9 AM for your strategy call. " +
        "Is there anything else I can help you with today? No? Then thanks for calling " +
        "Digile Media and have a great day. " +
        "Great, so that's Monday, September 7th at 9 AM. Is there anything else I can " +
        "help you with today? Thanks for calling Digile Media, have a great weekend."
    );

    expect(c().live_repeat_cut).toBe(1);
    expect(s.cleared).toHaveLength(1);
  });

  it("cuts a SHORT sentence said twice — the doubled goodbye", async () => {
    // 2026-09-06. The owner: "it said 'Thanks for calling Digile Media have a
    // great day' twice at the end right next to each other."
    //
    // The first within-turn check could not have caught this and never even
    // looked: it required the turn to be longer than 280 characters before
    // comparing head against tail, and a doubled goodbye is 142. Gating on
    // CHARACTERS was arbitrary; what matters is whether there are enough WORDS
    // for a repeat to be a repeat.
    const s = await boot();
    await s.say("Of course. Is there anything else?");
    await s.caller("no that's everything thanks");
    const bye = "You're very welcome. Thanks for calling Digile Media, have a great day.";
    await s.say(bye + " " + bye);

    expect(c().live_repeat_cut).toBe(1);
    expect(s.cleared).toHaveLength(1);
  });

  it("leaves a short turn that says one thing once alone", async () => {
    // The other side of dropping the length gate: short turns are now examined,
    // so a short turn is where a false positive would appear first.
    const s = await boot();
    await s.say("You're very welcome. Thanks for calling Digile Media, have a great day.");

    expect(c().live_repeat_cut).toBe(0);
    expect(s.cleared).toHaveLength(0);
  });

  it("leaves a long turn that does not repeat itself alone", async () => {
    // The within-turn check compares a turn's tail against its own head, so a
    // long turn is where a false positive would show up first.
    const s = await boot();
    await s.say(
      "Of course. We run Meta ads across Facebook and Instagram, and we also handle " +
        "Google search campaigns with SEO support alongside them. The team puts together " +
        "the strategy, writes the copy and reports on performance every month. Would a " +
        "free strategy call be useful for you?"
    );

    expect(c().live_repeat_cut).toBe(0);
    expect(s.cleared).toHaveLength(0);
  });

  it("cuts at most ONCE per turn", async () => {
    // 2026-09-06. On a real call it fired three times in 173 milliseconds on one
    // turn -- 18:37:59.808, .954 and .981 -- and the per-call cap is three. It
    // burned the entire call's budget on the first turn, leaving the rest of the
    // call with no repeat protection at all.
    //
    // Once it decides to cut, every following fragment still matches, so it
    // keeps firing. The leak guard has had leakHandledThisTurn for exactly this
    // since it was written.
    const s = await boot();
    await s.say("Of course. Is there anything else?");
    await s.caller("that's all thanks");
    const bye = "You're very welcome. Thanks for calling Digile Media, have a great day.";
    // Several fragments of one turn, each of which repeats the head.
    live_fragments(s, [bye, " " + bye, " " + bye, " " + bye]);
    await s.endTurn();

    expect(c().live_repeat_cut).toBe(1);
  });

  it("never cuts the GREETING, however much it repeats", async () => {
    // The owner heard a clipped greeting, and a clipped greeting is a worse
    // first impression than a doubled one. The cascade has protected this turn
    // since before this front-end existed: "The greeting is uninterruptible:
    // barge-in is disarmed until it finishes."
    //
    // Still COUNTED, so we learn whether the greeting really does double without
    // risking the one turn every caller hears.
    const s = await boot();
    const greeting =
      "Thanks for calling Digile Media. You're through to our AI receptionist - calls are recorded for quality. How can I help you today?";
    await s.say(greeting + " " + greeting);

    expect(s.cleared).toHaveLength(0);
    expect(c().live_repeat_cut).toBe(0);
    expect(c().live_repeat_would_cut_greeting).toBe(1);
  });

  it("can be switched off entirely", async () => {
    // Any guard that cuts a caller's audio needs an off switch that does not
    // require a deploy, for the same reason LIVE_TURN_END and LIVE_CLAIM_GUARD
    // have one.
    const s = await boot({ LIVE_REPEAT_CUT: "off" });
    await s.say(SLOTS_A);
    await s.say(SLOTS_B);

    expect(c().live_repeat_cut).toBe(0);
    expect(s.cleared).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE OPENING LINE, SPOKEN AGAIN MID-CALL. 2026-09-10.
//
// Lives here rather than in a file of its own because it is a branch of this
// cutter and shares its harness, and because the greeting VETO above is the
// thing it must not break.
//
// What a caller heard, three minutes into a call — the whole greeting, verbatim,
// spliced onto the end of an ordinary sentence with no space:
//
//   "I can help with that. What day were you thinking of?Thanks for calling
//    Brightwork Studio. You're through to our AI receptionist. How can I help
//    you today?"
//
// Nothing re-sent it. The opening line is written into the system instruction,
// the prompt is frozen at connect, and it said "Nothing has been said to the
// caller yet. Open the call by saying this..." in the present tense for the
// entire call. The model re-anchored on a standing instruction. The wording is
// now first-turn-only; this is the half that does not rely on the model
// obeying it.
//
// Neither existing branch can reach this case, which is why it is a third one:
// the caller has just spoken, so `acrossTurns` is disarmed by design, and the
// greeting shares no long run with the earlier half of its own turn, so
// `withinTurn` sees nothing either.
// ---------------------------------------------------------------------------
const GREETING = CONFIG.greeting;

describe("the opening greeting, re-spoken mid-call", () => {
  beforeEach(() => clearStats());

  it("cuts the greeting spliced onto the end of an ordinary turn", async () => {
    const s = await boot();
    await s.say(GREETING);
    await s.caller("Hi, I'd like to book something.");
    // The real splice: one turn, the useful sentence first, the greeting
    // arriving behind it. Fragments, because that is how it actually arrives
    // and it is what lets the cut land on the greeting rather than the answer.
    s.fragment("I can help with that. What day were you thinking of?");
    s.fragment(GREETING);
    await s.endTurn();

    expect(c().live_greeting_respoken).toBe(1);
    expect(c().live_greeting_respoken_cut).toBe(1);
    expect(s.cleared).toHaveLength(1);
  });

  it("does NOT cut the real greeting — the veto still holds", async () => {
    // The first thing every caller hears. A mangled greeting is worse than a
    // doubled one and there is no recovering a first impression.
    const s = await boot();
    s.fragment(GREETING);
    s.fragment(GREETING);
    await s.endTurn();

    expect(c().live_greeting_respoken).toBeFalsy();
    expect(s.cleared).toHaveLength(0);
  });

  it("leaves a short phrase the greeting happens to contain alone", async () => {
    // "How can I help you today?" is six normalised words and an ordinary thing
    // to say again after finishing a task. Cutting it would be a worse defect
    // than the one this branch fixes — hence a threshold of ten, not six.
    const s = await boot();
    await s.say(GREETING);
    await s.caller("That's all sorted, thanks.");
    await s.say("Happy to help. How can I help you today?");

    expect(c().live_greeting_respoken).toBeFalsy();
    expect(s.cleared).toHaveLength(0);
  });

  it("has an allowance SEPARATE from the general repeat budget", async () => {
    // A re-greet must not be unprotected because an unrelated loop earlier in
    // the call already spent MAX_REPEAT_CUTS. Different defect, different
    // population — LVX104's lesson about an allowance keyed to the wrong one.
    const s = await boot();
    await s.say(GREETING);
    for (let i = 0; i < 4; i += 1) await s.say(SLOTS_A);
    expect(c().live_repeat_cut).toBe(3);

    await s.caller("Sorry, go on.");
    s.fragment("Of course. What day suits you?");
    s.fragment(GREETING);
    await s.endTurn();

    expect(c().live_greeting_respoken_cut).toBe(1);
  });

  it("counts a detection even once the cut allowance is spent", async () => {
    // A fault-only counter reads zero for a clean call and for a call that
    // never got there. The gap between these two numbers is what says the
    // caller actually heard one.
    const s = await boot();
    await s.say(GREETING);
    for (let i = 0; i < 3; i += 1) {
      await s.caller(`Sorry, say that again ${i}.`);
      s.fragment(`Certainly, one moment number ${i}.`);
      s.fragment(GREETING);
      await s.endTurn();
    }

    expect(c().live_greeting_respoken).toBe(3);
    expect(c().live_greeting_respoken_cut).toBe(2);
    expect(s.cleared).toHaveLength(2);
  });
});
