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

// `refuse` names tools this run should answer with success:false, for the
// abandoned-write case (LVX72). Everything else behaves as before.
async function boot(env = { POSTCALL_VERIFY: "count" }, refuse = [], database = fakeDb()) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const verify = vi.fn(async () => ({ verdict: "ok" }));
  // Order matters and is asserted below: recovery runs BEFORE verify, so that a
  // booking it manages to make is a row verify then reads as clean.
  const order = [];
  const recover = vi.fn(async () => {
    order.push("recover");
    return { ran: false, booked: false };
  });

  const execute = vi.fn(async (fc) => {
    if (refuse.includes(fc.name)) {
      return {
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: { success: false, message: "[not caller speech] needs a spelling first" },
        },
        stateEffects: { toolResult: { name: fc.name, success: false, message: "One moment." } },
      };
    }
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
            ? [
                {
                  capability: "appointments",
                  type: "booked",
                  // `id` matters: the post-call sender uses it to tell an
                  // appointment already confirmed at booking time from one never
                  // confirmed at all. A stub without it cannot distinguish a
                  // working wire from the null that made that suppression silently
                  // do nothing.
                  data: { id: "appt-booked-1", client_name: "Marcus Bell" },
                },
              ]
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
    database,
    env,
    execute,
    verify: vi.fn(async (...a) => {
      order.push("verify");
      return verify(...a);
    }),
    recover,
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
    recover,
    order,
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
  // A claim behind a REFUSED tool call. LVX31.
  //
  // This test used to assert `toolBacked: true` here, and it was RIGHT to: it
  // pinned the hole. `realToolCallsThisTurn` counted ATTEMPTED calls, so a
  // model whose booking the availability invariant refused, and which then told
  // the caller it was booked, did not trip live_claim_without_action -- and the
  // ledger recorded the claim as tool-backed when nothing had run.
  //
  // Seen on a real deployed call on 2026-09-03, the other way round: the
  // spelling gate refused a write, the assistant claimed something was done,
  // postcall_claim_without_row fired and live_claim_without_action stayed 0.
  //
  // Closed 2026-09-03 by counting tools that actually EXECUTED. The assertion
  // is inverted deliberately: `toolBacked` is now false, which is what it
  // always should have said.
  //
  // The post-call read still matters and is not made redundant. It asks a
  // different question -- did the database end up holding what the caller was
  // told -- and it survives a claim that trails its tool by more than a turn.
  // ------------------------------------------------------------------
  it("records a claim behind a REFUSED tool call as NOT tool-backed", async () => {
    const s = await boot();
    await s.callTool("book_appointment", { scheduled_at: SLOT });
    s.say("All set — you're booked for Monday at ten.");
    s.endTurn();
    await s.settle();
    await s.hangUp();

    const { claims, writes } = arg(s.verify);
    expect(claims).toHaveLength(1);
    expect(claims[0].toolBacked).toBe(false);
    expect(writes).toEqual([]);
  });

  it("records what was written, by kind", async () => {
    const s = await boot();
    await s.book();
    await s.callTool("cancel_appointment_db");
    await s.hangUp();

    expect(arg(s.verify).writes).toEqual([
      // appointmentId is the field the post-call duplicate suppression reads. It
      // was absent, so that suppression matched nothing and every booking was
      // lined up for two confirmations once the mode allowed sending.
      { type: "booked", tool: "book_appointment", appointmentId: "appt-booked-1" },
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

// ---------------------------------------------------------------------------
// LVX72 -- a refused write that was never retried has to reach the post-call
// read, and the WIRE is what this asserts.
//
// lib/postCallVerify.js has its own tests for the verdict. Those would pass
// with nothing connected to them, which is exactly how LVX45 sat in the tree
// for a day: the producer had a test, the consumer had a test, and nothing
// tested that they were joined.
// ---------------------------------------------------------------------------
describe("abandoned writes reach the post-call read", () => {
  it("reports a tool that was refused and never completed", async () => {
    const s = await boot({ POSTCALL_VERIFY: "count" }, ["correct_appointment_name"]);
    await s.book();
    await s.callTool("correct_appointment_name", { client_name: "Nathan Dodla", appointment_id: "appt-9" });
    s.say("So that's Nathan Dodla for the crown on the 10th.");
    s.endTurn();
    await s.settle();
    await s.hangUp();

    expect(s.verify).toHaveBeenCalled();
    expect(s.verify.mock.calls[0][0].abandoned).toEqual(["correct_appointment_name"]);
  });

  it("reports nothing when the refused tool was afterwards retried", async () => {
    // A refusal the model acted on is the system working. The spelling gate
    // refuses on purpose and the retry is the whole point of its wording.
    const s = await boot({ POSTCALL_VERIFY: "count" }, []);
    await s.book();
    await s.callTool("correct_appointment_name", { client_name: "Nathan Dodla", appointment_id: "appt-9" });
    await s.hangUp();

    expect(s.verify.mock.calls[0][0].abandoned).toEqual([]);
  });

  it("ignores a refused LOOKUP, which is not a write at all", async () => {
    const s = await boot({ POSTCALL_VERIFY: "count" }, ["check_appointment_availability"]);
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.hangUp();

    expect(s.verify.mock.calls[0][0].abandoned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE RECOVERY WIRE. lib/postCallRecover.js can only choose among the times this
// call confirmed open, and that set lives in the engine's guards closure -- it is
// the one thing the status webhook cannot get hold of later, which is why the
// acting rung runs at teardown instead.
//
// So this asserts the wire, not the decision. A slot list produced here and never
// copied would leave the recovery with nothing to choose from on every call, it
// would decline every time, and the counter would read zero exactly as it does on
// a call that owed nothing. That is the shape of bug this repository has shipped
// twice -- lastCallerText and the hang-up gate, both for the life of a deployment.
// ---------------------------------------------------------------------------
describe("the recovery gets the times this call confirmed open", () => {
  it("passes the verified slot list, not a count", async () => {
    const s = await boot({ POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "act" });
    await s.book();
    await s.hangUp();

    expect(s.recover).toHaveBeenCalledTimes(1);
    const passed = s.recover.mock.calls[0][0];
    // The availability response put this exact key on the record, minute
    // precision, naive local -- guards.slotKey's contract.
    expect(passed.slots).toContain("2026-09-07T10:00");
    expect(passed.mode).toBe("act");
    expect(passed.businessId).toBe("biz-1");
    expect(passed.callId).toBe("call-row-1");
  });

  it("stays off unless POSTCALL_JUDGE says act", async () => {
    // The gate is the judge's own mode, so turning the post-call READ on cannot
    // start authoring a booking.
    const s = await boot({ POSTCALL_VERIFY: "count" });
    await s.book();
    await s.hangUp();
    expect(s.recover.mock.calls[0][0].mode).toBe("off");
  });

  it("runs BEFORE verify, so a recovered booking is a row verify can see", async () => {
    // The ordering is the whole design: recovery first means verifyCall reads a
    // call that HAS a row and sends the caller its confirmation off that row,
    // and the escalation it would otherwise raise becomes the fallback for a
    // recovery that could not fire -- with no branch anywhere saying so.
    const s = await boot({ POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "act" });
    await s.book();
    await s.hangUp();
    expect(s.order).toEqual(["recover", "verify"]);
  });

  it("still verifies when the recovery rejects", async () => {
    // A recovery that failed is exactly when the escalation matters most, so it
    // must not be able to take verify down with it.
    const s = await boot({ POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "act" });
    s.recover.mockRejectedValueOnce(new Error("model unreachable"));
    await s.book();
    await s.hangUp();
    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it("waits for the last transcript row to settle before reading it", async () => {
    // persistTranscriptRows is fire-and-forget by design -- a turn must not
    // block on a database round trip. But finish() runs while the LAST turn's
    // rows are still in flight, and THE LAST TURN IS WHERE THE AGREEMENT AND
    // THE CLAIM LIVE. A recovery that reads then sees a transcript missing
    // exactly the turns it needs, and declines `no_transcript` for a reason
    // that is not true. server.js already records this race for the status
    // callback; at teardown it is strictly worse, because nothing else is
    // keeping the call alive.
    let release;
    const db = fakeDb();
    db.addTranscriptEntry = vi.fn(() => new Promise((r) => { release = r; }));

    const s = await boot({ POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "act" }, [], db);
    s.say("I've booked that for you.");
    s.endTurn();
    await s.settle();
    await s.hangUp();

    expect(db.addTranscriptEntry).toHaveBeenCalled();
    expect(s.recover).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(s.recover).toHaveBeenCalled());
  });

  it("passes an empty list when no availability check ever ran", async () => {
    // Nothing to choose from is a legitimate outcome and the case a human still
    // has to own. It must arrive as [] rather than undefined, or the recovery's
    // own guard reads a missing wire as a missing check.
    const s = await boot({ POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "act" });
    await s.callTool("record_customer_request", { request_type: "message" });
    await s.hangUp();
    expect(s.recover.mock.calls[0][0].slots).toEqual([]);
  });
});

describe("the recovery is told whether the caller ever agreed", () => {
  it("passes agreed=false on a call with no read-back and no yes", async () => {
    // The fail-closed direction, and the one that matters: this flag is the only
    // structural consent signal the recovery has, so a wire that goes missing must
    // disable the feature rather than disable the gate.
    const s = await boot({ POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "act" });
    await s.book();
    await s.hangUp();
    expect(s.recover.mock.calls[0][0].agreed).toBe(false);
  });

  it("passes agreed=true once the caller affirms a read-back", async () => {
    const s = await boot({ POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "act" });
    // A read-back, completed, so it becomes lastReplyText.
    s.say("Just to confirm, Monday the seventh at ten in the morning. Shall I book that?");
    s.endTurn();
    await s.settle();
    // The caller answers it, and the turn closes.
    s.live.push({ serverContent: { inputTranscription: { text: "Yes." } } });
    await s.settle();
    s.say("Lovely, one moment.");
    s.endTurn();
    await s.settle();

    await s.book();
    await s.hangUp();
    expect(s.recover.mock.calls[0][0].agreed).toBe(true);
  });
});
