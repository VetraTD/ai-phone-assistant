import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX21 -- the outbound leak guard, on the path where the model IS the voice.
//
// The cascade cannot leak backend words: text passes through
// lib/voice/speakableText.js and createToolCallTextStripper before it ever
// reaches TTS. Here there is no text-to-speech boundary to filter, so nothing
// stood between a model that decides to narrate `cancel_appointment_db` and the
// caller's ear. The owner heard exactly that on a real call.
//
// What makes a guard possible at all: outputAudioTranscription is already
// enabled (index.js) and already consumed for echoGuard, so the words we are
// speaking arrive as text while the audio describing them is still queued.
// audioOut paces frames to Twilio and holds the rest locally, so there is a
// window in which the offending audio has NOT yet reached the caller.
//
// These tests assert the three things that window is worth: that a spoken tool
// name cuts it, that ordinary prose does not, and that when the window has
// already closed we SAY SO with a counter rather than reporting a cut that did
// nothing.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function fakeLive() {
  const sent = { realtime: [], clientContent: [], toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: (m) => sent.realtime.push(m),
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

/** 24 kHz PCM16, the shape Gemini sends. 2000 ms is 100 outbound frames. */
function modelAudio(ms = 2000) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: fakeDb(),
    env: {},
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
    /** Queue model audio, so there is something left to cut. */
    speak: (ms = 2000) =>
      live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } }),
    /** What we are saying, as the vendor reports it back to us. */
    transcribe: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    advance: (ms) => (clock += ms),
  };
}

/** Recovery notes only -- clientContent[0] is the greeting kick. */
const recoveryNotes = (live) => live.sent.clientContent.slice(1);

describe("LVX21 outbound leak guard", () => {
  beforeEach(() => clearStats());

  it("cuts the queued audio when the assistant speaks a tool name", async () => {
    const s = await boot();
    s.speak(2000);
    s.transcribe("Let me run get caller appointments from db for you.");

    expect(s.ws.sent.some((m) => m.event === "clear")).toBe(true);
    expect(getLatencyStats().turnTaking.live_outbound_leaks).toBe(1);
    expect(getLatencyStats().turnTaking.live_outbound_cuts).toBe(1);
  });

  it("catches a tool name split across two transcript fragments", async () => {
    const s = await boot();
    s.speak(2000);
    s.transcribe("Let me run get caller");
    expect(getLatencyStats().turnTaking.live_outbound_leaks).toBe(0);

    s.transcribe(" appointments from db for you.");
    expect(getLatencyStats().turnTaking.live_outbound_leaks).toBe(1);
  });

  it("leaves ordinary prose alone", async () => {
    const s = await boot();
    s.speak(2000);
    s.transcribe("I can book an appointment for you at two o clock.");

    expect(s.ws.sent.some((m) => m.event === "clear")).toBe(false);
    expect(getLatencyStats().turnTaking.live_outbound_leaks).toBe(0);
    expect(recoveryNotes(s.live)).toHaveLength(0);
  });

  it("tells the model once per turn, however many fragments leak", async () => {
    const s = await boot();
    s.speak(2000);
    s.transcribe("Calling cancel_appointment_db now.");
    s.transcribe("Then get_caller_appointments_from_db after that.");

    expect(recoveryNotes(s.live)).toHaveLength(1);
    expect(getLatencyStats().turnTaking.live_outbound_reasks).toBe(1);
  });

  it("re-arms on the next turn", async () => {
    const s = await boot();
    s.speak(2000);
    s.transcribe("Calling cancel_appointment_db now.");
    s.endTurn();
    s.speak(2000);
    s.transcribe("Calling cancel_appointment_db again.");

    expect(recoveryNotes(s.live)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // THE NOTE IS PART OF THE LOOP, so it is capped. 2026-09-09.
  //
  // The leak note goes in as a synthetic USER turn -- the only engine-to-model
  // channel this API offers with no tool call in flight -- so a model already
  // emitting meta-text is handed more text and emits more. Measured twice:
  // LVX37 saw six cycles, `turns: 0`, and a caller who heard silence for the
  // whole call; 2026-09-09 saw two cycles 3.5 seconds apart before it recovered.
  //
  // LVX37 blamed VOICE_INTENT_MARKER. The marker is forced off on this
  // front-end and the loop happened anyway, so it was A trigger, not THE
  // mechanism.
  // -------------------------------------------------------------------------
  it("stops sending the note after two leaks in one call", async () => {
    const s = await boot();
    for (let turn = 0; turn < 4; turn += 1) {
      s.speak(2000);
      s.transcribe("Calling cancel_appointment_db now.");
      s.endTurn();
    }

    // Four leaking turns, two notes.
    expect(recoveryNotes(s.live)).toHaveLength(2);
    expect(getLatencyStats().turnTaking.live_outbound_notes_capped).toBe(2);
  });

  it("keeps guarding the caller after the note is capped", async () => {
    // The cap must not uncap the GUARD. Detection, the audio cut and the
    // counters carry on for the rest of the call -- all that stops is talking
    // to the model, which is the half that was making it worse.
    const s = await boot();
    for (let turn = 0; turn < 4; turn += 1) {
      s.speak(2000);
      s.transcribe("Calling cancel_appointment_db now.");
      s.endTurn();
    }

    expect(getLatencyStats().turnTaking.live_outbound_leaks).toBe(4);
    expect(getLatencyStats().turnTaking.live_outbound_cuts).toBe(4);
  });

  it("does not ask the model to apologise", async () => {
    // It did, in as many words, and the caller heard "I'm so sorry about that"
    // on a call where nothing had visibly gone wrong. Do not ask for a
    // behaviour you do not want the caller to hear.
    const s = await boot();
    s.speak(2000);
    s.transcribe("Calling cancel_appointment_db now.");

    const note = JSON.stringify(recoveryNotes(s.live));
    // The REQUEST is what mattered, not the word. "Apologise briefly if it
    // helps" is the exact sentence that produced the spoken apology; the
    // replacement uses the word only to forbid the behaviour.
    expect(note).not.toMatch(/apologi[sz]e briefly/i);
    expect(note).not.toMatch(/apologi[sz]e if it helps/i);
    expect(note).toMatch(/do not apologi[sz]e for it/i);
  });

  it("counts a leak it was too late to cut, rather than reporting a cut", async () => {
    const s = await boot();
    // Nothing enqueued: the words already reached the caller.
    s.transcribe("Calling cancel_appointment_db now.");

    expect(getLatencyStats().turnTaking.live_outbound_leaks).toBe(1);
    expect(getLatencyStats().turnTaking.live_outbound_cuts).toBe(0);
    expect(getLatencyStats().turnTaking.live_outbound_cut_missed).toBe(1);
  });
});
