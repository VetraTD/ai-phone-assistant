import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// CAb76b13, 2026-09-17 02:17, gemini-3.8-live. A FALSE CLAIM ABOUT A
// DESTRUCTIVE ACTION, AND THE GUARD SAID NOTHING.
//
// The caller asked to book. The model told them they already had an
// appointment, asked whether to add a second -- and six seconds later, without
// waiting for an answer, called cancel_appointment_db. The consent gate refused
// it (write_refused_no_consent, tool_duration success=False, no row touched).
// The model then called end_call and said:
//
//   "I have cancelled your existing appointment on Friday, September
//    eighteenth at four thirty PM. Thanks for calling Digile Media..."
//
// and the line dropped 1.6 seconds later.
//
// completionClaimRe MATCHES that sentence -- verified directly against the
// production table -- so claimedCompletion was true. Yet no
// live_claim_unbacked_by_action, no note, no correction. Nothing in the logs
// can say why, because the claim family is process-global and the per-call
// summary does not carry it.
//
// Ruled out from the call record before writing this:
//   - the detector. It matches.
//   - end_call being counted as an action tool. It is not in ACTION_TOOL_NAMES.
//   - LIVE_CLAIM_GUARD=off. Not set on the revision.
//
// So this is the instrument that can answer it: drive the exact turn shape and
// watch the counter. Both orderings, because the log cannot say which one it
// was -- the cancel and end_call are three seconds apart and a turn boundary
// may or may not sit between them.
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
  const sent = { clientContent: [] };
  let onmessage = null;
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: (m) => sent.clientContent.push(m),
          sendToolResponse: () => {},
          close: () => {},
        },
        languagePinned: true,
        surface: "aistudio",
        model: "gemini-3.8-live",
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
      allowedTasks: ["general_question", "take_message", "book_appointment", "cancel_appointment"],
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

/** Verbatim from live_debug_assistant_turn, 02:17:48. Do not tidy it. */
const FALSE_CLAIM =
  "I have cancelled your existing appointment on Friday, September eighteenth at four thirty PM. " +
  "Thanks for calling Digile Media, and have a wonderful day.";

let toolId = 0;

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  // The consent gate's shape: an action tool REFUSED. success:false on the
  // functionResponse is what every refusal path sets, and it is what the runner
  // reads to count a refusal.
  const execute = vi.fn(async (fc) => {
    if (fc.name === "cancel_appointment_db") {
      return {
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: { success: false, message: "The caller has not agreed to this yet." },
        },
        stateEffects: { toolResult: { name: fc.name, success: false, message: "refused" } },
      };
    }
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message: "ok" },
        ...(fc.name === "end_call" ? { endCallArgs: fc.args ?? {} } : {}),
      },
    };
  });

  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
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
  return {
    live,
    settle,
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    async callTool(...names) {
      live.push({
        toolCall: {
          functionCalls: names.map((name) => ({ id: `t${(toolId += 1)}`, name, args: {} })),
        },
      });
      await settle();
    },
  };
}

const unbacked = () => getLatencyStats().turnTaking.live_claim_unbacked_by_action;
const notes = (live) => live.sent.clientContent.slice(1);

describe("a false claim made on the way out of the call", () => {
  beforeEach(() => clearStats());

  it("fires when the refused action and the claim are on the SAME turn", async () => {
    const s = await boot();
    await s.callTool("cancel_appointment_db", "end_call");
    s.say(FALSE_CLAIM);
    s.endTurn();
    await s.settle();

    expect(unbacked()).toBe(1);
  });

  it("fires when the refused action was the PREVIOUS turn", async () => {
    const s = await boot();
    await s.callTool("cancel_appointment_db");
    s.endTurn();
    await s.settle();

    await s.callTool("end_call");
    s.say(FALSE_CLAIM);
    s.endTurn();
    await s.settle();

    expect(unbacked()).toBe(1);
  });

  it("still sends the correction, silently, rather than suppressing it as a sign-off", async () => {
    // signOffRestatement exists for a model RE-STATING work it really did on
    // the way out. Nothing was done here, so it must not absorb this.
    const s = await boot();
    await s.callTool("cancel_appointment_db", "end_call");
    s.say(FALSE_CLAIM);
    s.endTurn();
    await s.settle();

    const frame = notes(s.live).find((m) => /no tool has run to make it so/.test(m.turns[0].parts[0].text));
    expect(frame).toBeTruthy();
    expect(frame.turnComplete).toBe(false);
  });
});
