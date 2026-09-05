// ---------------------------------------------------------------------------
// LVX78 — the assistant repeating itself, word for word.
//
// Found the least reliable way available: the owner half-remembered that a call
// "repeated something in an unnatural way" and could not say what. Nothing in
// this system could answer that question, so four calls were read back by hand.
// Three instances turned up, and no counter had seen any of them:
//
//   16 words, call 2 turns 9->10. The ENTIRE booking recited twice in
//      consecutive turns -- "on Monday, September 7th, at 4 PM, and we'll call
//      you on 469 933 8887". The caller corrected their NAME and the model
//      re-read the whole booking rather than the name.
//
//   10 words, call 1 turns 12->14. "thanks for calling Digile Media and have a
//      great day", delivered twice with OUR OWN silence nudge in between.
//
//    6 words, call 3 turns 1->2. The greeting, twice.
//
// postcall_verify returned `ok` for the call carrying the first.
//
// ---------------------------------------------------------------------------
// The threshold is measured, not chosen
// ---------------------------------------------------------------------------
//
// Across 26 consecutive turn-pairs from those calls, 24 shared four words or
// fewer. The only two above that were the two defects. Nothing landed between 4
// and 6, so REPEAT_RUN_WORDS sits in a real gap.
//
// COUNT ONLY, and here that is arithmetic rather than caution: by the time
// auditTurn runs the model has already spoken, so there is nothing left to
// suppress. What the number buys is knowing whether this happens twice a call
// or twice a month, before anyone designs a fix.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { longestSharedRun, REPEAT_RUN_WORDS } from "../lib/transcriptUtils.js";

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

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  await handleLiveSessionConnection(
    ws,
    {},
    { now: () => 0, connect: live.connect, database: fakeDb(), env: {}, execute: vi.fn() }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_rep", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  return {
    async say(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      live.push({ serverContent: { turnComplete: true } });
      await new Promise((r) => setImmediate(r));
    },
  };
}

const c = () => getLatencyStats().turnTaking;

describe("longestSharedRun", () => {
  it("measures the real sixteen-word booking re-read", () => {
    const t9 =
      "Got it, Nitin. Thanks for clarifying that. So that's for a half hour strategy call with the team " +
      "on Monday, September 7th, at 4 PM, and we'll call you on 469 933 8887. Does that sound right?";
    const t10 =
      "Thanks for correcting that, Nithin Dodla - so we have you booked in for a half hour strategy call " +
      "on Monday, September 7th, at 4 PM, and we'll call you on 469 933 8887. Is there anything else I can help with?";

    expect(longestSharedRun(t9, t10)).toBe(16);
  });

  it("measures the real ten-word doubled goodbye", () => {
    expect(
      longestSharedRun(
        "Just let me know if there's anything else. Otherwise, thanks for calling Digile Media and have a great day.",
        "In that case, thanks for calling Digile Media and have a great day."
      )
    ).toBe(10);
  });

  it("leaves ordinary consecutive turns near zero", () => {
    // 24 of the 26 observed pairs looked like this.
    const run = longestSharedRun(
      "Of course, I can help with that. Monday, September 7th is open, with times at 9 AM, 1 PM, or 4:30 PM. Which of those works best for you?",
      "Sure, 4 PM works. Can I get your full name and the best number to reach you on, please?"
    );
    expect(run).toBeLessThan(REPEAT_RUN_WORDS);
  });

  it("is 0 when either side is empty, so a silent turn cannot match", () => {
    expect(longestSharedRun("", "anything at all")).toBe(0);
    expect(longestSharedRun("anything at all", "")).toBe(0);
  });
});

describe("LVX78 — a repeat is counted", () => {
  beforeEach(() => clearStats());

  it("counts the booking read back twice in consecutive turns", async () => {
    const s = await boot();
    await s.say(
      "So that's for a half hour strategy call with the team on Monday, September 7th, at 4 PM, and we'll call you on 469 933 8887. Does that sound right?"
    );
    await s.say(
      "Thanks for correcting that - so we have you booked in for a half hour strategy call on Monday, September 7th, at 4 PM, and we'll call you on 469 933 8887."
    );

    expect(c().live_repeated_phrase).toBe(1);
    // The positive twin. The FIRST turn has no predecessor, so only the second
    // turn was ever comparable.
    expect(c().live_repeat_pairs_checked).toBe(1);
  });

  it("counts a goodbye repeated ACROSS an intervening nudge", async () => {
    // THE REASON THE WINDOW IS NOT ONE TURN. On the real call our own silence
    // nudge sat between the two goodbyes, so a previous-turn-only check would
    // have reported a clean call.
    const s = await boot();
    await s.say("Just let me know if there's anything else. Otherwise, thanks for calling Digile Media and have a great day.");
    await s.say("I'm still here whenever you're ready.");
    await s.say("In that case, thanks for calling Digile Media and have a great day.");

    expect(c().live_repeated_phrase).toBe(1);
  });

  it("leaves an ordinary exchange alone", async () => {
    const s = await boot();
    await s.say("Monday, September 7th is open, with times at 9 AM, 1 PM, or 4:30 PM. Which works best?");
    await s.say("Can I get your full name and the best number to reach you on, please?");

    expect(c().live_repeat_pairs_checked).toBe(1);
    expect(c().live_repeated_phrase).toBe(0);
  });

  it("never counts on the first turn of a call", async () => {
    // Nothing to compare against, and a counter that fired here would be
    // measuring its own start-up rather than the assistant.
    const s = await boot();
    await s.say("Thanks for calling Digile Media. How can I help you today?");

    expect(c().live_repeat_pairs_checked).toBe(0);
    expect(c().live_repeated_phrase).toBe(0);
  });
});
