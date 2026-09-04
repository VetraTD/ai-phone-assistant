import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX50 — the assistant answered noise as though it had understood it.
//
// A caller's English turn came back from the vendor's transcription as the
// Korean characters "에레는". The assistant replied:
//
//   "Great, 8 AM on Tuesday, September 8th, is available."
//
// and the call went on to book from it. Two turns earlier the same caller said
// "Uh" twice and got sensible clarifying questions, so the model is perfectly
// capable of asking -- it just did not here.
//
// ---------------------------------------------------------------------------
// Why a script check, and what it cannot do
// ---------------------------------------------------------------------------
//
// There is nothing better available. The Live API surfaces no confidence, no
// stability and no language field on inputTranscription -- the only fields read
// anywhere in lib/voice/live/ are usageMetadata, toolCall, and serverContent's
// two transcriptions plus generationComplete / turnComplete / interrupted.
// stripFillers only recognises filler words, not garbage.
//
// So the judgement is on the script of the letters: on a call served in English
// or Spanish, a turn that is mostly non-Latin is a failed transcription rather
// than a caller who switched language. Latin covers both locales, which is why
// an accented Spanish turn must never trip it.
//
// What this CANNOT detect is fluent Latin nonsense. That limit is real, and it
// is the reason the write is gated separately in services/tools.js rather than
// this note being treated as the guarantee.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
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
      businessName: "Digile Media",
      timezone: "Europe/London",
      allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
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

async function boot(env = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
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

  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    live,
    settle,
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    hear: (text) => live.push({ serverContent: { inputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
  };
}

const stats = () => getLatencyStats().turnTaking;
// clientContent[0] is the greeting kick; anything after it is a turn note.
const notes = (live) => live.sent.clientContent.slice(1);

describe("LVX50 — a caller turn that did not transcribe as speech", () => {
  beforeEach(() => clearStats());

  it("counts the exact turn from the call, and tells the model to ask again", async () => {
    const s = await boot();
    s.hear("에레는");
    s.say("Great, 8 AM on Tuesday, September 8th, is available.");
    s.endTurn();
    await s.settle();

    expect(stats().live_unusable_transcript).toBe(1);
    const sent = notes(s.live);
    expect(sent).toHaveLength(1);
    expect(sent[0].turns[0].parts[0].text).toContain("did not come through as usable speech");
    expect(sent[0].turns[0].parts[0].text).toContain("ask them to say it again");
  });

  it("counts the POSITIVE case, so a clean call is not indistinguishable from no call", async () => {
    // The measure that makes the fault counter readable. Without this, a call
    // where every turn transcribed fine and a call where the check never ran at
    // all both report live_unusable_transcript: 0.
    const s = await boot();
    s.hear("I'd like to book an appointment on Tuesday");
    // Deliberately not "let me check that for you": that is a promise with no
    // tool behind it and spends the turn's note on the promise guard, which is
    // correct behaviour of a different guard and would make this assertion
    // about the wrong thing.
    s.say("Of course. What time on Tuesday suits you?");
    s.endTurn();
    await s.settle();

    expect(stats().live_transcript_script_checked).toBe(1);
    expect(stats().live_unusable_transcript).toBe(0);
    expect(notes(s.live)).toHaveLength(0);
  });

  it("leaves a Spanish turn alone", async () => {
    const s = await boot();
    s.hear("Sí, quiero una cita para el martes por la mañana");
    s.say("Perfecto, déjeme comprobarlo.");
    s.endTurn();
    await s.settle();

    expect(stats().live_unusable_transcript).toBe(0);
    expect(stats().live_transcript_script_checked).toBe(1);
    expect(notes(s.live)).toHaveLength(0);
  });

  it("spends at most one note, however many turns are unusable", async () => {
    // Rationed like every other note: sendTurnNote allows one per turn and
    // eight per call. A note that can repeat freely is the shape that let the
    // leak guard deliver half a second of audio in twenty-five (LVX21).
    const s = await boot();
    for (const t of ["에레는", "안녕하세요", "こんにちは"]) {
      s.hear(t);
      s.say("Sure.");
      s.endTurn();
      await s.settle();
    }
    expect(stats().live_unusable_transcript).toBe(3);
    // One per TURN, not one per call -- three turns, three notes, and the
    // per-call ceiling of eight is what stops it running away.
    expect(notes(s.live)).toHaveLength(3);
  });

  it("says nothing when the caller says nothing", async () => {
    const s = await boot();
    s.say("Are you still there?");
    s.endTurn();
    await s.settle();

    expect(stats().live_transcript_script_checked).toBe(0);
    expect(stats().live_unusable_transcript).toBe(0);
  });
});
