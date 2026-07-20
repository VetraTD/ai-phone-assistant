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
    fallbackFlowInstances: [],
    // set once, at session.js module-load time (utteranceCache is a
    // module-level singleton there) — see the utteranceCache.js mock below.
    utteranceCacheInstance: null,
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

// ---- lib/voice/fallbackFlow.js ----------------------------------------------
vi.mock("../lib/voice/fallbackFlow.js", () => ({
  createFallbackFlow: vi.fn((opts) => {
    const inst = {
      opts,
      _active: false,
      start: vi.fn(function () { inst._active = true; }),
      handleInput: vi.fn(),
      isActive: vi.fn(function () { return inst._active; }),
      getState: vi.fn(() => "awaiting_name"),
    };
    H.fallbackFlowInstances.push(inst);
    return inst;
  }),
}));

// ---- lib/voice/utteranceCache.js --------------------------------------------
// Mocked (not the real module) so cache hits/misses are fully controllable
// per test and there's zero risk of cross-test cache-state bleed (the real
// module's cache is intentionally module-wide/shared — see its own tests in
// tests/utteranceCache.test.js for that behavior in isolation).
vi.mock("../lib/voice/utteranceCache.js", () => ({
  createUtteranceCache: vi.fn((opts) => {
    H.utteranceCacheInstance = {
      opts,
      get: vi.fn(() => null),
      warm: vi.fn(async () => {}),
    };
    return H.utteranceCacheInstance;
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
    voiceProvider: "elevenlabs",
    voiceId: null,
  })),
  createCall: vi.fn(async () => "call-db-1"),
  fetchBusinessKnowledge: vi.fn(async () => []),
  listIntegrationsForBusiness: vi.fn(async () => []),
  fetchCallerContext: vi.fn(async () => null),
  addTranscriptEntry: vi.fn(async () => {}),
  createCustomerRequest: vi.fn(async () => "req1"),
  completeCall: vi.fn(async () => {}),
  markCallTransferred: vi.fn(async () => {}),
}));

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  notifyCustomerRequest: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
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

// doTransfer() dynamically imports "twilio" to redial the call — mock it so
// the transfer redial succeeds deterministically instead of attempting a
// real (and in test env, failing) network call to Twilio's API.
const mockTwilioCallsUpdate = vi.fn(async () => ({}));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    calls: () => ({ update: (...args) => mockTwilioCallsUpdate(...args) }),
  })),
}));

import { handleVoiceSessionConnection } from "../lib/voice/session.js";
import * as callState from "../lib/callState.js";
import * as db from "../services/supabase.js";
import * as notifications from "../services/notifications.js";
import { log } from "../lib/logger.js";
import { runLlmTurn } from "../lib/voice/llmTurn.js";
import { synthesizeMulaw as mockSynthesizeMulaw } from "../services/googleTts.js";
import { VOICE_CATALOG } from "../config/voices.js";

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
  H.fallbackFlowInstances.length = 0;
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

  it("2b. state.sawCallerFinal is set true the moment turnManager delivers a non-empty caller final (read synchronously by server.js's spam heuristic)", async () => {
    H.llmFactory = () => makeGen([{ type: "done", reply: { text: "OK", toolResults: [] } }]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    expect(callState.getState(sid).sawCallerFinal).toBe(false);

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("what are your hours");
    await flush();

    expect(callState.getState(sid).sawCallerFinal).toBe(true);
  });

  it("3. full happy turn: deltas -> tts.write (sentence-batched + speakable-normalized), done -> tts.end, transcript rows + metrics marks in order", async () => {
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
    // Deltas are sentence-batched before being written (see
    // splitReadySentences/toSpeakable in session.js) — "Sure, " has no
    // sentence-ending punctuation yet, so it's held back and merged with the
    // next delta into a single write() once the sentence completes.
    const turnTts = H.ttsTurns[H.ttsTurns.length - 1];
    expect(turnTts.write).toHaveBeenCalledTimes(1);
    expect(turnTts.write).toHaveBeenCalledWith("Sure, I can help.");
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

  it("3b. tts onDone({truncated: true}) logs tts_turn_truncated with callSid + turn index", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Sure, I can help." },
      { type: "done", reply: { text: "Sure, I can help.", toolResults: [] } },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("I would like to book an appointment");
    await flush();
    await flush();

    const turnTts = H.ttsTurns[H.ttsTurns.length - 1];
    // Simulate ttsStream.js's finishDone() calling back with a truncated turn.
    turnTts.opts.onDone({ truncated: true });

    expect(log.error).toHaveBeenCalledWith(
      "tts_turn_truncated",
      expect.objectContaining({ callSid: sid })
    );
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

  it("5b. 2 consecutive LLM failures enter the no-LLM fallback flow; further finals route to it, never to the LLM", async () => {
    H.llmFactory = () => makeThrowingGen(Object.assign(new Error("down"), { code: "LLM_TIMEOUT" }));

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];

    // Failure #1 — should NOT enter the fallback flow yet.
    tm.opts.onTurnEnd("what are your hours today please");
    await flush();
    await flush();
    expect(H.fallbackFlowInstances.length).toBe(0);
    expect(callState.getState(sid).consecutiveFailures).toBe(1);

    // Failure #2 — crosses the threshold, enters the fallback flow.
    tm.opts.onTurnEnd("can you check my appointment please");
    await flush();
    await flush();

    expect(H.fallbackFlowInstances.length).toBe(1);
    const flow = H.fallbackFlowInstances[0];
    expect(flow.start).toHaveBeenCalledTimes(1);
    expect(callState.getState(sid).consecutiveFailures).toBe(2);

    // A third caller final must be routed straight to the flow, bypassing
    // the LLM entirely (no new runLlmTurn call, no cleanTranscript filter
    // dropping a short reply — e.g. a bare "yes"/"no").
    const llmCallsBefore = runLlmTurn.mock.calls.length;
    tm.opts.onTurnEnd("my name is Jordan Lee");
    await flush();

    expect(flow.handleInput).toHaveBeenCalledWith("my name is Jordan Lee");
    expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore);
  });

  it("5c. race: a final delivered between the fallback flow's onComplete and its ENDING transition must not reach the LLM", async () => {
    H.llmFactory = () => makeThrowingGen(Object.assign(new Error("down"), { code: "LLM_TIMEOUT" }));

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];

    // Two failures -> enter the fallback flow.
    tm.opts.onTurnEnd("first failing turn");
    await flush();
    await flush();
    tm.opts.onTurnEnd("second failing turn");
    await flush();
    await flush();

    expect(H.fallbackFlowInstances.length).toBe(1);
    const flow = H.fallbackFlowInstances[0];

    // Hold createCustomerRequest open so we can land a final while
    // completeFallbackFlow is mid-await — i.e. after the flow itself has
    // gone inactive (isActive() === false) but before state.step is set
    // to ENDING.
    let resolveCreate;
    db.createCustomerRequest.mockImplementationOnce(
      () => new Promise((r) => { resolveCreate = r; })
    );

    flow._active = false; // mirrors the real flow's finishSuccess() timing
    flow.opts.onComplete({ callerName: "Sam", callbackNumber: "5551234567", message: "call me back" });
    await flush();

    // Still mid-await: not yet ENDING.
    const state = callState.getState(sid);
    expect(state.step).not.toBe("ending");

    const llmCallsBefore = runLlmTurn.mock.calls.length;

    // A caller final arrives in exactly this window.
    tm.opts.onTurnEnd("hello, are you still there");
    await flush();

    // Must be routed to the (now-inactive, no-op) flow, never to the LLM.
    expect(flow.handleInput).toHaveBeenCalledWith("hello, are you still there");
    expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore);

    resolveCreate?.("req-async");
    await flush();
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

  it("9a. done event with transferRequested effect triggers the transfer flow when the model produced no text of its own", async () => {
    // No delta events — the model called request_transfer without saying
    // anything of its own (e.g. very first token was the function call).
    H.llmFactory = () => makeGen([
      {
        type: "done",
        reply: {
          text: "",
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
    // since the model didn't say anything of its own this turn.
    const wroteTransferLine = H.ttsTurns.some((t) =>
      t.write.mock.calls.some((c) => /Transferring you now/i.test(c[0] || ""))
    );
    expect(wroteTransferLine).toBe(true);

    const state = callState.getState(sid);
    expect(state.step).toBe("ending");

    // The redial must NOT have happened yet: updating the call's TwiML tears
    // down the media stream, so firing it here would cut the announcement off
    // and leave the caller listening to silence.
    expect(mockTwilioCallsUpdate).not.toHaveBeenCalled();

    // Twilio echoes the announcement's playback mark -> now we redial.
    ws.emit({ event: "mark", mark: { name: "transfer-done" } });
    await flush();
    await flush();

    expect(mockTwilioCallsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ twiml: expect.stringContaining("<Dial>+15551234567</Dial>") })
    );

    // Real transferred status (Part 1) — the redial succeeded (mocked
    // "twilio" above), so the call must be marked transferred in the DB.
    const db = await import("../services/supabase.js");
    expect(db.markCallTransferred).toHaveBeenCalledWith(sid);
  });

  it("9c. transfer redials on the CLOSE_FALLBACK_MS backstop if the playback mark never echoes back", async () => {
    vi.useFakeTimers();
    try {
      H.llmFactory = () => makeGen([
        {
          type: "done",
          reply: {
            text: "",
            transferRequested: { reason: "caller asked for a person" },
            toolResults: [{ name: "request_transfer", success: true, message: "ok" }],
          },
        },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-transfer-${++sidCounter}`;
      ws.emit({ event: "start", start: { callSid: sid, streamSid: "MZ9", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } } });
      await vi.advanceTimersByTimeAsync(1);

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("quiero hablar con una persona");
      await vi.advanceTimersByTimeAsync(1);

      // Audio never finished playing (no mark echoed) — still waiting.
      expect(mockTwilioCallsUpdate).not.toHaveBeenCalled();

      // The backstop fires so the caller is never stranded on a promise of a
      // transfer that silently never happens.
      await vi.advanceTimersByTimeAsync(9000);

      // redialForTransfer dynamically imports "twilio"; module resolution
      // needs real ticks, which advanceTimersByTimeAsync (microtasks only)
      // cannot provide — hand the clock back before asserting.
      vi.useRealTimers();
      await flush();
      await flush();

      expect(mockTwilioCallsUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("9b. transferRequested skips the redundant hardcoded announcement when the model already spoke this turn", async () => {
    // Deliberately worded to NOT contain doTransfer's exact hardcoded line,
    // so the assertion below can't accidentally match the model's own text.
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Sure, I'll get you connected with someone right away." },
      {
        type: "done",
        reply: {
          text: "Sure, I'll get you connected with someone right away.",
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
    tm.opts.onTurnEnd("quiero hablar con una persona");
    await flush();
    await flush();
    await flush(); // doTransfer() is fire-and-forget from applyReply

    // The model already announced the transfer itself (the delta above) —
    // doTransfer must NOT speak its own redundant hardcoded "Transferring
    // you now. Please hold." line on top of it.
    const wroteRedundantLine = H.ttsTurns.some((t) =>
      t.write.mock.calls.some((c) => c[0] === "Transferring you now. Please hold.")
    );
    expect(wroteRedundantLine).toBe(false);

    // But the transfer still actually proceeds (step -> ending), it's only
    // the extra spoken line that's skipped.
    const state = callState.getState(sid);
    expect(state.step).toBe("ending");

    // Still deferred: the model's OWN announcement has to finish playing
    // before the redial tears the stream down, otherwise the caller hears its
    // sentence chopped off mid-word.
    expect(mockTwilioCallsUpdate).not.toHaveBeenCalled();

    ws.emit({ event: "mark", mark: { name: "turn-1-done" } });
    await flush();
    await flush();

    expect(mockTwilioCallsUpdate).toHaveBeenCalledTimes(1);
    expect(ws.closeCount).toBe(0); // the Twilio redial tears the stream down, not us
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

  it("12a. a booked appointment sends the caller an appointment_confirmation SMS", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "You're all set!" },
      {
        type: "done",
        reply: {
          text: "You're all set!",
          appointmentArgs: { scheduled_at: "2026-08-01T15:00:00.000Z", client_name: "Alex", service_type: "Checkup" },
          toolResults: [{ name: "book_appointment_db", success: true }],
        },
      },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("book me an appointment");
    await flush();
    await flush();

    expect(notifications.sendCallerSms).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: "Test Biz" }),
      "+15559999999",
      "appointment_confirmation",
      expect.objectContaining({ name: "Alex" })
    );
  });

  it("12b. a taken message sends the caller a message_received SMS once the customer request is saved", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Got it, we'll follow up." },
      {
        type: "done",
        reply: {
          text: "Got it, we'll follow up.",
          customerRequestArgs: { request_type: "message", caller_name: "Sam", message: "Call me back" },
          toolResults: [{ name: "take_message_db", success: true }],
        },
      },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("please take a message");
    await flush();
    await flush();

    expect(notifications.sendCallerSms).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: "Test Biz" }),
      "+15559999999",
      "message_received",
      expect.objectContaining({ name_part: " Sam" })
    );
  });

  it("13. multilingual: languagesSpoken.length > 1 -> STT connects with language=multi + endpointing=100", async () => {
    db.loadConfig.mockReturnValueOnce({
      businessName: "Test Biz",
      greeting: "Hello, thanks for calling Test Biz.",
      _hasCustomGreeting: true,
      languagesSpoken: ["en", "es"],
      transferPolicy: "always",
      transferPhoneNumber: "+15551234567",
      recordingDisclosureEnabled: false,
      timezone: "America/Chicago",
      afterHoursPolicy: "none",
      voiceProvider: "elevenlabs",
      voiceId: null,
    });

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);

    const stt = H.sttInstances[H.sttInstances.length - 1];
    expect(stt.opts.language).toBe("multi");
    expect(stt.opts.endpointing).toBe(100);
  });

  it("13b. single-language config keeps the current mapping (no endpointing override)", async () => {
    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);

    const stt = H.sttInstances[H.sttInstances.length - 1];
    expect(stt.opts.language).toBe("en-US");
    expect(stt.opts.endpointing).toBeUndefined();
  });

  describe("10. per-business voice resolution (config.voiceProvider/voiceId -> ttsTurn opts)", () => {
    it("10a. default (elevenlabs, no voiceId configured) falls back to ELEVENLABS_DEFAULT_VOICE_ID with no catalog voiceSettings", async () => {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const greetingTurn = H.ttsTurns[0];
      expect(greetingTurn.opts.voiceId).toBe("voice-xyz"); // process.env.ELEVENLABS_DEFAULT_VOICE_ID
      expect(greetingTurn.opts.voiceSettings).toBeUndefined();
      expect(greetingTurn.opts.forceFallback).toBe(false);
    });

    it("10b. config.voiceId matching a VOICE_CATALOG entry threads that entry's voiceSettings through", async () => {
      const catalogVoice = VOICE_CATALOG[0];
      db.loadConfig.mockReturnValueOnce({
        businessName: "Test Biz",
        greeting: "Hello, thanks for calling Test Biz.",
        _hasCustomGreeting: true,
        languagesSpoken: ["en-US"],
        transferPolicy: "always",
        transferPhoneNumber: "+15551234567",
        recordingDisclosureEnabled: false,
        timezone: "America/Chicago",
        afterHoursPolicy: "none",
        voiceProvider: "elevenlabs",
        voiceId: catalogVoice.elevenVoiceId,
      });

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const greetingTurn = H.ttsTurns[0];
      expect(greetingTurn.opts.voiceId).toBe(catalogVoice.elevenVoiceId);
      expect(greetingTurn.opts.voiceSettings).toEqual(catalogVoice.voiceSettings);
      expect(greetingTurn.opts.forceFallback).toBe(false);
    });

    it("10c. voice_provider=google skips ElevenLabs entirely (forceFallback=true) regardless of voiceId", async () => {
      db.loadConfig.mockReturnValueOnce({
        businessName: "Test Biz",
        greeting: "Hello, thanks for calling Test Biz.",
        _hasCustomGreeting: true,
        languagesSpoken: ["en-US"],
        transferPolicy: "always",
        transferPhoneNumber: "+15551234567",
        recordingDisclosureEnabled: false,
        timezone: "America/Chicago",
        afterHoursPolicy: "none",
        voiceProvider: "google",
        voiceId: null,
      });

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const greetingTurn = H.ttsTurns[0];
      expect(greetingTurn.opts.forceFallback).toBe(true);
    });
  });

  describe("11. pre-cached micro-utterances (lib/voice/utteranceCache.js wiring)", () => {
    it("11a. warm() is kicked off in the background at call start, never blocking pickup, and never includes the greeting or any dead (never-get()'d) entry", async () => {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      // Greeting was spoken live, unconditionally (see 11b) — proves pickup
      // never waited on any cache lookup or on warm() settling.
      expect(H.ttsTurns.length).toBeGreaterThanOrEqual(1);
      expect(H.ttsTurns[0].write).toHaveBeenCalledWith("Hello, thanks for calling Test Biz.");

      // warm() was still kicked off (fire-and-forget) with this call's voice
      // key and a non-empty set of entries.
      expect(H.utteranceCacheInstance.warm).toHaveBeenCalledTimes(1);
      const [, entries] = H.utteranceCacheInstance.warm.mock.calls[0];
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.some((e) => e.text === "One moment.")).toBe(true);

      // The greeting text must never be warmed — utteranceCache's synthesize
      // backend is the Google fallback voice, not the business's chosen
      // ElevenLabs voice, so caching the greeting would mean every caller
      // after the first hears the wrong voice for the most
      // identity-defining moment of the call.
      expect(entries.some((e) => e.text === "Hello, thanks for calling Test Biz.")).toBe(false);
      expect(entries.some((e) => e.kind === "greeting")).toBe(false);

      // No dead synthesis: every warmed entry must have a real get() call
      // site somewhere in session.js. "checking"/"ack" were removed because
      // no code path ever looks them up.
      expect(entries.some((e) => e.kind === "checking")).toBe(false);
      expect(entries.some((e) => e.kind === "ack")).toBe(false);
      expect(entries.some((e) => e.text === "Let me check that for you…")).toBe(false);
      expect(entries.some((e) => e.text === "Sorry, go ahead.")).toBe(false);
    });

    it("11b. greeting always speaks live — never checks or uses the cache, even when the cache has a hit for that exact text", async () => {
      const cachedGreeting = Buffer.from([1, 2, 3, 4]);
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();

      // Even if the cache WOULD hit for this exact text (e.g. a stale/buggy
      // warm from elsewhere), the greeting must not use it.
      H.utteranceCacheInstance.get.mockImplementation((voiceKey, kind, text) =>
        text === "Hello, thanks for calling Test Biz." ? cachedGreeting : null
      );

      await startCall(ws, sid);

      // A live TTS turn was created and written to for the greeting — the
      // cached buffer was never enqueued in its place.
      expect(H.ttsTurns.length).toBeGreaterThanOrEqual(1);
      expect(H.ttsTurns[0].write).toHaveBeenCalledWith("Hello, thanks for calling Test Biz.");
      const audioOut = H.audioOutInstances[0];
      expect(audioOut.enqueue).not.toHaveBeenCalledWith(cachedGreeting);
    });

    it("11c. filler: a cache hit for the exact filler text is used instead of a live googleTts.synthesizeMulaw call", async () => {
      const cachedFiller = Buffer.from([9, 9]);
      H.utteranceCacheInstance.get.mockImplementation((voiceKey, kind, text) =>
        kind === "filler" && text === "One moment." ? cachedFiller : null
      );

      // "slow" fires before any delta text, triggering playFiller().
      H.llmFactory = () => makeGen([
        { type: "slow" },
        { type: "delta", text: "Sure, I can help." },
        { type: "done", reply: { text: "Sure, I can help.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);
      await flush();

      const callsBefore = mockSynthesizeMulaw.mock.calls.length;

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const audioOut = H.audioOutInstances[0];
      expect(audioOut.enqueue).toHaveBeenCalledWith(cachedFiller);
      // No new live synthesis call for the filler — the cache hit was used.
      expect(mockSynthesizeMulaw.mock.calls.length).toBe(callsBefore);
    });
  });
});
