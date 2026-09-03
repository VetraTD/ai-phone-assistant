import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { STEPS } from "../lib/callState.js";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// Regressions introduced BY the previous round of fixes.
//
// A second review of the fix commits found fifteen more defects, roughly six of
// them created while closing the first fifteen. That ratio is the finding: this
// file is dense wiring between modules that are each individually correct, and
// every change to it has been about as likely to break a seam as to mend one.
//
// The two worst were both one-line guards added in good faith:
//
//   `if (verdict.isEcho) return;`      returned out of the WHOLE serverContent
//                                      handler, so an echo message that also
//                                      carried turnComplete skipped the reducer
//                                      and skipped the hang-up.
//   `if (forward.length === 0) return;` starved the turn-end strategy of every
//                                      frame during playback, leaving its timer
//                                      stale and firing a fabricated turn close
//                                      after every single reply.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.authorizedCallSid = null;
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
  marks() {
    return this.sent.filter((m) => m.event === "mark").map((m) => m.mark?.name);
  }
}

function fakeLive() {
  const sent = { realtime: [], toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: (m) => sent.realtime.push(m),
    sendClientContent: () => {},
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (m) => onmessage?.(m),
  };
}

const BASE_CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message", "book_appointment", "transfer_human"],
  capabilities: { messages: { enabled: true }, appointments: { enabled: true } },
  businessHours: {},
  transferPolicy: "always",
};

function fakeDb(config = BASE_CONFIG) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: "biz-1" }),
    loadConfig: () => config,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    markCallTransferred: async () => {},
  };
}

function modelAudio(ms = 2000) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

const VOICED = Buffer.alloc(160, 0x00).toString("base64");
const SILENCE = Buffer.alloc(160, 0xff).toString("base64");

async function boot({ env = {}, config, execute, twilioClient } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: fakeDb(config),
    env,
    ...(execute ? { execute } : {}),
    ...(twilioClient ? { twilioClient } : {}),
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  return {
    ws,
    live,
    feed: (payload, frames = 1) => {
      for (let i = 0; i < frames; i++) {
        clock += 20;
        ws.deliver({ event: "media", media: { payload } });
      }
    },
    speak: (ms) => live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } }),
    advance: (ms) => (clock += ms),
  };
}

const toolReturning = (stateEffects) => async (fc) => ({
  functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
  stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" }, ...stateEffects },
});

describe("an echo that arrives in the same message as turnComplete", () => {
  it("still ends the turn", async () => {
    // `return` inside the handler skipped everything after the transcript
    // block, so a serverContent carrying BOTH an echoed transcript and
    // turnComplete never ran the reducer.
    const { ws, live } = await boot();
    const said = "Thanks for calling Digile Media, how can I help?";
    live.push({ serverContent: { outputTranscription: { text: said } } });
    await new Promise((r) => setImmediate(r));

    live.push({ serverContent: { inputTranscription: { text: said }, turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    // The reducer ran: the assistant's own line is in history as a model turn.
    expect(ws.liveState.history.some((h) => h.role === "model")).toBe(true);
  });

  it("still hangs up when end_call was armed", async () => {
    // The severe half. The model says goodbye, calls end_call, and the goodbye
    // echoes back in the same message that completes the turn -- the line then
    // never closed at all.
    const { ws, live } = await boot({ execute: toolReturning({ endCallArgs: {} }) });
    const bye = "Thanks for calling, goodbye.";
    live.push({ toolCall: { functionCalls: [{ id: "t1", name: "end_call", args: {} }] } });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    live.push({ serverContent: { outputTranscription: { text: bye } } });
    await new Promise((r) => setImmediate(r));

    live.push({ serverContent: { inputTranscription: { text: bye }, turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(ws.marks().length).toBeGreaterThan(0);
  });
});

describe("the turn-end strategy across a reply", () => {
  it("does not fabricate a turn close when playback ends", async () => {
    // Skipping onFrame entirely during playback left lastVoicedMs stale and
    // turnOpen true, so the first silent frame after a four-second reply
    // measured a four-second "caller pause" and closed a turn nobody took --
    // inflating callerTurnCount (which unlocks end_call) and writing a
    // fabricated latency sample into the one number the vendor arm exists to
    // produce.
    // Observed through activityEnd in a MANUAL arm, where a turn close is
    // visible on the wire. One caller utterance must produce exactly one.
    const { live, feed, speak } = await boot({ env: { LIVE_TURN_END: "hangover" } });

    feed(VOICED, 10); // caller speaks
    feed(SILENCE, 70); // ...and stops: one legitimate close at the hangover
    speak(2000);
    await new Promise((r) => setImmediate(r));
    feed(SILENCE, 100); // 2s of playback, inbound withheld
    feed(SILENCE, 100); // and quiet afterwards

    const ends = live.sent.realtime.filter((m) => m.activityEnd);
    expect(ends).toHaveLength(1);
  });
});

describe("an exit queued behind audio that then gets cleared", () => {
  it("does not leave the caller in silence waiting for a mark that will never arrive", async () => {
    // audioOut.clear() empties the queue AND outstandingMarks, so the exit mark
    // never reaches the wire and Twilio never echoes it. The exit then waited
    // the full fallback -- fifteen seconds of dead air after a goodbye.
    const { ws, live, speak } = await boot({ execute: toolReturning({ endCallArgs: {} }) });
    live.push({ toolCall: { functionCalls: [{ id: "t1", name: "end_call", args: {} }] } });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    speak(4000);
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    live.push({ serverContent: { interrupted: true } });
    await new Promise((r) => setImmediate(r));

    expect(ws.readyState).not.toBe(1);
  });
});

describe("transfer with no number configured", () => {
  it("is not offered at all, rather than promised and then dropped", async () => {
    // resolveTransferAllowed alone says "policy permits it". The cascade also
    // requires a number to dial: canTransfer = !!transferNumber && policy.
    // Without that the prompt promises a transfer, the tool succeeds, and the
    // redial disconnects the caller mid-promise.
    // The visible harm: the model promises a transfer, the redial has nothing
    // to dial, and the caller is disconnected mid-promise instead of being
    // told it is unavailable.
    const updates = [];
    const { ws, live } = await boot({
      config: { ...BASE_CONFIG, transferPhoneNumber: null },
      twilioClient: { calls: () => ({ update: async (o) => updates.push(o) }) },
      execute: toolReturning({ transferRequested: { reason: "x" } }),
    });
    live.push({ toolCall: { functionCalls: [{ id: "t1", name: "request_transfer", args: {} }] } });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(updates).toHaveLength(0);
    expect(ws.readyState).toBe(1);
  });
});

describe("call state seeding", () => {
  it("starts where the reducer can actually advance it", async () => {
    // applyReplyState only promotes from IDENTIFY_INTENT or CONFIRM. Seeded at
    // GREETING, set_call_intent left the step at "greeting" for the whole call
    // and every tool saw step "greeting".
    const { ws } = await boot();

    expect(ws.liveState.step).toBe(STEPS.IDENTIFY_INTENT);
  });
});

describe("a turn abandoned by an interruption", () => {
  it("does not fold its half-spoken reply into the next turn", async () => {
    // No generationComplete follows an abandoned turn, so applyTurn never ran
    // and turnReplyText kept the partial sentence -- which was then pushed into
    // history as words said on the NEXT turn, and re-tested against
    // spellRequestRe, double-counting the spelling ask against its own cap.
    const { ws, live, speak } = await boot();
    speak(2000);
    live.push({ serverContent: { outputTranscription: { text: "Could you spell that for me" } } });
    await new Promise((r) => setImmediate(r));

    live.push({ serverContent: { interrupted: true } });
    await new Promise((r) => setImmediate(r));

    live.push({ serverContent: { outputTranscription: { text: "Certainly, one moment." }, turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    const modelTurns = ws.liveState.history.filter((h) => h.role === "model");
    expect(modelTurns.some((h) => /spell that for me/.test(h.parts?.[0]?.text || ""))).toBe(false);
  });
});

describe("one spoken turn is one reducer turn", () => {
  it("does not apply twice when generationComplete and turnComplete both arrive", async () => {
    // Gemini emits them as distinct messages. Folding on both pushed two model
    // entries into history for one spoken turn and counted one spelling
    // question as two against the cap.
    // The trailing chunk between the two is what makes the second fold
    // non-empty: outputAudioTranscription lags the audio it transcribes.
    const { ws, live } = await boot();
    live.push({ serverContent: { outputTranscription: { text: "Could you spell that" } } });
    live.push({ serverContent: { generationComplete: true } });
    live.push({ serverContent: { outputTranscription: { text: " for me please?" } } });
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(ws.liveState.spellAsks).toBe(1);
    expect(ws.liveState.history.filter((h) => h.role === "model")).toHaveLength(1);
  });
});
