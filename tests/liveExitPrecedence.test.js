// ---------------------------------------------------------------------------
// LVX96 — a refused end_call ends the call anyway, by two separate routes.
//
// Both were found on 2026-09-09 by reading calls by hand, because the generic
// end_call refusal had no counter and `endCallArmed` had no reset. Both end a
// live conversation. Neither is reachable by fixing the other.
//
// ROUTE A, two sightings (calls e0a9f6 and 76c2ba). end_call's declaration
// makes the model write its sign-off in the SAME response as the call, so the
// farewell is composed before any gate runs. The gate refused -- correctly, on
// e0a9f6 the caller had asked one question and had not been answered -- and the
// sign-off detector then read the farewell the refusal itself had caused and
// armed the exit. The call closed 1.6 seconds later, while the assistant was
// still asking "is there anything else I can help with?".
//
// ROUTE B, one sighting (call 7aef50). end_call SUCCEEDED, armExit was refused
// inside the barge grace window, and `endCallArmed` -- assigned in exactly one
// place and reset in none -- kept the end-of-turn retry re-asking on every
// later turn. Eleven seconds and two unrelated exchanges later it fired, on a
// turn that ended in a fresh question to the caller.
//
// These tests are the certification. Remove either fix and the matching case
// goes red; the control cases go red if a fix is made too broad, which is the
// error that reinstates the 2026-09-06 dangling-line defect.
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
  /**
   * The exit marks actually put on the wire.
   *
   * The observable that matters, and `closed()` is not it: an armed exit waits
   * for Twilio to echo its mark back, so a call whose hang-up is armed and one
   * whose hang-up was dropped are both "not closed" until the mark returns.
   * Asserting on closure alone would let route B's fix pass by doing nothing.
   */
  marks() {
    return this.sent.filter((m) => m.event === "mark").map((m) => m.mark?.name);
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

/**
 * A MOVABLE clock, and route B cannot be tested without one.
 *
 * armExit refuses within HANGUP_GRACE_MS (1,500 ms) of a barge. With the clock
 * frozen at 0 every retry is refused forever, so a broken latch and a fixed one
 * produce identical output and the test proves nothing. The real call had
 * eleven seconds between the barge and the hang-up.
 */
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/**
 * @param {object} opts
 * @param {"refuse"|"allow"} opts.endCall - what the end_call gate does
 */
async function boot({ endCall = "refuse", clock = makeClock() } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  let toolId = 0;

  // Stands in for services/tools.js's end_call branch. The two shapes are the
  // ones that file actually returns: a refusal carries `endCallRefusal` and no
  // endCallArgs, a success carries endCallArgs and no refusal.
  const execute = vi.fn(async (fc) => {
    if (fc.name === "end_call" && endCall === "refuse") {
      return {
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: { success: false, message: "[not caller speech] NOT A FAILURE" },
        },
        stateEffects: {
          endCallRefusal: "generic",
          toolResult: {
            name: fc.name,
            success: false,
            message: "Is there anything else I can help you with?",
            callerSafe: true,
          },
        },
      };
    }
    if (fc.name === "end_call") {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          endCallArgs: {},
          toolResult: { name: fc.name, success: true, message: "Goodbye.", callerSafe: true },
        },
      };
    }
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
    };
  });

  await handleLiveSessionConnection(ws, {}, {
    now: clock.now,
    connect: live.connect,
    database: fakeDb(),
    env: {},
    execute,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA_x", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  return {
    ws,
    clock,
    settle,
    async endCallTool() {
      live.push({ toolCall: { functionCalls: [{ id: `t${(toolId += 1)}`, name: "end_call", args: {} }] } });
      await settle();
    },
    async say(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
    async caller(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
    },
    async vendorInterrupt() {
      live.push({ serverContent: { interrupted: true } });
      await settle();
    },
    closed: () => ws.readyState === 3,
    exitMarks: () => ws.marks().filter((n) => n === "live-exit-end_call"),
  };
}

const c = () => getLatencyStats().turnTaking;

// The verbatim shape from call e0a9f6: the farewell spliced ahead of the answer
// the model was still waiting on, with no space before "I'm".
const REFUSED_TURN =
  "Of course, I can check on those for you. Thanks for calling Brightwork Studio " +
  "and have a great day.I'm not finding any upcoming appointments under this " +
  "number. Is there anything else I can help with?";

const PLAIN_GOODBYE = "Thanks for calling Brightwork Studio, and have a great day!";

describe("LVX96 route A — a refusal outranks the sign-off detector", () => {
  beforeEach(() => clearStats());

  it("does not arm an exit off a goodbye spoken on a turn end_call was refused", async () => {
    const s = await boot({ endCall: "refuse" });
    await s.endCallTool();
    await s.say(REFUSED_TURN);

    expect(c().live_goodbye_suppressed_by_refusal).toBe(1);
    expect(c().live_goodbye_armed_exit).toBe(0);
    expect(s.exitMarks()).toEqual([]);
    expect(s.closed()).toBe(false);
  });

  it("still arms on a sign-off when nothing was refused — the 2026-09-06 rule survives", async () => {
    // The control that matters. A permanent suppression would pass the case
    // above and reinstate the defect the sign-off detector exists for: the
    // assistant says thank-you-for-calling, nothing runs, and the line dangles
    // until the silence ladder nudges eleven seconds later.
    const s = await boot({ endCall: "refuse" });
    await s.say(PLAIN_GOODBYE);

    expect(c().live_goodbye_armed_exit).toBe(1);
    expect(c().live_goodbye_suppressed_by_refusal).toBe(0);
  });

  it("suppresses only the refusing turn, not the ones after it", async () => {
    // Per-turn scoping, asserted rather than assumed. If the latch is never
    // cleared, the second goodbye is suppressed too and the line is left open
    // for good -- the same dangling call, reached by the fix instead of by the
    // bug.
    const s = await boot({ endCall: "refuse" });
    await s.endCallTool();
    await s.say(REFUSED_TURN);
    expect(c().live_goodbye_armed_exit).toBe(0);

    await s.caller("Yes, actually — could you check tomorrow?");
    await s.say(PLAIN_GOODBYE);

    expect(c().live_goodbye_armed_exit).toBe(1);
  });
});

describe("LVX96 route B — the hang-up latch has a lifetime", () => {
  beforeEach(() => clearStats());

  it("drops a hang-up intent the caller falsified by carrying on talking", async () => {
    const s = await boot({ endCall: "allow" });

    // end_call succeeds: the latch is set.
    await s.endCallTool();
    // The caller talks over the goodbye. The vendor reports the interrupt,
    // which is what put lastBargeAt in reach of armExit on the real call.
    await s.vendorInterrupt();
    // Turn ends. armExit is asked and refused inside the grace window, setting
    // no pendingExit -- so before the fix nothing recorded the refusal at all.
    await s.say("Thanks for calling, and have a great day!");
    expect(c().live_exit_refused_recent_barge).toBe(1);
    expect(s.closed()).toBe(false);

    // The caller carries on, on an unrelated subject. This is the event that
    // falsifies "the conversation is over".
    await s.caller("Sorry, one more thing — can I move Thursday's appointment?");
    expect(c().live_end_call_latch_cleared).toBe(1);

    // Eleven seconds later, well clear of the grace window. On call 7aef50 this
    // is where the exit fired, on a turn that ended in a question.
    s.clock.advance(11_000);
    await s.say("Of course. What time would suit you instead?");

    expect(s.exitMarks()).toEqual([]);
    expect(s.closed()).toBe(false);
  });

  it("leaves the latch alone when the caller does not speak", async () => {
    // The other control. A latch cleared too eagerly means a model that
    // genuinely finished can never hang up, and the silence ladder becomes the
    // only way any call ends.
    const s = await boot({ endCall: "allow" });
    await s.endCallTool();
    await s.vendorInterrupt();
    await s.say("Thanks for calling, and have a great day!");
    expect(c().live_exit_refused_recent_barge).toBe(1);

    s.clock.advance(11_000);
    await s.say("Goodbye.");

    expect(c().live_end_call_latch_cleared).toBeFalsy();
    expect(s.exitMarks()).toEqual(["live-exit-end_call"]);
  });
});
