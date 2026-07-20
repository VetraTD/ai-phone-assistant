import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// session.test.js — integration tests for the v2 voice-pipeline orchestrator.
//
// Every building block (lib/voice/*) and every external service is mocked,
// faithful to the real module contracts (return shapes / callback names).
// callState.js and transcriptUtils.js are used for real (pure state + logic).
// ---------------------------------------------------------------------------

// ---- Hoisted mock state, reachable from both the mock factories and tests --
const H = vi.hoisted(() => {
  return {
    // building-block instances captured for inspection
    sttInstances: [],
    ttsTurns: [],
    audioOutInstances: [],
    turnManagerInstances: [],
    metricsInstances: [],
    // controllable runLlmTurn factory: () => async-iterable
    llmFactory: null,
    // spies for services
    fetchKnowledgeResolve: null,
  };
});

// ---- lib/voice/sttStream.js ------------------------------------------------
vi.mock("../lib/voice/sttStream.js", () => ({
  createSttStream: vi.fn(async (opts) => {
    const inst = {
      opts,
      sendAudio: vi.fn(),
      close: vi.fn(),
      isAlive: vi.fn(() => true),
    };
    H.sttInstances.push(inst);
    return inst;
  }),
}));

// ---- lib/voice/ttsStream.js ------------------------------------------------
vi.mock("../lib/voice/ttsStream.js", () => ({
  createTtsTurn: vi.fn((opts) => {
    const turn = {
      opts,
      write: vi.fn(),
      end: vi.fn(),
      abort: vi.fn(),
    };
    H.ttsTurns.push(turn);
    return turn;
  }),
}));

// ---- lib/voice/audioOut.js -------------------------------------------------
vi.mock("../lib/voice/audioOut.js", () => ({
  createAudioOut: vi.fn((opts) => {
    const inst = {
      opts,
      _playing: false,
      enqueue: vi.fn(),
      sendMark: vi.fn(),
      clear: vi.fn(),
      notifyMarkPlayed: vi.fn(),
      aiAudioPlayingUntil: vi.fn(() => 0),
      isPlaying: vi.fn(function () { return inst._playing; }),
      hasOutstandingMarks: vi.fn(() => false),
      reset: vi.fn(),
    };
    H.audioOutInstances.push(inst);
    return inst;
  }),
}));

// ---- lib/voice/inboundVad.js -----------------------------------------------
vi.mock("../lib/voice/inboundVad.js", () => ({
  createVad: vi.fn(() => ({
    processFrame: vi.fn(() => ({ voiced: false, voiceActive: false, rms: 0 })),
    isActive: vi.fn(() => false),
    reset: vi.fn(),
  })),
}));

// ---- lib/voice/turnManager.js ----------------------------------------------
vi.mock("../lib/voice/turnManager.js", () => ({
  createTurnManager: vi.fn((opts) => {
    const inst = {
      opts,
      handleInterim: vi.fn(),
      handleFinal: vi.fn(),
      handleAudioFrame: vi.fn(),
      reset: vi.fn(),
    };
    H.turnManagerInstances.push(inst);
    return inst;
  }),
}));

// ---- lib/voice/metrics.js --------------------------------------------------
vi.mock("../lib/voice/metrics.js", () => ({
  createTurnMetrics: vi.fn((callSid) => {
    const inst = { callSid, mark: vi.fn(), finishTurn: vi.fn() };
    H.metricsInstances.push(inst);
    return inst;
  }),
  getLatencyStats: vi.fn(() => ({ count: 0, byStage: {}, recent: [] })),
}));

// ---- lib/voice/llmTurn.js --------------------------------------------------
vi.mock("../lib/voice/llmTurn.js", () => ({
  runLlmTurn: vi.fn((params) => {
    if (typeof H.llmFactory === "function") return H.llmFactory(params);
    // default: empty done
    return makeGen([{ type: "done", reply: { text: "ok", toolResults: [] } }]);
  }),
}));

// ---- services --------------------------------------------------------------
vi.mock("../services/supabase.js", () => ({
  isEnabled: vi.fn(() => true),
  lookupBusinessByPhone: vi.fn(async () => ({ id: "biz1" })),
  loadConfig: vi.fn(() => ({
    businessName: "Test Biz",
    greeting: "Hello, thanks for calling Test Biz.",
    _hasCustomGreeting: true,
    languagesSpoken: ["en-US"],
    transferPolicy: "always",
    transferPhoneNumber: "+15551234567",
    recordingDisclosureEnabled: false,
    timezone: "America/Chicago",
    afterHoursPolicy: "none",
  })),
  createCall: vi.fn(async () => "call-db-1"),
  fetchBusinessKnowledge: vi.fn(async () => []),
  listIntegrationsForBusiness: vi.fn(async () => []),
  fetchCallerContext: vi.fn(async () => null),
  addTranscriptEntry: vi.fn(async () => {}),
  createCustomerRequest: vi.fn(async () => "req1"),
  completeCall: vi.fn(async () => {}),
}));

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  notifyCustomerRequest: vi.fn(async () => {}),
}));

vi.mock("../services/gemini.js", () => ({
  isBusinessOpen: vi.fn(() => true),
}));

vi.mock("../services/googleTts.js", () => ({
  synthesizeMulaw: vi.fn(async () => Buffer.from([0xff, 0xff])),
}));

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));

vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { handleVoiceSessionConnection } from "../lib/voice/session.js";
import * as callState from "../lib/callState.js";
import * as db from "../services/supabase.js";

// ---- helpers ---------------------------------------------------------------

/** Build a controllable async generator emulating runLlmTurn's contract. */
function makeGen(events, { hang = false } = {}) {
  let i = 0;
  const returnSpy = vi.fn();
  const gen = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (i < events.length) return Promise.resolve({ value: events[i++], done: false });
      if (hang) return new Promise(() => {}); // never settles
      return Promise.resolve({ value: undefined, done: true });
    },
    return(v) { returnSpy(); i = events.length; return Promise.resolve({ value: v, done: true }); },
    _returnSpy: returnSpy,
  };
  return gen;
}

/** Generator whose next() rejects with the given error. */
function makeThrowingGen(err) {
  return {
    [Symbol.asyncIterator]() { return this; },
    next() { return Promise.reject(err); },
    return() { return Promise.resolve({ value: undefined, done: true }); },
  };
}

class FakeWs {
  constructor() {
    this.readyState = 1; // OPEN
    this.listeners = {};
    this.sent = [];
    this.closeCount = 0;
  }
  on(event, cb) { (this.listeners[event] ||= []).push(cb); return this; }
  send(data) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data); }
  close() { this.closeCount++; this.readyState = 3; (this.listeners.close || []).forEach((cb) => cb()); }
  emit(obj) { (this.listeners.message || []).forEach((cb) => cb(Buffer.from(JSON.stringify(obj)))); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let sidCounter = 0;
function newSid() { return `CA-session-${++sidCounter}`; }

async function startCall(ws, callSid, { streamSid = "MZ1", businessPhone = "+15550000000", callerPhone = "+15559999999" } = {}) {
  ws.emit({ event: "start", start: { callSid, streamSid, customParameters: { businessPhone, callerPhone } } });
  await flush();
}

beforeEach(() => {
  H.sttInstances.length = 0;
  H.ttsTurns.length = 0;
  H.audioOutInstances.length = 0;
  H.turnManagerInstances.length = 0;
  H.metricsInstances.length = 0;
  H.llmFactory = null;
  vi.clearAllMocks();
  process.env.ELEVENLABS_DEFAULT_VOICE_ID = "voice-xyz";
});

afterEach(() => {
  // Evict per-call state so unique-sid isolation is airtight.
  callState.remove; // no-op reference; each test uses a fresh sid anyway
});

describe("session.js — v2 pipeline orchestrator", () => {
  it("1. speaks the greeting after only lookup+loadConfig, before background context resolves", async () => {
    // Make knowledge fetch hang so we can prove greeting does not await it.
    let resolveKnowledge;
    db.fetchBusinessKnowledge.mockImplementationOnce(
      () => new Promise((r) => { resolveKnowledge = r; })
    );

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);

    // lookup + loadConfig were awaited
    expect(db.lookupBusinessByPhone).toHaveBeenCalledWith("+15550000000");
    expect(db.loadConfig).toHaveBeenCalled();

    // greeting TTS turn created and greeting text written — WITHOUT the
    // knowledge fetch having resolved.
    expect(H.ttsTurns.length).toBeGreaterThanOrEqual(1);
    const greetingTurn = H.ttsTurns[0];
    expect(greetingTurn.write).toHaveBeenCalledWith("Hello, thanks for calling Test Biz.");

    // Simulate greeting audio: first audio enqueues while context still pending.
    greetingTurn.opts.onAudioChunk(Buffer.from([1, 2, 3]));
    expect(H.audioOutInstances[0].enqueue).toHaveBeenCalled();

    // Knowledge fetch was kicked off but never awaited before greeting audio.
    expect(resolveKnowledge).toBeTypeOf("function");
    resolveKnowledge?.([]);
  });

  it("2. media frames fan out to stt.sendAudio and turnManager.handleAudioFrame", async () => {
    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush(); // let STT promise resolve

    const payload = Buffer.from([9, 8, 7]).toString("base64");
    ws.emit({ event: "media", media: { payload } });

    const stt = H.sttInstances[0];
    const tm = H.turnManagerInstances[0];
    expect(stt.sendAudio).toHaveBeenCalledTimes(1);
    expect(stt.sendAudio.mock.calls[0][0]).toEqual(Buffer.from([9, 8, 7]));
    expect(tm.handleAudioFrame).toHaveBeenCalledTimes(1);
    expect(tm.handleAudioFrame.mock.calls[0][0]).toEqual(Buffer.from([9, 8, 7]));
  });

  it("3. full happy turn: deltas -> tts.write, done -> tts.end, transcript rows + metrics marks in order", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Sure, " },
      { type: "delta", text: "I can help." },
      { type: "done", reply: { text: "Sure, I can help.", toolResults: [] } },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    // turnManager decides the caller's turn is complete:
    tm.opts.onTurnEnd("I would like to book an appointment");
    await flush();
    await flush();

    // The turn's TTS turn is the second one created (greeting was first).
    const turnTts = H.ttsTurns[H.ttsTurns.length - 1];
    expect(turnTts.write).toHaveBeenCalledWith("Sure, ");
    expect(turnTts.write).toHaveBeenCalledWith("I can help.");
    expect(turnTts.end).toHaveBeenCalledTimes(1);

    // transcript rows: caller then ai
    const speakers = db.addTranscriptEntry.mock.calls.map((c) => c[1]);
    expect(speakers).toContain("caller");
    expect(speakers).toContain("ai");

    // metrics marks recorded in the documented order
    const metrics = H.metricsInstances[0];
    const marks = metrics.mark.mock.calls.map((c) => c[0]);
    expect(marks).toContain("speech_end");
    expect(marks).toContain("stt_final");
    expect(marks).toContain("llm_request");
    expect(marks).toContain("llm_first_chunk");
    expect(marks.indexOf("llm_request")).toBeLessThan(marks.indexOf("llm_first_chunk"));
    expect(marks.indexOf("speech_end")).toBeLessThan(marks.indexOf("llm_request"));
  });

  it("4. barge-in: onInterrupt clears audio, aborts tts + llm generator, bumps epoch", async () => {
    const gen = makeGen([{ type: "delta", text: "Let me explain " }], { hang: true });
    H.llmFactory = () => gen;

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const state = callState.getState(sid);
    const epochBefore = state.speakEpoch;

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("tell me about your hours");
    await flush();
    await flush();

    const turnTts = H.ttsTurns[H.ttsTurns.length - 1];
    const audioOut = H.audioOutInstances[0];

    // Now the caller interrupts.
    tm.opts.onInterrupt("stop");
    await flush();

    expect(audioOut.clear).toHaveBeenCalled();
    expect(turnTts.abort).toHaveBeenCalled();
    expect(gen._returnSpy).toHaveBeenCalled();
    expect(state.speakEpoch).toBe(epochBefore + 1);
    const metrics = H.metricsInstances[0];
    expect(metrics.finishTurn).toHaveBeenCalledWith(expect.objectContaining({ barged_in: true }));
  });

  it("5. LLM_TIMEOUT: error line spoken and consecutive-failure counter incremented", async () => {
    H.llmFactory = () => makeThrowingGen(Object.assign(new Error("timeout"), { code: "LLM_TIMEOUT" }));

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("what are your prices for a deep clean");
    await flush();
    await flush();

    // An error line was spoken (a fresh TTS turn writing the timeout apology).
    const wrote = H.ttsTurns.some((t) =>
      t.write.mock.calls.some((c) => /longer|repeat that/i.test(c[0] || ""))
    );
    expect(wrote).toBe(true);

    const state = callState.getState(sid);
    expect(state.consecutiveFailures).toBe(1);
  });

  it("6. STT terminal failure: apology spoken then graceful close", async () => {
    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const stt = H.sttInstances[0];
    const err = new Error("gone");
    err.code = "STT_RECONNECT_FAILED";
    stt.opts.onError(err);
    await flush();

    // apology spoken
    const wroteApology = H.ttsTurns.some((t) =>
      t.write.mock.calls.some((c) => /trouble hearing|call back/i.test(c[0] || ""))
    );
    expect(wroteApology).toBe(true);
    expect(ws.closeCount).toBe(0);

    // Twilio echoes the goodbye mark -> ws closes.
    ws.emit({ event: "mark", mark: { name: "stt-error-goodbye-done" } });
    await flush();
    expect(ws.closeCount).toBe(1);
  });

  it("7. end_call stateEffect closes ws only after the turn's done-mark is played", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Thanks for calling. Goodbye!" },
      { type: "done", reply: { text: "Thanks for calling. Goodbye!", endCallArgs: { reason: "done" }, toolResults: [] } },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("no that is all thank you");
    await flush();
    await flush();

    // Not closed yet — audio still needs to play out.
    expect(ws.closeCount).toBe(0);

    // Twilio confirms the turn's done mark played.
    ws.emit({ event: "mark", mark: { name: "turn-1-done" } });
    await flush();
    expect(ws.closeCount).toBe(1);
  });

  it("9. done event with transferRequested effect triggers the transfer flow (doTransfer)", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Of course, transferring you now." },
      {
        type: "done",
        reply: {
          text: "Of course, transferring you now.",
          transferRequested: { reason: "caller asked for a person" },
          toolResults: [{ name: "request_transfer", success: true, message: "ok" }],
        },
      },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    // Non-English phrasing — must NOT match the English TRANSFER_TRIGGERS
    // regex escape-hatch, so this exercises the tool-driven path only.
    tm.opts.onTurnEnd("quiero hablar con una persona");
    await flush();
    await flush();
    await flush(); // doTransfer() is fire-and-forget from applyReply

    // doTransfer's own "Transferring you now. Please hold." line was spoken
    // (a TTS turn distinct from the model's own reply turn).
    const wroteTransferLine = H.ttsTurns.some((t) =>
      t.write.mock.calls.some((c) => /Transferring you now/i.test(c[0] || ""))
    );
    expect(wroteTransferLine).toBe(true);

    const state = callState.getState(sid);
    expect(state.step).toBe("ending");
  });

  it("8. silence timer does not fire a nudge while audioOut.isPlaying() is true", async () => {
    vi.useFakeTimers();
    try {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({ event: "start", start: { callSid: sid, streamSid: "MZ8", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } } });
      await vi.advanceTimersByTimeAsync(1);

      const audioOut = H.audioOutInstances[0];
      audioOut._playing = true; // AI audio is playing

      const ttsCountBefore = H.ttsTurns.length;

      // Greeting finished playing -> would normally arm the silence timer.
      ws.emit({ event: "mark", mark: { name: "greeting-done" } });

      // Advance well past every silence threshold.
      await vi.advanceTimersByTimeAsync(30000);

      // No nudge should have been spoken while audio is "playing".
      expect(H.ttsTurns.length).toBe(ttsCountBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
