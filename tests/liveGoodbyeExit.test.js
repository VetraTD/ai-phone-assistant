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
    /** The vendor reporting the caller talked over us. */
    async vendorInterrupt() {
      live.push({ serverContent: { interrupted: true } });
      await new Promise((r) => setImmediate(r));
    },
    /** Twilio echoing the exit mark back, meaning the audio has played. */
    async markPlayed() {
      ws.deliver({ event: "mark", mark: { name: "live-exit-end_call" }, streamSid: "MZ1" });
      await new Promise((r) => setImmediate(r));
    },
  };
}

const c = () => getLatencyStats().turnTaking;

/**
 * LVX146's precondition: the caller has been asked whether they need anything
 * else, and has answered.
 *
 * Added 2026-09-18, and for the same reason the equivalent exchange was added
 * to tests/liveExitClose.test.js's bookedCall() when LVX132 landed. The cases
 * below are about the farewell DETECTOR -- which sentences read as a sign-off.
 * LVX146 puts a condition in front of the arming, so without this they stop
 * testing signOffRe and quietly become a second test of the ask gate, which is
 * a fixture describing a call that can no longer happen.
 *
 * The asking turn is deliberately not itself a farewell, so it cannot arm.
 */
async function asked(s) {
  await s.say("All set. Is there anything else I can help you with today?");
  await s.caller("No, that's everything.");
}

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
    await asked(s);
    await s.say(GOODBYE);

    expect(c().live_goodbye_armed_exit).toBe(1);
  });

  // -------------------------------------------------------------------------
  // CAaef5bd82, 2026-09-17. VERBATIM, and it is why this test exists.
  //
  // The model booked the appointment, said its goodbye, and did NOT call
  // end_call -- so this detector was the only thing that could have closed the
  // line, and it did not fire. The caller sat on an open line for eight seconds
  // until the silence ladder nudged, heard "I'm still here whenever you're
  // ready", and waited another six.
  //
  // The whole cause is one word. signOffRe's bare-farewell alternative reads
  // `have a (great|good|lovely) (day|weekend|evening)`, and the model said
  // "have a WONDERFUL day".
  //
  // Scored across every farewell in call-corpus/, which is the reason this is a
  // fix rather than a guess: FOUR of the six say "wonderful" and were missed;
  // the two that match say "great". The earlier calls hid it because the model
  // also called end_call on those, so something else closed the line.
  // -------------------------------------------------------------------------
  const REAL_FAREWELLS = [
    "That's all set — I've booked your free strategy call for Friday, September 18th at 12:45 PM. Thanks for calling Digile Media, and have a wonderful day.",
    "I have cancelled your existing appointment on Friday, September eighteenth at four thirty PM. Thanks for calling Digile Media, and have a wonderful day.",
    "Thanks for calling Digile Media, and have a wonderful day.",
    "Thanks again for calling Digile Media, Marcus. Have a great day.",
  ];

  it.each(REAL_FAREWELLS)("arms on a farewell the model actually said: %s", async (text) => {
    const s = await boot();
    await asked(s);
    await s.say(text);

    expect(c().live_goodbye_armed_exit).toBe(1);
  });

  // Every farewell in the corpus says "thanks for calling", so all four above
  // match on the FIRST alternative and the second one is untested by real data.
  // These cover it. Found by the sabotage matrix: narrowing only the second
  // alternative left the suite green, which meant half the fix had no test.
  it.each([
    "Perfect. Have a wonderful afternoon.",
    "All sorted — have a fantastic day!",
    "Have a lovely weekend.",
  ])("arms on a bare farewell with no 'thanks for calling': %s", async (text) => {
    const s = await boot();
    await asked(s);
    await s.say(text);

    expect(c().live_goodbye_armed_exit).toBe(1);
  });

  it("does not arm on a farewell-shaped phrase in the middle of a sentence", async () => {
    // The anchor earning its keep. An open adjective with no end-anchor would
    // read this as a sign-off and hang up on someone mid-booking.
    const s = await boot();
    await s.say("I'll have a full day free on Tuesday if that suits you better?");

    expect(c().live_goodbye_armed_exit).toBe(0);
    expect(c().live_goodbye_checked).toBeGreaterThan(0);
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
    await asked(s);
    await s.say(GOODBYE);
    await s.say("Thanks for calling Digile Media, have a great day!");

    expect(c().live_goodbye_armed_exit).toBe(1);
  });

  it("CANCELS the pending hang-up when the caller barges in", async () => {
    // The owner's second request, and the bug it exposed. clearAudio() used to
    // run the exit, so barging in during a goodbye hung up FASTER. Now the
    // caller speaking calls it off, and the call stays up.
    const s = await boot();
    await asked(s);
    await s.say(GOODBYE);
    expect(c().live_goodbye_armed_exit).toBe(1);

    await s.caller("actually wait, one more thing");

    expect(c().live_exit_cancelled_by_caller).toBe(1);
    expect(s.closed()).toBe(false);
  });

  it("does not close the instant the mark comes back", async () => {
    // 2026-09-06, and the owner heard it: "I tried to interrupt the end call
    // thing and it just ended the call in the middle of the sentence."
    //
    //   17:44:49.305  TOOL end_call ok
    //   17:44:52.584  live_exit_armed
    //   17:44:52.657  live_exit_run  trigger: "mark"   <- 73ms later
    //   17:44:52.657  caller speaking
    //
    // The exit waits for an audio MARK, which is meant to mean "the goodbye has
    // played". The model called end_call without speaking a goodbye at all, so
    // nothing was queued, the mark bounced straight back, and the call closed
    // 73 milliseconds after arming. The caller's speech landed in the same
    // millisecond as the hang-up.
    //
    // The cascade has had the answer since before this front-end existed:
    // HANGUP_GRACE_MS, whose own comment reads "the window has to be long enough
    // for someone to actually start talking - 800ms is barely a breath... the
    // cost of being stingy is hanging up on someone mid-sentence."
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = await boot();
      await asked(s);
      await s.say(GOODBYE);
      await s.markPlayed();

      // Still up: the grace has not elapsed.
      expect(s.closed()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(s.closed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the caller cancel the hang-up inside that window", async () => {
    // The whole point of the grace. Speech during it calls the exit off, which
    // is what "if the user barges in the receptionist doesn't just go straight
    // through and end" actually requires.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = await boot();
      await asked(s);
      await s.say(GOODBYE);
      await s.markPlayed();
      await s.caller("wait, actually one more thing");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.closed()).toBe(false);
      expect(c().live_exit_cancelled_by_caller).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to arm at all when the caller interrupted the goodbye", async () => {
    // THE CASE THE GRACE WINDOW COULD NOT COVER, 2026-09-06.
    //
    //   17:54:41.302  end_call ok
    //   17:54:44.894  live_exit_armed      <- 3.6s later, at TURN END
    //   17:54:46.485  live_exit_run
    //
    // The caller barged during the goodbye: barges: 1, and the utterance
    // recorded playing_at_open: true. At that moment pendingExit was still null,
    // so cancelPendingExit had nothing to cancel -- and we then armed an exit
    // anyway and hung up on someone already speaking.
    //
    // Cancelling an ARMED exit was never going to be enough, because the thing
    // worth interrupting is the goodbye and the goodbye comes first.
    const s = await boot();
    // LVX146's precondition, so this stays a test of the BARGE refusal. Without
    // it the ask hold fires first, armExit is never called, and
    // live_exit_refused_recent_barge reads 0 -- the case passing for a reason
    // that has nothing to do with the barge.
    await asked(s);
    await s.vendorInterrupt();
    await s.say(GOODBYE);

    expect(c().live_exit_refused_recent_barge).toBe(1);
    expect(c().live_goodbye_armed_exit).toBe(0);
    expect(s.closed()).toBe(false);
  });

  it("holds for the unanswered question BEFORE the barge check is reached", async () => {
    // The precedence between LVX146 and the barge refusal, asserted directly
    // rather than left as an implication of the setups above. Both prevent the
    // arming and the caller hears the same thing either way, so the only
    // visible difference is which counter moves -- and a later change to either
    // could silently hand the case to the other while both suites stayed green.
    // That is the trap tests/liveExitClose.test.js already records between the
    // ask gate and the held-question guard.
    const s = await boot();
    await s.caller("I want to book an appointment.");
    await s.vendorInterrupt();
    await s.say(GOODBYE);

    expect(c().live_goodbye_exit_held_no_ask).toBe(1);
    expect(c().live_exit_refused_recent_barge).toBeFalsy();
    expect(c().live_goodbye_armed_exit).toBeFalsy();
    expect(s.closed()).toBe(false);
  });

  it("still arms normally when nobody interrupted", async () => {
    // The other side of it. A refusal that fired on every call would simply
    // stop the assistant ever hanging up, which is the defect it replaced.
    const s = await boot();
    await asked(s);
    await s.say(GOODBYE);

    expect(c().live_exit_refused_recent_barge).toBe(0);
    expect(c().live_exit_arm_checked).toBe(1);
    expect(c().live_goodbye_armed_exit).toBe(1);
  });

  it("leaves the caller a window to interrupt before it hangs up", async () => {
    // "Add a slight delay... like the cascade has." The window is what makes
    // the cancel above reachable at all: an exit that fired the instant the
    // goodbye ended would give nobody time to speak.
    const s = await boot();
    await asked(s);
    await s.say(GOODBYE);

    expect(s.closed()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LVX146 — THE OTHER DOOR. CA299f23ce, 2026-09-18:
//
//   19:04:27  A: "I have you down for a strategy call on Friday, September
//                 twenty-fifth at four-thirty in the afternoon. Does that
//                 sound correct?"
//   19:04:34  book_appointment -> REFUSED (readback=true, agreed=false)
//   19:04:37  live_tool_rounds_capped {cap:5, round:6}
//   19:04:39  live_tool_rounds_capped {cap:5, round:7}
//   19:04:42  A: "That is all booked. Thanks for calling Digile Media, and
//                 have a great day."
//   19:04:43  live_exit_run
//
// booked_rows 0. The caller was told a booking existed, was never asked whether
// they needed anything else, and the line dropped one second later.
//
// end_call_refusals read {no_ask: 0} -- nothing refused, because end_call was
// NEVER CALLED. The model said a farewell out loud and the sign-off detector
// armed the exit directly.
//
// THREE ROUNDS OF GUARDS ALL SIT ON THE end_call DOOR:
//
//   LVX132  never asked at all                      } every one of them reads
//   LVX141  asked only in the closing turn          } state the end_call gate
//   LVX145  asked, and never answered               } passes, or runs at the
//                                                     exit branch that only
//                                                     `endCallArmed` reaches
//
// armExit() is called from auditTurn, before that branch, and endCallArmed is
// set only by the tool. So the farewell route reaches none of them. The model
// can end any call at any time, without ever asking, by saying "have a great
// day" -- which is what it did on the one call where it had just been refused a
// write and announced success anyway.
//
// The same question is now asked here: is a question to the caller still
// outstanding? Either they were never asked, or they were asked and have said
// nothing since.
//
// HELD ONCE, NOT REFUSED. The silence ladder and the media watchdog are still
// the backstops, so a model that says nothing further still closes the call;
// what this buys is the one turn in which a caller can answer. A permanent
// refusal here would trade a premature hang-up for a line nobody can end, which
// is the defect on the other call of 2026-09-17 and the worse of the two.
// ---------------------------------------------------------------------------
const GOODBYE_NO_ASK = "That is all booked. Thanks for calling Digile Media, and have a great day.";
const GOODBYE_WITH_ASK =
  "That is all booked. Is there anything else I can help you with today? " +
  "Thanks for calling Digile Media, and have a great day.";

describe("a spoken goodbye is not a way around the ask gate", () => {
  beforeEach(() => clearStats());

  it("does not arm when the caller was never asked anything", async () => {
    const s = await boot();
    await s.caller("I want to book an appointment.");
    await s.say(GOODBYE_NO_ASK);

    expect(c().live_goodbye_exit_held_no_ask).toBe(1);
    expect(c().live_goodbye_armed_exit).toBeFalsy();
    expect(s.closed()).toBe(false);
  });

  it("does not arm when the ask is in the very turn that signs off", async () => {
    // The caller cannot have answered a question that is still being spoken.
    const s = await boot();
    await s.caller("I want to book an appointment.");
    await s.say(GOODBYE_WITH_ASK);

    expect(c().live_goodbye_exit_held_no_ask).toBe(1);
    expect(c().live_goodbye_armed_exit).toBeFalsy();
  });

  it("arms once the caller has been asked and has answered", async () => {
    const s = await boot();
    await s.caller("I want to book an appointment.");
    await s.say("All set. Is there anything else I can help you with today?");
    await s.caller("No, that's everything.");
    await s.say(GOODBYE_NO_ASK);

    expect(c().live_goodbye_armed_exit).toBe(1);
    expect(c().live_goodbye_exit_held_no_ask).toBeFalsy();
  });

  it("holds only once, so the ladder is never the only way out", async () => {
    const s = await boot();
    await s.caller("I want to book an appointment.");
    await s.say(GOODBYE_NO_ASK);
    expect(c().live_goodbye_exit_held_no_ask).toBe(1);

    // Still nothing from the caller. The second farewell goes through.
    await s.say(GOODBYE_NO_ASK);

    expect(c().live_goodbye_armed_exit).toBe(1);
    expect(c().live_goodbye_exit_held_no_ask).toBe(1);
  });
});
