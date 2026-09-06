// ---------------------------------------------------------------------------
// The goodbye and the hang-up, 2026-09-06.
//
// Two things the owner asked for after a real call, and one bug going the wrong
// way that they could not have known about.
//
// WHAT THEY HEARD. The assistant said "Wonderful. We've got that strategy call
// booked, and I've noted your details. Thanks for calling Digile Media, and have
// a great day!" -- and then did nothing. end_call never ran. The line stayed
// open until the silence ladder nudged eleven seconds later.
//
// WHAT THEY ASKED FOR. "Once the receptionist says 'thank you for calling...'
// unless the user interrupts, it should always go to end the call. Also, can you
// add a slight delay so that if the user barges in the receptionist doesn't just
// go straight through and end. Like the cascade has."
//
// THE BUG GOING THE WRONG WAY. clearAudio() ended with:
//
//     if (pendingExit) runExit("audio_cleared");
//
// A barge-in calls clearAudio. So interrupting a goodbye was the FASTEST way to
// get hung up on -- the precise opposite of the request. Nothing had noticed,
// because a pendingExit only existed after end_call ran, and on the observed
// call end_call never ran at all.
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
  await handleLiveSessionConnection(
    ws,
    {},
    { now: () => 0, connect: live.connect, database: fakeDb(), env, execute: vi.fn() }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_bye", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  return {
    ws,
    async say(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      live.push({ serverContent: { turnComplete: true } });
      await new Promise((r) => setImmediate(r));
    },
    async caller(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await new Promise((r) => setImmediate(r));
    },
    closed: () => ws.readyState === 3,
  };
}

const c = () => getLatencyStats().turnTaking;

const GOODBYE =
  "Wonderful. We've got that strategy call booked, and I've noted your details. " +
  "Thanks for calling Digile Media, and have a great day!";

describe("a spoken goodbye arms the hang-up", () => {
  beforeEach(() => clearStats());

  it("arms an exit when the model signs off without calling end_call", async () => {
    // The observed call: it said goodbye and left the line open until the
    // silence ladder nudged. The owner's rule -- once it says "thanks for
    // calling", the call should end.
    const s = await boot();
    await s.say(GOODBYE);

    expect(c().live_goodbye_armed_exit).toBe(1);
  });

  it("does not arm on an ordinary turn", async () => {
    const s = await boot();
    await s.say("Monday the 7th at 4:30 PM works. What's your full name?");

    expect(c().live_goodbye_armed_exit).toBe(0);
    // The positive twin: every turn with text is examined, so "no goodbyes" and
    // "this never ran" cannot read the same.
    expect(c().live_goodbye_checked).toBeGreaterThan(0);
  });

  it("does not arm twice for one goodbye", async () => {
    const s = await boot();
    await s.say(GOODBYE);
    await s.say("Thanks for calling Digile Media, have a great day!");

    expect(c().live_goodbye_armed_exit).toBe(1);
  });

  it("CANCELS the pending hang-up when the caller barges in", async () => {
    // The owner's second request, and the bug it exposed. clearAudio() used to
    // run the exit, so barging in during a goodbye hung up FASTER. Now the
    // caller speaking calls it off, and the call stays up.
    const s = await boot();
    await s.say(GOODBYE);
    expect(c().live_goodbye_armed_exit).toBe(1);

    await s.caller("actually wait, one more thing");

    expect(c().live_exit_cancelled_by_caller).toBe(1);
    expect(s.closed()).toBe(false);
  });

  it("leaves the caller a window to interrupt before it hangs up", async () => {
    // "Add a slight delay... like the cascade has." The window is what makes
    // the cancel above reachable at all: an exit that fired the instant the
    // goodbye ended would give nobody time to speak.
    const s = await boot();
    await s.say(GOODBYE);

    expect(s.closed()).toBe(false);
  });
});
