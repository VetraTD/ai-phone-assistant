import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX70 -- a short answer ("okay", "no") does not end a turn, so the caller
// gets ten seconds of silence and then "I'm still here whenever you're ready."
// Four times on one call.
//
// The entry was nearly settled on the wrong evidence. It read:
//
//   "Nothing on our side discarded it (echo_suppressed_interim and
//    echo_suppressed_final are both 0)"
//
// Neither counter can see the audio path. echo_suppressed_interim is bumped
// only by lib/voice/session.js and is structurally zero on EVERY Live call ever
// made; echo_suppressed_final compares transcript CONTENT against what we just
// said. The one thing that actually discards caller audio here -- the
// half-duplex gate -- had no counter at all, and `forward.length` was computed
// at the call site and thrown away.
//
// This file pins the instrument that settles it. The unit under test is the raw
// VAD episode, NOT the strategy's turn, and that choice is the whole point: when
// every frame of an utterance is withheld, the strategy is handed unvoiced
// frames, so no turn opens and no turn closes. Measuring with a unit that only
// exists once a turn opens would report nothing at all for the exact case in
// question.
//
// What each test would look like if the instrument regressed: every one of them
// reads 0, which is indistinguishable from a clean call. That is why
// live_utterance_observed exists.
// ---------------------------------------------------------------------------

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
  businessName: "Brightwork Family Dental",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  allowedTasks: ["general_question", "take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
};

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Brightwork Family Dental" })),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

/** Digital silence in mu-law. */
const SILENCE = Buffer.alloc(160, 0xff).toString("base64");
/** Full-scale mu-law, well above inboundVad's 700 floor. */
const VOICED = Buffer.alloc(160, 0x00).toString("base64");

function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  let clock = 0;
  await handleLiveSessionConnection(
    ws,
    {},
    {
      now: () => clock,
      connect: live.connect,
      database: fakeDb(),
      env: {},
      execute: vi.fn(async (fc) => ({
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
      })),
    }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_utt", streamSid: "MZ1", customParameters: { businessPhone: "+18176011171" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  const feed = (payload, ms) => {
    const frames = Math.round(ms / 20);
    for (let i = 0; i < frames; i++) {
      clock += 20;
      ws.deliver({ event: "media", media: { payload } });
    }
  };

  return {
    ws,
    live,
    /** Our own audio, long enough that the caller talks over it. */
    speak: (ms) => live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } }),
    /**
     * Sustained caller speech, deliberately UNDER the 300 ms barge threshold.
     * "Okay" and "No" are this long. "Yes." ended a turn correctly on the same
     * call, which is why length alone was never the explanation.
     */
    talk: (ms) => feed(VOICED, ms),
    quiet: (ms) => feed(SILENCE, ms),
    transcript: (text) => live.push({ serverContent: { inputTranscription: { text } } }),
    /** ws close is what runs finish(), which drains the pending records. */
    hangup: () => ws.emit("close"),
  };
}

const c = () => getLatencyStats().turnTaking;

describe("LVX70 -- what the vendor was actually given, per caller utterance", () => {
  beforeEach(() => clearStats());

  it("counts a short answer spoken over our own audio as never delivered", async () => {
    const s = await boot();
    s.speak(3000);
    // 280 ms of speech: past inboundVad's 200 ms activation, short of the
    // 300 ms sustained run the half-duplex gate requires before it will treat
    // the caller as interrupting. This is the exact window "okay" falls in.
    s.talk(280);
    s.quiet(600);

    expect(c().live_utterance_observed).toBe(1);
    expect(c().live_utterance_all_withheld).toBe(1);
  });

  it("counts the SAME utterance as delivered when nothing of ours is playing", async () => {
    const s = await boot();
    s.talk(280);
    s.quiet(600);

    expect(c().live_utterance_observed).toBe(1);
    // The discriminator the entry could not find. "Ah!" is the shortest
    // utterance on the call and ended four turns correctly -- plausibly because
    // it landed after playback, where this gate does not apply.
    expect(c().live_utterance_all_withheld).toBe(0);
  });

  it("reads zero on the positive counter when no caller speech happened at all", async () => {
    const s = await boot();
    s.quiet(2000);

    // Not a pass. A fault-only instrument cannot tell this call from a clean
    // one, and that ambiguity is what LVX45 turned out to be.
    expect(c().live_utterance_observed).toBe(0);
    expect(c().live_utterance_all_withheld).toBe(0);
  });

  it("counts an episode nothing ever transcribed, at the end of the call", async () => {
    const s = await boot();
    s.talk(280);
    s.quiet(600);
    s.hangup();

    expect(c().live_utterance_observed).toBe(1);
    expect(c().live_utterance_no_transcript).toBe(1);
    expect(c().live_utterance_late_transcript).toBe(0);
  });

  it("does not call a transcript inside the measured lag band late", async () => {
    const s = await boot();
    s.talk(280);
    s.quiet(300);
    s.transcript("okay");
    s.quiet(200);
    s.hangup();

    expect(c().live_utterance_observed).toBe(1);
    expect(c().live_utterance_no_transcript).toBe(0);
    expect(c().live_utterance_late_transcript).toBe(0);
  });

  it("releases withheld speech once our own audio finishes", async () => {
    // LVX70's fix, end to end. The caller answers over the top of a short
    // reply; playback ends while they are still within the 500 ms ring, and the
    // words reach the vendor instead of being discarded.
    const s = await boot();
    s.speak(200);
    s.talk(280);
    s.quiet(600);

    expect(c().live_gate_speech_released).toBeGreaterThan(0);
  });

  it("does not blame the vendor for a transcript that could not exist", async () => {
    // CORRECTED after call 1. An utterance whose audio was never forwarded can
    // never be transcribed, so counting it as no_transcript blames the vendor
    // for our own gate -- the exact confusion this instrument exists to end.
    // It is already counted, once, by live_utterance_all_withheld.
    const s = await boot();
    s.speak(3000);
    s.talk(280);
    s.quiet(600);
    s.hangup();

    expect(c().live_utterance_all_withheld).toBe(1);
    expect(c().live_utterance_no_transcript).toBe(0);
  });

  it("counts a transcript that arrives seconds later, which is the held-turn signature", async () => {
    const s = await boot();
    s.talk(280);
    s.quiet(600);
    // The observed case: the word surfaced 28 seconds later, merged into the
    // front of the next utterance. Measured transcript lag on this path is
    // 113-360 ms, so this is not a slow transcript.
    s.quiet(5000);
    s.transcript("okay. hello");
    s.hangup();

    expect(c().live_utterance_observed).toBe(1);
    expect(c().live_utterance_late_transcript).toBe(1);
    expect(c().live_utterance_no_transcript).toBe(0);
  });
});
