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
