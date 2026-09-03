import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// Four review findings about who is speaking and when, all of which the
// per-module tests could not see because each module was correct on its own.
//
//   1. `interrupted` only flipped a flag. The vendor decided the caller had
//      interrupted, stopped generating, and seconds of abandoned reply kept
//      draining out of audioOut on top of the caller. The barge path did the
//      right thing; this one did not.
//   2. The turn-end strategy was driven by EVERY inbound frame, including the
//      ones the half-duplex gate withheld and later dropped. So a manual arm
//      could bracket activityStart/activityEnd around audio Gemini never
//      received, and ask it to answer silence.
//   3. A confirmed barge and the strategy could both send activityStart on the
//      same frame, with no activityEnd between them.
//   4. echoGuard's verdict was computed, logged, and thrown away -- the
//      transcript went to the strategy whether or not it was our own voice.
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
  events(name) {
    return this.sent.filter((m) => m.event === name);
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
    signals: () => sent.realtime.filter((m) => m.activityStart || m.activityEnd),
  };
}

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: "biz-1" }),
    loadConfig: () => ({
      businessName: "Digile Media",
      timezone: "Europe/London",
      allowedTasks: ["general_question", "take_message"],
      capabilities: { messages: { enabled: true } },
      businessHours: {},
    }),
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

/** One second of loud PCM16 @24 kHz, as the model would send it. */
function modelAudio(ms = 1000) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

const VOICED = Buffer.alloc(160, 0x00).toString("base64"); // RMS 32,124
const SILENCE = Buffer.alloc(160, 0xff).toString("base64"); // digital silence

async function boot({ env = {} } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: fakeDb(),
    env,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  const feed = (payload, frames = 1) => {
    for (let i = 0; i < frames; i++) {
      clock += 20;
      ws.deliver({ event: "media", media: { payload } });
    }
  };
  const speak = () => live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio() } }] } } });
  return { ws, live, feed, speak, advance: (ms) => (clock += ms) };
}

describe("an interruption the vendor declares", () => {
  it("stops the audio already queued, instead of playing it over the caller", async () => {
    // Gemini's detector is more sensitive than inboundVad's 700 RMS / 300 ms
    // sustained threshold, so it fires on speech our gate reads as nothing.
    // The summary counts that divergence deliberately -- but nothing acted on
    // it, and up to several seconds of abandoned reply kept playing.
    // Asserted on the pacing QUEUE rather than on a `clear` frame: a tapered
    // clear deliberately fades what is already committed instead of sending a
    // hard clear, so the wire is the wrong place to look.
    const { ws, live, speak } = await boot();
    speak();
    await new Promise((r) => setImmediate(r));
    expect(ws.liveAudioOut._queuedFrames()).toBeGreaterThan(0);

    live.push({ serverContent: { interrupted: true } });
    await new Promise((r) => setImmediate(r));

    expect(ws.liveAudioOut._queuedFrames()).toBe(0);
  });
});

describe("the turn-end strategy sees only what Gemini saw", () => {
  it("does not open a turn on audio the gate withheld", async () => {
    // A short backchannel during playback: voiced, but under the sustained
    // threshold, so the gate holds every frame and later drops them. Opening a
    // turn around them asks Gemini to answer audio it never received.
    const { live, speak, feed } = await boot({ env: { LIVE_TURN_END: "hangover" } });
    speak();
    await new Promise((r) => setImmediate(r));

    feed(VOICED, 5); // 100 ms — below the 300 ms barge threshold

    expect(live.signals()).toHaveLength(0);
  });

  it("still opens a turn on audio that was forwarded", async () => {
    // The control. Without it the assertion above passes for a gate that
    // withholds everything forever.
    const { live, feed } = await boot({ env: { LIVE_TURN_END: "hangover" } });

    feed(VOICED, 5);

    expect(live.signals().some((m) => m.activityStart)).toBe(true);
  });
});

describe("activity signals", () => {
  it("never sends two activityStarts without an activityEnd between them", async () => {
    // A barge and the strategy could both fire on the same frame. The Live API
    // rejects a second activityStart on an already-open activity, which
    // surfaces as a session close mid-call rather than as anything obviously
    // about ordering.
    const { live, speak, feed } = await boot({ env: { LIVE_TURN_END: "hangover" } });
    speak();
    await new Promise((r) => setImmediate(r));

    feed(VOICED, 40); // long enough to cross the barge threshold and keep going

    let open = false;
    for (const sig of live.signals()) {
      if (sig.activityStart) {
        expect(open).toBe(false);
        open = true;
      }
      if (sig.activityEnd) open = false;
    }
  });
});

describe("echo in the input transcript", () => {
  it("does not feed our own words back into the turn-end decision", async () => {
    // classify() correctly returns isEcho, and the verdict was logged and
    // discarded. On a speakerphone that means arm C prices the caller's turn
    // end from words the caller never said.
    const { ws, live, feed } = await boot({ env: { LIVE_TURN_END: "hold" } });
    const said = "Thank you for calling Digile Media, how can I help you today?";
    live.push({ serverContent: { outputTranscription: { text: said } } });
    await new Promise((r) => setImmediate(r));

    feed(SILENCE, 2);
    live.push({ serverContent: { inputTranscription: { text: said } } });
    // turnComplete is what runs the reducer. Without it this assertion passes
    // against an empty history and proves nothing.
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    // The reducer must not be told the caller said our own sentence.
    expect(ws.liveState.history.some((h) => h.parts?.[0]?.text === said && h.role === "user")).toBe(false);
  });

  it("still accepts a genuine caller transcript", async () => {
    const { ws, live, feed } = await boot({ env: { LIVE_TURN_END: "hold" } });
    live.push({ serverContent: { outputTranscription: { text: "How can I help you today?" } } });
    await new Promise((r) => setImmediate(r));

    feed(SILENCE, 2);
    live.push({ serverContent: { inputTranscription: { text: "I would like to book an appointment." } } });
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(
      ws.liveState.history.some((h) => h.role === "user" && /book an appointment/.test(h.parts?.[0]?.text || ""))
    ).toBe(true);
  });
});
