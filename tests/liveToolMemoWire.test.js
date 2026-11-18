import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createToolRunner } from "../lib/voice/live/tools.js";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// THE WIRE, not the guard.
//
// tests/liveGuards.test.js proves the memo in isolation: it remembers, it
// forgets on resetTurn(), it never memos a failure or a write. None of that is
// worth anything if the reset is never called, and this repository has been
// bitten by exactly that four times -- lastCallerText, lastReadBackKey,
// abandonedWrites and lastReplyText each had a tested producer and a tested
// consumer and nothing in between (lib/voice/live/tools.js:161-215).
//
// A missed reset does not fail loudly. It turns a per-TURN memo into a
// per-CALL cache, which answers a later question from a stale diary -- the one
// scope the design rejected, and the reason the tests say "turn" and not
// "call". So every boundary where a turn ends is asserted here, by counting
// how many times the tool actually EXECUTED.
//
// Three boundaries, because applyTurn() is not all of them:
//
//   turnComplete   the normal path
//   interrupted    a barged turn never reaches applyTurn at all
//   a new caller   the flush at the top of a caller turn is gated on
//   turn           accumulated text, so a turn that ran tools and said
//                  nothing skips applyTurn entirely
// ---------------------------------------------------------------------------

const APPOINTMENTS_CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: [
    "general_question",
    "take_message",
    "book_appointment",
    "cancel_appointment",
    "reschedule_appointment",
    "check_appointment",
  ],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
  businessHours: {},
};

const DAY_QUERY = { id: "a", name: "check_appointment_availability", args: { requested_at: "2026-09-15" } };

function recorder() {
  const seen = [];
  return {
    seen,
    execute: vi.fn(async (fc) => {
      seen.push(fc.name);
      return {
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: { success: true, open_times: ["2026-09-15T14:00:00"], total_open: 1 },
        },
        stateEffects: {},
      };
    }),
  };
}

function makeRunner(rec) {
  return createToolRunner({
    config: APPOINTMENTS_CONFIG,
    extras: { integrations: [] },
    execute: rec.execute,
    turnState: () => ({ step: "greeting", callerTurnCount: 2 }),
  });
}

describe("the read memo, through the tool runner", () => {
  it("runs an identical read once and answers the repeat from the memo", async () => {
    const rec = recorder();
    const r = makeRunner(rec);

    const out = await r.handleToolCall({
      functionCalls: [DAY_QUERY, { ...DAY_QUERY, id: "b" }],
    });

    expect(rec.seen).toEqual(["check_appointment_availability"]);
    // Every call still gets a response, carrying its OWN id. A Live session
    // holding an unanswered tool call does not error -- it waits, and the
    // caller hears silence.
    expect(out.functionResponses.map((f) => f.id)).toEqual(["a", "b"]);
    expect(out.functionResponses[1].response.open_times).toEqual(["2026-09-15T14:00:00"]);
  });

  it("does not count a memo hit as a refusal", async () => {
    // refusedCalls feeds toolsRanThisTurn() in lib/voice/live/index.js, which
    // the claim guard reads. A memo hit is an ANSWERED call, not a refused one.
    const rec = recorder();
    const r = makeRunner(rec);

    const out = await r.handleToolCall({
      functionCalls: [DAY_QUERY, { ...DAY_QUERY, id: "b" }],
    });

    expect(out.refusedCalls).toBe(0);
    expect(out.refusedActionCalls).toBe(0);
  });

  it("does not memo request_transfer, whose whole value is its stateEffects", async () => {
    // capabilities/transfer.js declares actionTools: [], so isWriteTool answers
    // FALSE for request_transfer -- which is why the memo is an allowlist and
    // not the complement of the write rule. A memoed transfer returns
    // {allow:false} and short-circuits before stateEffects is read, so
    // transferRequested never reaches the engine. That is the end_call failure
    // written up at the top of lib/voice/live/guards.js, in a second tool.
    const rec = {
      seen: [],
      execute: vi.fn(async (fc) => {
        rec.seen.push(fc.name);
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
          stateEffects: { transferRequested: "+441372656055" },
        };
      }),
    };
    const r = makeRunner(rec);

    const out = await r.handleToolCall({
      functionCalls: [
        { id: "a", name: "request_transfer", args: { reason: "billing" } },
        { id: "b", name: "request_transfer", args: { reason: "billing" } },
      ],
    });

    expect(rec.seen).toEqual(["request_transfer", "request_transfer"]);
    expect(out.transferRequested).toBe("+441372656055");
  });

  it("runs the read again once the turn has ended", async () => {
    const rec = recorder();
    const r = makeRunner(rec);

    await r.handleToolCall({ functionCalls: [DAY_QUERY] });
    r.guards.resetTurn();
    await r.handleToolCall({ functionCalls: [{ ...DAY_QUERY, id: "b" }] });

    expect(rec.seen).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// And now the same question of the real session, which is the half that has
// never been proven.
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
  let onmessage = null;
  return {
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: () => {},
          sendToolResponse: () => {},
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
    loadConfig: () => APPOINTMENTS_CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

/** RMS 32,124 in mu-law -- loud enough for inboundVad's 700 threshold. */
const VOICED = Buffer.alloc(160, 0x00).toString("base64");

async function bootSession() {
  let clock = 0;
  const ws = new FakeSocket();
  const live = fakeLive();
  const seen = [];
  const execute = vi.fn(async (fc) => {
    seen.push(fc.name);
    return {
      functionResponse: {
        id: fc.id,
        name: fc.name,
        response: { success: true, open_times: ["2026-09-15T14:00:00"], total_open: 1 },
      },
      stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
    };
  });

  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: fakeDb(),
    env: {},
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

  let toolId = 0;
  return {
    live,
    seen,
    settle,
    async checkAvailability() {
      toolId += 1;
      live.push({
        toolCall: {
          functionCalls: [
            { id: `t${toolId}`, name: "check_appointment_availability", args: { requested_at: "2026-09-15" } },
          ],
        },
      });
      await settle();
    },
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    interrupt: () => live.push({ serverContent: { interrupted: true } }),
    /** Enough voiced frames for inboundVad to declare speech and open a turn. */
    callerSpeaks(frames = 40) {
      for (let i = 0; i < frames; i++) {
        clock += 20;
        ws.deliver({ event: "media", media: { payload: VOICED } });
      }
    },
  };
}

describe("the memo is forgotten at every boundary a turn can end on", () => {
  it("within one turn, the repeat never reaches the tool", async () => {
    const s = await bootSession();
    await s.checkAvailability();
    await s.checkAvailability();

    expect(s.seen).toHaveLength(1);
  });

  it("turnComplete ends the turn", async () => {
    const s = await bootSession();
    await s.checkAvailability();
    s.endTurn();
    await s.settle();
    await s.checkAvailability();

    expect(s.seen).toHaveLength(2);
  });

  it("an interrupted turn ends the turn too, and never reaches applyTurn", async () => {
    const s = await bootSession();
    await s.checkAvailability();
    s.interrupt();
    await s.settle();
    await s.checkAvailability();

    expect(s.seen).toHaveLength(2);
  });

  it("a new caller turn ends it, even when the model said nothing at all", async () => {
    // The zero-text turn. The flush at the top of a caller turn is gated on
    // accumulated text, so a turn that ran tools and produced no
    // outputTranscription and never received turnComplete skips applyTurn --
    // and a memo reset placed only in applyTurn would survive into the next
    // caller turn. That is the stale-diary case the per-turn scope exists to
    // prevent.
    const s = await bootSession();
    await s.checkAvailability();
    s.callerSpeaks();
    await s.settle();
    await s.checkAvailability();

    expect(s.seen).toHaveLength(2);
  });
});
