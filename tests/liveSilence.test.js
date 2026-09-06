import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX19 -- a silent caller was left on the line for 61 seconds, and the call
// ended only because they hung up. A caller who puts the phone down instead
// leaves the line open to the 30-minute cap, billing Gemini the whole time.
//
// The cascade nudges twice and then says goodbye and hangs up. None of that
// existed here: buildSilenceNudge, the ladder and the silence hang-up were all
// cascade-only.
//
// Three things this had to get right, each of which is a real trap:
//
//   1. NO TIMER. Twilio streams media frames during silence too, so
//      onMediaFrame is already a 20 ms clock. The only setTimeout on this path
//      is the exit backstop, and it should stay that way.
//   2. The clock cannot start at socket open. live.connect() costs ~2.2 s on
//      every call (LVX17) and the caller has not been greeted yet, so a ladder
//      armed at open counts the vendor's handshake as the caller's silence.
//   3. The last rung must arm the exit BEHIND the goodbye, not call finish().
//      audioOut paces frames to Twilio and holds the rest locally, so hanging
//      up when the model stops generating throws away the goodbye it just
//      said.
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
  const sent = { clientContent: [], toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: (m) => sent.clientContent.push(m),
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
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
  allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
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

/** Digital silence in mu-law. */
const SILENCE = Buffer.alloc(160, 0xff).toString("base64");
/** Full-scale alternating mu-law, well above inboundVad's floor. */
const VOICED = Buffer.alloc(160, 0x00).toString("base64");

function modelAudio(ms = 400) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  let clock = 0;
  const execute = vi.fn(async (fc) => ({
    functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
    stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
  }));
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
    execute,
    settle: () => new Promise((r) => setImmediate(r)),
    /** The greeting reaching the caller is what arms the ladder. */
    greet: () => live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio() } }] } } }),
    speakAudio: (ms = 3000) => live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    quiet: (ms) => feed(SILENCE, ms),
    talk: (ms) => feed(VOICED, ms),
    markPlayed: (name) => ws.deliver({ event: "mark", mark: { name } }),
  };
}

const notes = (live) => live.sent.clientContent.slice(1).map((m) => m.turns[0].parts[0].text);

describe("LVX19 silence ladder", () => {
  beforeEach(() => clearStats());

  it("does not count the connect handshake as the caller's silence", async () => {
    const s = await boot();
    // No greeting audio yet: on this path the caller has heard nothing at all,
    // and live.connect() alone costs ~2.2 s on every call.
    s.quiet(20_000);

    expect(notes(s.live)).toHaveLength(0);
    expect(getLatencyStats().turnTaking.nudges_fired).toBe(0);
  });

  it("nudges once the caller has been quiet past the first threshold", async () => {
    const s = await boot();
    s.greet();
    s.quiet(7_000);

    expect(getLatencyStats().turnTaking.nudges_fired).toBe(1);
    expect(notes(s.live)[0]).toContain("I'm still here whenever you're ready.");
  });

  it("speaks the business's own second-stage wording, not a hardcoded line", async () => {
    const s = await boot();
    s.greet();
    s.quiet(13_000);

    expect(getLatencyStats().turnTaking.nudges_fired).toBe(2);
    // step is identify_intent at this point in a call.
    expect(notes(s.live)[1]).toContain("are you calling to book an appointment");
  });

  it("says goodbye and hangs up when both nudges go unanswered", async () => {
    const s = await boot();
    s.greet();
    s.quiet(21_000);

    expect(getLatencyStats().turnTaking.silence_hangups).toBe(1);
    expect(notes(s.live)[2]).toContain("Feel free to call us back");
  });

  it("hangs up BEHIND the goodbye, not when the model stops generating", async () => {
    const s = await boot();
    s.greet();
    s.quiet(21_000);
    // The goodbye is generated, then played. The line must still be open.
    s.endTurn();
    await s.settle();
    expect(s.ws.readyState).toBe(1);

    s.markPlayed("live-exit-end_call");
    // The mark means the goodbye has PLAYED; it no longer means the socket
    // closes. HANGUP_GRACE_MS (1,500ms, matching the cascade's) now sits between
    // the two so the caller has a breath to interrupt -- added 2026-09-06, after
    // a real call closed 73ms after arming and cut the caller off mid-sentence.
    //
    // The line this test exists for is unchanged and still asserted above: the
    // hang-up waits for the goodbye to be HEARD rather than for the model to
    // stop generating.
    expect(s.ws.readyState).toBe(1);
    await new Promise((r) => setTimeout(r, 1_800));
    expect(s.ws.readyState).toBe(3);
  });

  it("starts over when the caller speaks", async () => {
    const s = await boot();
    s.greet();
    s.quiet(7_000);
    expect(getLatencyStats().turnTaking.nudges_fired).toBe(1);

    s.talk(400);
    s.quiet(5_000);

    // Still one: the ladder went back to the bottom rung.
    expect(getLatencyStats().turnTaking.nudges_fired).toBe(1);
  });

  it("does not nudge the instant its own reply finishes", async () => {
    // The defect this file was written to prevent and did not, caught on the
    // first real call. The ladder's clock reset only on the CALLER's voice, so
    // a reply longer than the first threshold left the clock already past it
    // the moment our own audio stopped. The caller heard "I'm still here
    // whenever you're ready" the instant the assistant finished speaking, five
    // times in one call -- and because a nudge tells the model to say one line
    // "and nothing else", it stopped calling tools at all and could not cancel
    // an appointment it had the tools to cancel.
    const s = await boot();
    s.greet();
    s.speakAudio(8_000);
    s.quiet(9_000); // 8 s of that is our own audio; 1 s is real silence

    expect(getLatencyStats().turnTaking.nudges_fired).toBe(0);
  });

  it("does not nudge over its own voice", async () => {
    const s = await boot();
    s.greet();
    s.speakAudio();
    s.quiet(2_000);

    expect(getLatencyStats().turnTaking.nudges_fired).toBe(0);
  });

  it("holds off, and says so, while a tool call is still running", async () => {
    const s = await boot();
    s.greet();
    // A tool that never resolves: the model is thinking, and the caller cannot
    // tell that from a dead line -- but a nudge here talks over the answer.
    let release;
    s.execute.mockImplementationOnce(
      () => new Promise((r) => {
        release = () => r({ functionResponse: { id: "t", name: "record_customer_request", response: { success: true } } });
      })
    );
    s.live.push({ toolCall: { functionCalls: [{ id: "t", name: "record_customer_request", args: {} }] } });
    await s.settle();
    s.quiet(9_000);

    expect(getLatencyStats().turnTaking.nudges_fired).toBe(0);
    expect(getLatencyStats().turnTaking.nudges_suppressed).toBe(1);
    release?.();
  });
});
