import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { STEPS } from "../lib/callState.js";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// The Live path must drive the SHARED reducer, not a private approximation.
//
// Two defects, one cause, both found by review rather than by the tests that
// were written alongside the code:
//
//   1. `capabilityEffects` was returned by the tool runner and consumed by
//      NOTHING. capabilities/messages.js answers the caller immediately and
//      defers its database write to `onEffect`, deliberately, so the caller is
//      never made to wait on a round trip. With no dispatcher the caller is
//      told "I'll make sure they get your message" and no row is written and
//      nobody is notified. Same shape for the booking owner-alert and the SMS
//      consent record.
//
//   2. Backlog LVX8: no `applyReplyState`, so `spellAskCap` never counts and
//      the assistant asked a caller to spell their name on three consecutive
//      turns in the first real exercise.
//
// They are the same fix. `lib/voice/replyState.js` and
// `lib/capabilities/effects.js` are both standalone modules, and
// lib/harness/textSession.js is already a second driver of them -- so the Live
// path becomes a third and touches no cascade file.
//
// replyState.js's own comment says why this is not optional: anything
// implemented in one driver and not the other "goes inert" for the drivers
// that miss it, "which is how the nine-turn spelling livelock survived with
// every hard assert green".
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.authorizedCallSid = null;
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
  const sent = { toolResponses: [], clientContent: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: (m) => sent.clientContent.push(m),
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks, config }) => {
      onmessage = callbacks.onmessage;
      sent.config = config;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

const CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
  businessHours: {},
};

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: "biz-1", name: "Digile Media" }),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

async function boot({ live = fakeLive(), execute, effectsDeps } = {}) {
  const ws = new FakeSocket();
  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    env: {},
    ...(execute ? { execute } : {}),
    ...(effectsDeps ? { effectsDeps } : {}),
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  return { ws, live };
}

describe("deferred capability effects reach the pack that owns them", () => {
  it("dispatches an effect a tool deferred, instead of dropping it", async () => {
    // capabilities/messages.js returns success to the caller and defers the
    // insert. Dropping the effect is a caller told yes and a message that was
    // never recorded.
    const dispatched = [];
    const live = fakeLive();
    await boot({
      live,
      execute: async (fc) => ({
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          toolResult: { name: fc.name, success: true, message: "Noted." },
          capabilityEffects: [{ capability: "messages", type: "recorded", data: { name: "Marcus" } }],
        },
      }),
      effectsDeps: {
        dispatch: (effects) => {
          dispatched.push(...effects);
          return [];
        },
      },
    });

    live.push({ toolCall: { functionCalls: [{ id: "t1", name: "record_customer_request", args: {} }] } });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    // Effects dispatch at TURN end, not at tool-response time -- the same
    // ordering the cascade uses, so that several tools in one turn produce one
    // bracketed history note rather than several.
    live.push({ serverContent: { outputTranscription: { text: "I have noted that." }, turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ capability: "messages", type: "recorded" });
  });
});

describe("effects pending at hang-up", () => {
  it("are dispatched rather than lost when the call ends first", async () => {
    // The caller says "that's everything, bye" in the same breath as leaving a
    // message. If the socket closes before a turn completes, a deferred write
    // that was already promised to the caller must still happen -- dropping it
    // is the same data loss as never having a dispatcher.
    const dispatched = [];
    const live = fakeLive();
    const { ws } = await boot({
      live,
      execute: async (fc) => ({
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          capabilityEffects: [{ capability: "messages", type: "recorded", data: {} }],
        },
      }),
      effectsDeps: {
        dispatch: (effects) => {
          dispatched.push(...effects);
          return [];
        },
      },
    });

    live.push({ toolCall: { functionCalls: [{ id: "t1", name: "record_customer_request", args: {} }] } });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    ws.deliver({ event: "stop" });
    await new Promise((r) => setImmediate(r));

    expect(dispatched).toHaveLength(1);
  });
});

describe("LVX8 - the spelling ask is counted, not merely discouraged", () => {
  it("counts a spelling request in shared call state", async () => {
    // In the first real exercise the assistant asked three turns running.
    // spellAskCap and hasSpentSpellingAsk live in applyReplyState; a path that
    // does not run it has no counter and therefore no cap.
    const live = fakeLive();
    const { ws } = await boot({ live });

    live.push({
      serverContent: {
        outputTranscription: { text: "Could I take your name, and would you spell that for me please?" },
        turnComplete: true,
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(ws.liveState?.spellAsks).toBe(1);
  });

  it("keeps a step machine that an effect can advance", async () => {
    const live = fakeLive();
    const { ws } = await boot({ live });

    expect(ws.liveState?.step).toBeDefined();
    expect(Object.values(STEPS)).toContain(ws.liveState.step);
  });
});
