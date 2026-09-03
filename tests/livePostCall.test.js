import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX29's wiring, which is the half that a unit test of the module cannot
// reach: does a finished Live call actually hand the post-call read the right
// two ledgers?
//
// The module is tested in tests/postCallVerify.test.js. What is asserted HERE
// is only what the call itself contributes -- that a claim reaches the claim
// ledger as a shape, that a booked effect reaches the write ledger, that both
// survive to `finish`, and that the whole thing stays off unless
// POSTCALL_VERIFY says otherwise.
//
// It cannot tell you whether the confirmation is right. Only a phone call
// does that, and every defect in this front-end so far was found by one.
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
    loadConfig: () => ({
      businessId: "biz-1",
      businessName: "Digile Media",
      timezone: "Europe/London",
      allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
      capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
      businessHours: {},
    }),
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-row-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

let toolId = 0;

// Naive local wall clock, which is the round-trip contract the availability
// invariant keys on (lib/voice/live/guards.js slotKey). A booking is REFUSED
// until an availability response has put this exact key on the record.
const SLOT = "2026-09-07T10:00:00";

async function boot(env = { POSTCALL_VERIFY: "count" }) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const verify = vi.fn(async () => ({ verdict: "ok" }));

  const execute = vi.fn(async (fc) => {
    if (fc.name === "check_appointment_availability") {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { open_times: [SLOT] } },
        stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
      };
    }
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message: "ok" },
        capabilityEffects:
          fc.name === "book_appointment"
            ? [{ capability: "appointments", type: "booked", data: { client_name: "Marcus Bell" } }]
            : [
                {
                  capability: "appointments",
                  type: "changed",
                  data: { tool: fc.name, appointmentId: "appt-9" },
                },
              ],
      },
    };
  });

  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    env,
    execute,
    verify,
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
    verify,
    settle,
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    async callTool(name, args = { appointment_id: "appt-9" }) {
      live.push({
        toolCall: { functionCalls: [{ id: `t${(toolId += 1)}`, name, args }] },
      });
      await settle();
    },
    /** A booking that clears the availability invariant, as a real one must. */
    async book() {
      await this.callTool("check_appointment_availability", { requested_at: SLOT });
      await this.callTool("book_appointment", { scheduled_at: SLOT, client_name: "Marcus Bell" });
    },
    async hangUp() {
      ws.deliver({ event: "stop" });
      await settle();
    },
  };
}

const arg = (verify) => verify.mock.calls[0][0];

describe("the post-call read gets what the call knew", () => {
  beforeEach(() => clearStats());

  it("hands over the tenant, the call row and the mode", async () => {
    const s = await boot();
    await s.hangUp();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(arg(s.verify)).toMatchObject({
      businessId: "biz-1",
      callId: "call-row-1",
      mode: "count",
      callSid: "CA1",
    });
  });

  it("records a completion claim as a shape, never as the sentence", async () => {
    const s = await boot();
    s.say("I've booked your appointment for Monday the 7th at ten AM, Marcus.");
    s.endTurn();
    await s.settle();
    await s.hangUp();

    const { claims } = arg(s.verify);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: "claim", toolBacked: false });
    expect(JSON.stringify(claims)).not.toMatch(/Marcus/);
    expect(JSON.stringify(claims)).not.toMatch(/ten AM/);
  });

  it("records a claim the guard stays silent on, because a tool ran", async () => {
    const s = await boot();
    await s.book();
    s.say("That's booked for you.");
    s.endTurn();
    await s.settle();
    await s.hangUp();

    const { claims } = arg(s.verify);
    expect(claims).toHaveLength(1);
    expect(claims[0].toolBacked).toBe(true);
  });

  // ------------------------------------------------------------------
  // The hole in the turn-level claim guard, pinned.
  //
  // `realToolCallsThisTurn` is incremented for ATTEMPTED calls, before
  // guards.before() can refuse one (lib/voice/live/index.js:1155). So a model
  // whose booking the availability invariant refuses, and which then tells the
  // caller it is booked, does NOT trip live_claim_without_action -- and a
  // refused booking is one of the production routes the LVX27 entry itself
  // named.
  //
  // The post-call read is what closes it: the claim reaches the ledger anyway,
  // and the database has no row to back it.
  // ------------------------------------------------------------------
  it("records a claim behind a REFUSED tool call, which the turn guard misses", async () => {
    const s = await boot();
    await s.callTool("book_appointment", { scheduled_at: SLOT });
    s.say("All set — you're booked for Monday at ten.");
    s.endTurn();
    await s.settle();
    await s.hangUp();

    const { claims, writes } = arg(s.verify);
    expect(claims).toHaveLength(1);
    expect(claims[0].toolBacked).toBe(true);
    expect(writes).toEqual([]);
  });

  it("records what was written, by kind", async () => {
    const s = await boot();
    await s.book();
    await s.callTool("cancel_appointment_db");
    await s.hangUp();

    expect(arg(s.verify).writes).toEqual([
      { type: "booked", tool: "book_appointment" },
      { type: "changed", tool: "cancel_appointment_db", appointmentId: "appt-9" },
    ]);
  });

  it("keeps the write ledger after the reducer has drained the pending effects", async () => {
    const s = await boot();
    await s.book();
    // A completed turn is what drains pendingCapabilityEffects. The ledger
    // must not drain with it, or every call that ends normally reports having
    // written nothing.
    s.say("Done.");
    s.endTurn();
    await s.settle();
    await s.hangUp();

    expect(arg(s.verify).writes).toHaveLength(1);
  });

  it("runs once, not once per close path", async () => {
    const s = await boot();
    await s.hangUp();
    await s.hangUp();

    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it("stays off unless POSTCALL_VERIFY says otherwise", async () => {
    const s = await boot({});
    await s.book();
    await s.hangUp();

    expect(s.verify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// VOICE_INTENT_MARKER must never reach this front-end.
//
// Marker mode asks the model to write <<intent:...>> inline instead of calling
// set_call_intent. The cascade strips it before TTS; here the model IS the
// voice, so it is spoken aloud, the leak guard cuts the audio, and the call
// dies in an apologise-and-repeat loop. Observed on staging 2026-09-03:
// turns 0, usage.audio_out 13, caller hears silence.
//
// The env var is UNSET on the development laptop, which is why fourteen real
// calls there produced zero leaks and this reached a deployment undetected.
// That is exactly why it is pinned by a test and not by a comment.
// ---------------------------------------------------------------------------
describe('marker mode is forced off', () => {
  const OLD = process.env.VOICE_INTENT_MARKER;
  afterEach(() => {
    if (OLD === undefined) delete process.env.VOICE_INTENT_MARKER;
    else process.env.VOICE_INTENT_MARKER = OLD;
  });

  it('does not declare the marker intent tool even with VOICE_INTENT_MARKER=true', async () => {
    process.env.VOICE_INTENT_MARKER = 'true';
    const { buildLiveTools } = await import('../lib/voice/live/tools.js');
    const config = { businessName: 'X', timezone: 'America/Chicago', allowedTasks: ['general_question'], capabilities: {}, businessHours: {} };

    const withMarker = buildLiveTools(config, {})[0].functionDeclarations.map((d) => d.name);
    const forcedOff = buildLiveTools(config, { intentMarker: false })[0].functionDeclarations.map((d) => d.name);

    // The env var alone changes the declarations; extras.intentMarker overrides it.
    expect(forcedOff).toContain('set_call_intent');
    expect(JSON.stringify(forcedOff)).not.toMatch(/intent_marker/i);
    expect(withMarker).toBeDefined();
  });

  // The one that would have caught this. A source grep would pass on a comment;
  // this asserts the prompt the model is actually handed.
  it('keeps the marker out of the system prompt even with the env var on', async () => {
    process.env.VOICE_INTENT_MARKER = 'true';
    const { buildSystemInstruction } = await import('../services/gemini.js');
    const { STEPS } = await import('../lib/callState.js');
    const config = {
      businessName: 'Brightwork Family Dental',
      timezone: 'America/Chicago',
      allowedTasks: ['general_question', 'book_appointment'],
      capabilities: { appointments: { enabled: true } },
      businessHours: {},
    };

    // The cascade: the env var alone turns marker mode on, and that is correct
    // there because getReplyStreaming strips the marker before TTS.
    const cascade = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, config, {});
    // The Live path: extras.intentMarker wins over the env var.
    const live = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, config, { intentMarker: false });

    expect(cascade).toMatch(/<<intent:/);
    expect(live).not.toMatch(/<<intent:/);
  });
});
