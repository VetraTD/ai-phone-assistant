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
    // monotonic source for the mocked createRequestId (see the logger mock)
    requestIdCounter: 0,
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
// Only createTtsTurn is faked. remainderBoundary / REPAIR_CHARS_PER_SEC stay
// REAL: session.js reuses them to work out how much of a barged reply the
// caller actually heard, and a stubbed estimate would make that untested.
vi.mock("../lib/voice/ttsStream.js", async (importActual) => ({
  ...(await importActual()),
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
      stop: vi.fn(),
      _queuedFrames: vi.fn(() => 0),
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
  getLatencyStats: vi.fn(() => ({ count: 0, byStage: {}, turnTaking: {}, recent: [] })),
  bumpCounter: vi.fn(),
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
    // Deliberately different from transferPhoneNumber: the callback number a
    // caller is given must be the business's own line, never the internal
    // forwarding target.
    mainPhone: "+18175803291",
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
  ACTION_TOOL_NAMES: [
    "book_appointment",
    "cancel_appointment_db",
    "reschedule_appointment_db",
    "record_customer_request",
  ],
}));

vi.mock("../services/googleTts.js", () => ({
  synthesizeMulaw: vi.fn(async () => Buffer.from([0xff, 0xff])),
}));

// createRequestId returns a fresh id per call so tests can prove that one
// turn's log lines share an id AND that a later turn gets a different one.
vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => `req-${++H.requestIdCounter}`),
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

import {
  handleVoiceSessionConnection,
  TRANSFER_TRIGGERS,
  mapLanguage,
  keytermsFromConfig,
} from "../lib/voice/session.js";

describe("keytermsFromConfig — business STT keyterm sourcing", () => {
  it("sources the business name", () => {
    expect(keytermsFromConfig({ businessName: "Brightwork Dental" })).toEqual(["Brightwork Dental"]);
  });

  it("skips the generic 'our office' placeholder and empty configs", () => {
    expect(keytermsFromConfig({ businessName: "our office" })).toEqual([]);
    expect(keytermsFromConfig(null)).toEqual([]);
    expect(keytermsFromConfig({})).toEqual([]);
  });

  it("sources custom identity labels across capabilities", () => {
    const config = {
      businessName: "Acme Clinic",
      capabilities: {
        appointments: {
          require: { identity: { custom: [{ key: "policy", label: "Policy number" }] } },
        },
        messages: {
          require: { identity: { custom: [{ key: "member", label: "Membership ID" }] } },
        },
      },
    };
    expect(keytermsFromConfig(config)).toEqual(["Acme Clinic", "Policy number", "Membership ID"]);
  });

  it("dedupes case-insensitively and drops blanks", () => {
    const config = {
      businessName: "Acme",
      capabilities: {
        a: { require: { identity: { custom: [{ key: "x", label: "acme" }, { key: "y", label: "  " }] } } },
      },
    };
    expect(keytermsFromConfig(config)).toEqual(["Acme"]);
  });

  it("drops terms longer than five words (keyterm prompting favors short terms)", () => {
    const config = {
      businessName: "Short Name Co",
      capabilities: {
        a: {
          require: {
            identity: { custom: [{ key: "x", label: "this label has way too many words to keep" }] },
          },
        },
      },
    };
    expect(keytermsFromConfig(config)).toEqual(["Short Name Co"]);
  });

  it("caps the list at 20 terms", () => {
    const custom = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `term${i}` }));
    const config = {
      businessName: "Biz",
      capabilities: { a: { require: { identity: { custom } } } },
    };
    expect(keytermsFromConfig(config)).toHaveLength(20);
    expect(keytermsFromConfig(config)[0]).toBe("Biz");
  });
});

describe("mapLanguage — Deepgram nova-3 language codes", () => {
  it("maps bare ISO codes to valid nova-3 codes", () => {
    expect(mapLanguage({ languagesSpoken: ["en"] })).toBe("en-US");
    expect(mapLanguage({ languagesSpoken: ["es"] })).toBe("es"); // not the invalid "es-US"
    expect(mapLanguage({ languagesSpoken: ["fr"] })).toBe("fr");
  });

  it("multi-language configs use nova-3 code-switching", () => {
    expect(mapLanguage({ languagesSpoken: ["en", "es"] })).toBe("multi");
  });

  it("passes through full BCP-47 codes and defaults to en-US", () => {
    expect(mapLanguage({ languagesSpoken: ["es-419"] })).toBe("es-419");
    expect(mapLanguage({})).toBe("en-US");
    expect(mapLanguage({ languagesSpoken: ["xx"] })).toBe("en-US");
  });
});

describe("TRANSFER_TRIGGERS regex", () => {
  it("does not match identity questions", () => {
    expect(TRANSFER_TRIGGERS.test("are you a real person or a robot")).toBe(false);
    expect(TRANSFER_TRIGGERS.test("are you human")).toBe(false);
    expect(TRANSFER_TRIGGERS.test("is this a real person")).toBe(false);
    expect(TRANSFER_TRIGGERS.test("am I talking to a robot")).toBe(false);
  });

  it("matches explicit transfer requests", () => {
    expect(TRANSFER_TRIGGERS.test("can I talk to a person")).toBe(true);
    expect(TRANSFER_TRIGGERS.test("I want to speak to a human")).toBe(true);
    expect(TRANSFER_TRIGGERS.test("let me speak to someone")).toBe(true);
    expect(TRANSFER_TRIGGERS.test("get me a representative")).toBe(true);
    expect(TRANSFER_TRIGGERS.test("transfer me please")).toBe(true);
    expect(TRANSFER_TRIGGERS.test("I need the manager")).toBe(true);
  });
});
import * as callState from "../lib/callState.js";
import * as db from "../services/supabase.js";
import * as notifications from "../services/notifications.js";
import { log } from "../lib/logger.js";
import { runLlmTurn } from "../lib/voice/llmTurn.js";
import { synthesizeMulaw as mockSynthesizeMulaw } from "../services/googleTts.js";
import { VOICE_CATALOG } from "../config/voices.js";

// ---- helpers ---------------------------------------------------------------

/**
 * Build a controllable async generator emulating runLlmTurn's contract.
 * @param {object} [opts]
 * @param {boolean} [opts.hang] - never settle once the events run out
 * @param {Error}   [opts.throwAfter] - reject once the events run out; models
 *   a turn that did real work (e.g. emitted a toolEffect) and only THEN died
 */
function makeGen(events, { hang = false, throwAfter = null } = {}) {
  let i = 0;
  const returnSpy = vi.fn();
  const gen = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (i < events.length) return Promise.resolve({ value: events[i++], done: false });
      if (throwAfter) return Promise.reject(throwAfter);
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

/**
 * Flush the macrotask queue until `predicate()` is true, or give up.
 *
 * Several paths under test are fire-and-forget (doTransfer from applyReply,
 * the deferred redial on a playback mark), so the number of ticks needed to
 * settle them isn't fixed — it varies with how loaded the machine is.
 *
 * Bounded by WALL TIME, not tick count. A tick budget looks generous and is
 * not: doTransfer dynamically imports "twilio", and module resolution takes
 * real milliseconds, while 50 rounds of setTimeout(0) can elapse in under
 * five of them on a loaded machine. That is precisely why the transfer tests
 * passed alone and failed intermittently in a full-suite run — the budget
 * measured the wrong thing.
 */
async function flushUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  // Fall through rather than throwing: the assertion that follows reports the
  // real expectation far more usefully than a generic timeout would.
}
// The socket is closed HANGUP_GRACE_MS (800ms) after the goodbye's mark
// echoes, so the line doesn't drop on the final syllable. Real-timer tests
// have to outwait that grace before asserting the close.
const afterHangupGrace = () => new Promise((r) => setTimeout(r, 900));

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

  it("1b. default greeting (Fix 2): a single natural line with the business name, no stacked 'Good afternoon! Hi' double-greeting", async () => {
    db.loadConfig.mockReturnValueOnce({
      businessName: "Acme Dental",
      greeting: "Hi, how can I help you today?",
      _hasCustomGreeting: false,
      languagesSpoken: ["en-US"],
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

    expect(H.ttsTurns.length).toBeGreaterThanOrEqual(1);
    const greetingText = H.ttsTurns[0].write.mock.calls[0][0];

    // Business name present, single natural sentence — not the old
    // "Good afternoon! Hi, how can I help you today?" stack.
    expect(greetingText).toContain("Acme Dental");
    expect(greetingText).not.toContain("! Hi, how can I help you today?");
    expect(greetingText).toMatch(/^(Good morning|Good afternoon|Good evening), thanks for calling Acme Dental\./);
  });

  it("1c. custom greeting (Fix 2 regression guard): still plays exactly as written, no time-of-day prefix", async () => {
    // Default mocked loadConfig already has _hasCustomGreeting: true and a
    // custom greeting string — this is the existing/unchanged behavior.
    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);

    const greetingText = H.ttsTurns[0].write.mock.calls[0][0];
    expect(greetingText).toBe("Hello, thanks for calling Test Biz.");
    expect(greetingText).not.toMatch(/^(Good morning|Good afternoon|Good evening)/);
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

  it("5d. Fix 4: silence while the fallback flow is active routes to flow.handleInput(''), not the generic step nudge", async () => {
    H.llmFactory = () => makeThrowingGen(Object.assign(new Error("down"), { code: "LLM_TIMEOUT" }));
    vi.useFakeTimers();
    try {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({
        event: "start",
        start: { callSid: sid, streamSid: "MZv4", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } },
      });
      await vi.advanceTimersByTimeAsync(1);

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("first failing turn");
      await vi.advanceTimersByTimeAsync(1);
      tm.opts.onTurnEnd("second failing turn");
      await vi.advanceTimersByTimeAsync(1);

      expect(H.fallbackFlowInstances.length).toBe(1);
      const flow = H.fallbackFlowInstances[0];

      // Simulate the (real) flow speaking its first prompt — drives
      // session.js's own onSay -> speakText -> mark, which is what actually
      // arms the silence timer for the rest of the call.
      flow.opts.onSay("Can I get your name, please?");
      const promptMark = `fallback-${callState.getState(sid).turnId}-done`;
      ws.emit({ event: "mark", mark: { name: promptMark } });

      const ttsCountBefore = H.ttsTurns.length;
      await vi.advanceTimersByTimeAsync(30000); // well past every silence threshold

      // Routed to the flow...
      expect(flow.handleInput).toHaveBeenCalledWith("");
      // ...never the generic step-based nudge ladder.
      const wroteGenericNudge = H.ttsTurns.slice(ttsCountBefore).some((t) =>
        t.write.mock.calls.some(([txt]) =>
          /still here whenever you're ready|calling to book an appointment, leave a message/i.test(txt || "")
        )
      );
      expect(wroteGenericNudge).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

    // Twilio echoes the goodbye mark -> ws closes after the hangup grace.
    ws.emit({ event: "mark", mark: { name: "stt-error-goodbye-done" } });
    await afterHangupGrace();
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

    // Twilio confirms the turn's done mark played. The close is deliberately
    // held back briefly so the goodbye isn't clipped by the hangup.
    ws.emit({ event: "mark", mark: { name: "turn-1-done" } });
    await flush();
    expect(ws.closeCount).toBe(0);

    await afterHangupGrace();
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
    // Poll rather than a fixed tick count: the redial is fire-and-forget, so
    // under load it can land after the test ends — which then broke the NEXT
    // transfer test's "must not have redialled" assertion.
    await flushUntil(() => mockTwilioCallsUpdate.mock.calls.length > 0);

    expect(mockTwilioCallsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        twiml: expect.stringMatching(
          /<Dial ringTone="us" callerId="\+15559999999">\+15551234567<\/Dial>/
        ),
      })
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
      // cannot provide — hand the clock back before asserting, then poll
      // rather than guessing how many ticks the import will take.
      vi.useRealTimers();
      await flushUntil(() => mockTwilioCallsUpdate.mock.calls.length > 0);

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
    await flushUntil(() => mockTwilioCallsUpdate.mock.calls.length > 0);

    expect(mockTwilioCallsUpdate).toHaveBeenCalledTimes(1);
    expect(ws.closeCount).toBe(0); // the Twilio redial tears the stream down, not us
  });

  // Request-ID correlation. The legacy pipeline (lib/mediaStream.js) stamps a
  // per-turn createRequestId() on its turn log lines; v2 shipped without it,
  // so there was no way to group one turn's lines in aggregated logs when
  // concurrent calls interleave.
  it("13a. every log line for one turn carries the same requestId, and the next turn gets a new one", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Sure thing." },
      {
        type: "done",
        reply: {
          text: "Sure thing.",
          intentArgs: { intent: "book_appointment" },
          toolResults: [{ name: "set_call_intent", success: true }],
        },
      },
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

    const idsFor = (event) =>
      log.info.mock.calls.filter(([e]) => e === event).map(([, f]) => f?.requestId);

    const completed = idsFor("turn_completed");
    expect(completed).toHaveLength(1);
    const turn1Id = completed[0];
    expect(turn1Id).toBeTruthy();

    // Other lines emitted while handling the SAME turn share it.
    expect(idsFor("tool_result")).toEqual([turn1Id]);
    expect(idsFor("intent_set")).toEqual([turn1Id]);

    // A second turn gets its own id.
    tm.opts.onTurnEnd("actually make it Tuesday");
    await flush();
    await flush();

    const allCompleted = idsFor("turn_completed");
    expect(allCompleted).toHaveLength(2);
    expect(allCompleted[1]).toBeTruthy();
    expect(allCompleted[1]).not.toBe(turn1Id);
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

  it("8e. a barged turn's stale playback mark does not close out the successor turn's metrics", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Our hours are nine to five." },
      { type: "done", reply: { text: "Our hours are nine to five.", toolResults: [] } },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("what are your hours");
    await flush();
    await flush();

    const metrics = H.metricsInstances[0];
    // Caller barges in: onInterrupt closes this turn's metrics as barged.
    tm.opts.onInterrupt("wait");
    await flush();
    const finishCallsAfterBarge = metrics.finishTurn.mock.calls.length;

    // A successor turn starts, then Twilio echoes the BARGED turn's mark —
    // audio that was already queued when the interrupt landed.
    tm.opts.onTurnEnd("wait");
    await flush();
    ws.emit({ event: "mark", mark: { name: "turn-1-done" } });
    await flush();

    // The stale mark must be ignored: no extra finishTurn, so the live turn's
    // marks survive instead of being emitted as a junk row.
    expect(metrics.finishTurn.mock.calls.length).toBe(finishCallsAfterBarge);
  });

  it("8d. a goodbye longer than CLOSE_FALLBACK_MS is not cut off — the backstop waits for playback to finish", async () => {
    // The silence goodbye runs ~9.6s once it reads a phone number back, but
    // the backstop fired at a flat 8s and hung up mid-sentence, which also
    // meant the playback mark never arrived. It must re-arm while audio is
    // still playing rather than guillotine the call.
    vi.useFakeTimers();
    try {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({ event: "start", start: { callSid: sid, streamSid: "MZ8d", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } } });
      await vi.advanceTimersByTimeAsync(1);

      const audioOut = H.audioOutInstances[0];
      ws.emit({ event: "mark", mark: { name: "greeting-done" } });
      // Run the full silence ladder out to the hangup goodbye.
      await vi.advanceTimersByTimeAsync(21000);

      // Goodbye audio is still playing well past the 8s backstop.
      audioOut._playing = true;
      await vi.advanceTimersByTimeAsync(9000);
      expect(ws.closeCount).toBe(0); // must NOT have been cut off

      // Playback finishes and Twilio echoes the goodbye's mark.
      audioOut._playing = false;
      ws.emit({ event: "mark", mark: { name: "silence-goodbye-done" } });
      await vi.advanceTimersByTimeAsync(1000); // hangup grace
      expect(ws.closeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("8b. silence timer recovers when the -done mark echoes while isPlaying() still reports true", async () => {
    // audioOut.isPlaying() is an estimate: Twilio can echo the greeting mark
    // while it still says "playing". The arm must retry, not orphan itself.
    vi.useFakeTimers();
    try {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({ event: "start", start: { callSid: sid, streamSid: "MZ8b", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } } });
      await vi.advanceTimersByTimeAsync(1);

      const audioOut = H.audioOutInstances[0];
      audioOut._playing = true; // estimate lags the mark
      ws.emit({ event: "mark", mark: { name: "greeting-done" } });

      await vi.advanceTimersByTimeAsync(3000); // a retry window elapses
      audioOut._playing = false; // estimate catches up

      const ttsCountBefore = H.ttsTurns.length;
      // Next retry (<=2s) re-arms, then identify_intent nudge1 (6s) fires.
      await vi.advanceTimersByTimeAsync(2000 + 6000 + 100);
      expect(H.ttsTurns.length).toBeGreaterThan(ttsCountBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("8c. a barge-in followed by a filler-only final re-arms the silence timer (no permanent dead air)", async () => {
    vi.useFakeTimers();
    try {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({ event: "start", start: { callSid: sid, streamSid: "MZ8c", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } } });
      await vi.advanceTimersByTimeAsync(1);

      const tm = H.turnManagerInstances[0];
      // Caller barges in ("wait" cue) -> onInterrupt clears the silence timer...
      tm.opts.onInterrupt("uh");
      // ...and the final strips to nothing, so no turn starts.
      tm.opts.onTurnEnd("uh");

      const ttsCountBefore = H.ttsTurns.length;
      // The discard path must have re-armed the ladder: nudge1 at 6s.
      await vi.advanceTimersByTimeAsync(6000 + 2500);
      expect(H.ttsTurns.length).toBeGreaterThan(ttsCountBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Caller-speech suppression of the silence ladder.
  //
  // Regression cover for the bug this was built for: a caller with a long
  // request ran past the identify_intent nudge1 threshold (6s) and got
  // interrupted with "still there?" — and, if they kept going, hung up on at
  // 20s. The ladder is armed off the AI's playback mark and, before this,
  // had no input at all representing "the caller is talking right now".
  // -------------------------------------------------------------------------
  describe("8d. silence ladder vs. a caller who is still speaking", () => {
    async function startCall(streamSid) {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({
        event: "start",
        start: {
          callSid: sid,
          streamSid,
          customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      // The ladder is armed off a playback mark, so without this the tests
      // below would pass vacuously — nothing would ever have been scheduled.
      ws.emit({ event: "mark", mark: { name: "greeting-done" } });
      await vi.advanceTimersByTimeAsync(1);
      return ws;
    }

    it("never nudges during a 30s monologue (interim transcripts keep arriving)", async () => {
      vi.useFakeTimers();
      try {
        await startCall("MZ8d1");
        const stt = H.sttInstances[0];
        const ttsBefore = H.ttsTurns.length;

        // 30 seconds of continuous speech: an interim every second, well
        // past nudge1 (6s), nudge2 (12s) and the 20s hangup for this step.
        for (let i = 0; i < 30; i++) {
          stt.opts.onInterim("I need to book an appointment for my daughter next");
          await vi.advanceTimersByTimeAsync(1_000);
        }

        expect(H.ttsTurns.length).toBe(ttsBefore); // not one nudge, no goodbye
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes the ladder once the caller actually stops", async () => {
      vi.useFakeTimers();
      try {
        await startCall("MZ8d2");
        const stt = H.sttInstances[0];

        for (let i = 0; i < 10; i++) {
          stt.opts.onInterim("still talking");
          await vi.advanceTimersByTimeAsync(1_000);
        }
        const ttsBefore = H.ttsTurns.length;

        // Silence: the grace window lapses, then nudge1 (6s) fires. The
        // ladder re-checks every SILENCE_RETRY_MS, hence the slack.
        await vi.advanceTimersByTimeAsync(2_000 + 6_000 + 2_500);
        expect(H.ttsTurns.length).toBeGreaterThan(ttsBefore);
      } finally {
        vi.useRealTimers();
      }
    });

    it("still escalates on a permanently noisy line (suppression is capped)", async () => {
      vi.useFakeTimers();
      try {
        await startCall("MZ8d3");
        const stt = H.sttInstances[0];
        const ttsBefore = H.ttsTurns.length;

        // A TV in the background renews the window forever. Past
        // MAX_SUPPRESSION_MS (30s) the ladder must run anyway, or the call
        // could never reach its goodbye.
        for (let i = 0; i < 45; i++) {
          stt.opts.onInterim("background chatter");
          await vi.advanceTimersByTimeAsync(1_000);
        }

        expect(H.ttsTurns.length).toBeGreaterThan(ttsBefore);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores interims while the AI is speaking (no AEC — that is echo, not the caller)", async () => {
      vi.useFakeTimers();
      try {
        await startCall("MZ8d4");
        const stt = H.sttInstances[0];
        const audioOut = H.audioOutInstances[0];

        // The AI's own audio bleeding back must not be able to suppress the
        // ladder, or a stuck playback estimate would silence it for good.
        audioOut._playing = true;
        for (let i = 0; i < 5; i++) {
          stt.opts.onInterim("echo of the assistant");
          await vi.advanceTimersByTimeAsync(1_000);
        }
        audioOut._playing = false;

        const ttsBefore = H.ttsTurns.length;
        await vi.advanceTimersByTimeAsync(6_000 + 2_500);
        expect(H.ttsTurns.length).toBeGreaterThan(ttsBefore);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Incomplete-final holds
  // -------------------------------------------------------------------------
  describe("8e. mid-sentence pauses are waited out", () => {
    async function startCall(streamSid) {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({
        event: "start",
        start: {
          callSid: sid,
          streamSid,
          customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      return ws;
    }

    it("combines a trailing-off final with its continuation into ONE turn", async () => {
      vi.useFakeTimers();
      try {
        await startCall("MZ8e1");
        const tm = H.turnManagerInstances[0];
        const llmCallsBefore = runLlmTurn.mock.calls.length;

        tm.opts.onTurnEnd("I need to book an appointment for");
        await vi.advanceTimersByTimeAsync(1_200); // inside the 2s hold
        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore); // still waiting

        tm.opts.onTurnEnd("next Tuesday afternoon.");
        await vi.advanceTimersByTimeAsync(50);

        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore + 1);
        const text = runLlmTurn.mock.calls.at(-1)[0].userText;
        expect(text).toContain("book an appointment for");
        expect(text).toContain("next Tuesday");
      } finally {
        vi.useRealTimers();
      }
    });

    it("extends the hold when the caller resumes, even if only Deepgram noticed", async () => {
      // Reproduces an observed live call: the caller resumed 200ms before
      // the hold expired, but the only evidence was Deepgram's SpeechStarted
      // — the local energy VAD's hangover had already lapsed. The hold
      // flushed anyway and the continuation arrived as a SEPARATE turn that
      // barged into the reply to the first half. vad.isActive() alone is not
      // a sufficient "still talking" signal at hold-expiry time.
      vi.useFakeTimers();
      try {
        await startCall("MZ8e4");
        const tm = H.turnManagerInstances[0];
        const stt = H.sttInstances[0];
        const llmCallsBefore = runLlmTurn.mock.calls.length;

        tm.opts.onTurnEnd("I need to book an appointment for");

        // Caller makes a sound 100ms into the hold. The mocked VAD reports
        // isActive() === false, so a bare VAD check cannot see this.
        await vi.advanceTimersByTimeAsync(100);
        stt.opts.onSpeechStarted();

        // ...then Deepgram's UtteranceEnd lands ~1s later (utterance_end_ms
        // is 1000) and clears the ladder's "talking right now" flag. This is
        // what made the extension unfirable on real calls: by the time the
        // hold expires that flag is always gone.
        await vi.advanceTimersByTimeAsync(1_000);
        stt.opts.onUtteranceEnd();

        await vi.advanceTimersByTimeAsync(1_100); // past the 2s base hold

        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore); // extended, not flushed

        tm.opts.onTurnEnd("next Tuesday afternoon.");
        await vi.advanceTimersByTimeAsync(50);

        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore + 1); // ONE merged turn
        expect(runLlmTurn.mock.calls.at(-1)[0].userText).toContain("next Tuesday");
      } finally {
        vi.useRealTimers();
      }
    });

    it("makes each extension earn itself — one old sound cannot ride to the ceiling", async () => {
      // Observed live: a single speech signal at 14724ms produced extensions
      // at 16326, 16828 and 17341ms with nothing new in between, because the
      // check compared against holdStartedAt (which never changes during a
      // chain) and so latched true. The caller waited 6.7s voice-to-voice
      // and the turn split anyway.
      vi.useFakeTimers();
      try {
        await startCall("MZ8e5");
        const tm = H.turnManagerInstances[0];
        const stt = H.sttInstances[0];
        const llmCallsBefore = runLlmTurn.mock.calls.length;

        tm.opts.onTurnEnd("I need to book an appointment for");

        // ONE sound early in the hold, then nothing further.
        await vi.advanceTimersByTimeAsync(100);
        stt.opts.onSpeechStarted();

        // It buys a single 500ms extension past the 2s base...
        await vi.advanceTimersByTimeAsync(2_100);
        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore);

        // ...and then must give up, rather than extending again on the same
        // stale signal all the way to MAX_TOTAL_HOLD_MS.
        await vi.advanceTimersByTimeAsync(600);
        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("charges the hold to latency instead of hiding it (speech_end predates the flush)", async () => {
      // Regression cover: speech_end used to be stamped on entry to
      // startTurn, i.e. AFTER the hold, so a turn the caller waited 2s
      // extra for reported the same voice_to_voice_ms as one they didn't.
      vi.useFakeTimers();
      try {
        await startCall("MZ8e3");
        const tm = H.turnManagerInstances[0];
        const metrics = H.metricsInstances[0];

        tm.opts.onTurnEnd("I need to book an appointment for");
        await vi.advanceTimersByTimeAsync(2_100); // hold expires, turn starts

        const speechEnd = metrics.mark.mock.calls.find(([n]) => n === "speech_end");
        const sttFinal = metrics.mark.mock.calls.find(([n]) => n === "stt_final");
        expect(speechEnd).toBeTruthy();
        // Stamped explicitly from when the final arrived...
        expect(typeof speechEnd[1]).toBe("number");
        // ...and stt_final is left to default to "now", so the gap between
        // them is the hold. They must not be the same instant any more.
        expect(sttFinal[1]).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes at the ceiling rather than holding a rambling caller forever", async () => {
      vi.useFakeTimers();
      try {
        await startCall("MZ8e2");
        const tm = H.turnManagerInstances[0];
        const llmCallsBefore = runLlmTurn.mock.calls.length;

        // Each continuation is itself incomplete and would individually ask
        // for a fresh 3s hold, so without a ceiling on the CHAIN this would
        // renew indefinitely. Four finals 700ms apart = 2.8s of chain; the
        // ceiling must force a flush at 4.5s, not at 4 x 3s.
        for (let i = 0; i < 4; i++) {
          tm.opts.onTurnEnd("and");
          await vi.advanceTimersByTimeAsync(700);
        }
        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore); // still held at 2.8s

        await vi.advanceTimersByTimeAsync(2_000); // crosses the 4.5s ceiling
        expect(runLlmTurn.mock.calls.length).toBe(llmCallsBefore + 1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("11b. a successful cancel moves the step to confirm, persists identity, and records a system note", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Your appointment is cancelled." },
      {
        type: "done",
        reply: {
          text: "Your appointment is cancelled.",
          toolResults: [{ name: "cancel_appointment_db", success: true, message: "Cancelled.", appointmentId: "appt-1" }],
          capabilityEffects: [
            {
              capability: "appointments",
              type: "changed",
              data: { tool: "cancel_appointment_db" },
            },
          ],
          capabilityState: {
            appointments: {
              identityVerifiedApptId: "appt-1",
              selectedAppointmentId: null,
              lastBooked: null,
            },
          },
        },
      },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const tm = H.turnManagerInstances[0];
    tm.opts.onTurnEnd("cancel my appointment please");
    await flush();
    await flush();

    const state = callState.getState(sid);
    expect(state.step).toBe("confirm");
    expect(state.capabilityState.appointments.identityVerifiedApptId).toBe("appt-1");
    const note = state.history.find((h) => /\[system note/.test(h.parts?.[0]?.text || ""));
    expect(note).toBeTruthy();
    expect(note.parts[0].text).toMatch(/cancel_appointment_db succeeded/);
  });

  it("11c. a booked appointment stores the cross-turn idempotency anchor", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Booked!" },
      {
        type: "done",
        reply: {
          text: "Booked!",
          capabilityEffects: [
            {
              capability: "appointments",
              type: "booked",
              data: { scheduled_at: "2026-08-01T15:00:00.000Z", client_name: "Alex" },
            },
          ],
          capabilityState: {
            appointments: { lastBooked: { scheduled_at: "2026-08-01T15:00:00.000Z", client_name: "Alex" } },
          },
          toolResults: [{ name: "book_appointment", success: true, message: "Appointment booked successfully." }],
        },
      },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    H.turnManagerInstances[0].opts.onTurnEnd("book me an appointment");
    await flush();
    await flush();

    const state = callState.getState(sid);
    expect(state.capabilityState.appointments.lastBooked).toEqual({
      scheduled_at: "2026-08-01T15:00:00.000Z",
      client_name: "Alex",
    });
    const note = state.history.find((h) => /\[system note/.test(h.parts?.[0]?.text || ""));
    expect(note.parts[0].text).toMatch(/book_appointment succeeded.*Do not book it again/);
  });

  it("11d. a successful cancel clears the booking idempotency anchor", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "Cancelled." },
      {
        type: "done",
        reply: {
          text: "Cancelled.",
          toolResults: [{ name: "cancel_appointment_db", success: true, message: "Cancelled.", appointmentId: "appt-1" }],
          capabilityEffects: [
            {
              capability: "appointments",
              type: "changed",
              data: { tool: "cancel_appointment_db" },
            },
          ],
          capabilityState: { appointments: { lastBooked: null, selectedAppointmentId: null } },
        },
      },
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    const state = callState.getState(sid);
    state.capabilityState.appointments = {
      lastBooked: { scheduled_at: "2026-08-01T15:00:00.000Z", client_name: "Alex" },
    };

    H.turnManagerInstances[0].opts.onTurnEnd("cancel my appointment please");
    await flush();
    await flush();

    expect(state.capabilityState.appointments.lastBooked).toBeNull();
  });

  it("11e. a turn that dies before its done event still salvages a completed booking (state, note, SMS)", async () => {
    // The FC loop booked successfully, then the generator ended without a
    // done event (models a barge/timeout after the insert). The DB write is
    // real — its effects must survive.
    H.llmFactory = () => makeGen([
      {
        type: "toolEffect",
        effect: {
          name: "book_appointment",
          success: true,
          capabilityEffects: [
            {
              capability: "appointments",
              type: "booked",
              data: { scheduled_at: "2026-08-02T15:00:00.000Z", client_name: "Sam" },
            },
          ],
          capabilityState: {
            appointments: {
              lastBooked: { scheduled_at: "2026-08-02T15:00:00.000Z", client_name: "Sam" },
            },
          },
        },
      },
      // no done event
    ]);

    const ws = new FakeWs();
    handleVoiceSessionConnection(ws);
    const sid = newSid();
    await startCall(ws, sid);
    await flush();

    H.turnManagerInstances[0].opts.onTurnEnd("yes book it please");
    await flush();
    await flush();

    const state = callState.getState(sid);
    expect(state.capabilityState.appointments.lastBooked).toEqual({
      scheduled_at: "2026-08-02T15:00:00.000Z",
      client_name: "Sam",
    });
    expect(state.step).toBe("confirm");
    const note = state.history.find((h) => /\[system note/.test(h.parts?.[0]?.text || ""));
    expect(note.parts[0].text).toMatch(/book_appointment succeeded.*Do not book it again/);

    const notifications = await import("../services/notifications.js");
    expect(notifications.sendCallerSms).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "appointment_confirmation",
      expect.objectContaining({ name: "Sam" })
    );
  });

  it("12a. a booked appointment sends the caller an appointment_confirmation SMS", async () => {
    H.llmFactory = () => makeGen([
      { type: "delta", text: "You're all set!" },
      {
        type: "done",
        reply: {
          text: "You're all set!",
          capabilityEffects: [
            {
              capability: "appointments",
              type: "booked",
              data: {
                scheduled_at: "2026-08-01T15:00:00.000Z",
                client_name: "Alex",
                service_type: "Checkup",
              },
            },
          ],
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
          capabilityEffects: [
            {
              capability: "messages",
              type: "recorded",
              data: { request_type: "message", caller_name: "Sam", message: "Call me back" },
            },
          ],
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

    it("11c. filler: a Google-provider business uses a cache hit for the exact filler text instead of a live googleTts.synthesizeMulaw call", async () => {
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

    describe("Fix 3 — mid-call voice consistency for cached micro-utterances", () => {
      it("filler: an ElevenLabs business bypasses the Google-voiced cache and speaks the filler through the live per-business TTS turn instead", async () => {
        // Default mocked loadConfig is voiceProvider: "elevenlabs".
        const cachedFiller = Buffer.from([9, 9]);
        H.utteranceCacheInstance.get.mockImplementation((voiceKey, kind, text) =>
          kind === "filler" && text === "One moment." ? cachedFiller : null
        );

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
        // The Google-cached buffer must never be used for an ElevenLabs business.
        expect(audioOut.enqueue).not.toHaveBeenCalledWith(cachedFiller);
        expect(mockSynthesizeMulaw.mock.calls.length).toBe(callsBefore);
        // Instead, the filler text was written into the SAME (business-voiced)
        // TTS turn as the reply itself — proving it plays in the business voice.
        const turnTts = H.ttsTurns.find((t) =>
          t.write.mock.calls.some(([txt]) => txt === "One moment.")
        );
        expect(turnTts).toBeTruthy();
        expect(turnTts.write.mock.calls.some(([txt]) => txt === "Sure, I can help.")).toBe(true);
      });

      it("silence nudge: an ElevenLabs business with only a Google-voiced cache entry speaks the nudge live (business voice), never that Google buffer", async () => {
        vi.useFakeTimers();
        try {
          const cachedNudge = Buffer.from([7, 7]);
          // A Google-voiced entry exists (keyed by the Google fallback voice),
          // but this EL business looks the nudge up under its EL voiceId
          // ("voice-xyz") — a warm-EL miss — so it must speak LIVE, never play
          // the Google-voiced buffer.
          H.utteranceCacheInstance.get.mockImplementation((voiceKey, kind, text) =>
            voiceKey !== "voice-xyz" && text === "I'm still here whenever you're ready." ? cachedNudge : null
          );

          const ws = new FakeWs();
          handleVoiceSessionConnection(ws);
          const sid = `CA-session-fake-${++sidCounter}`;
          ws.emit({
            event: "start",
            start: { callSid: sid, streamSid: "MZv1", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } },
          });
          await vi.advanceTimersByTimeAsync(1);

          const ttsCountBefore = H.ttsTurns.length;
          ws.emit({ event: "mark", mark: { name: "greeting-done" } }); // arms the silence timer
          await vi.advanceTimersByTimeAsync(6000); // identify_intent nudge1 threshold

          const audioOut = H.audioOutInstances[0];
          expect(audioOut.enqueue).not.toHaveBeenCalledWith(cachedNudge);
          expect(H.ttsTurns.length).toBeGreaterThan(ttsCountBefore);
          const nudgeTurn = H.ttsTurns[H.ttsTurns.length - 1];
          expect(nudgeTurn.write).toHaveBeenCalledWith("I'm still here whenever you're ready.");
        } finally {
          vi.useRealTimers();
        }
      });

      it("silence nudge: a Google-provider business still uses the Google-voiced cache", async () => {
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

        vi.useFakeTimers();
        try {
          const cachedNudge = Buffer.from([7, 7]);
          H.utteranceCacheInstance.get.mockImplementation((voiceKey, kind, text) =>
            text === "I'm still here whenever you're ready." ? cachedNudge : null
          );

          const ws = new FakeWs();
          handleVoiceSessionConnection(ws);
          const sid = `CA-session-fake-${++sidCounter}`;
          ws.emit({
            event: "start",
            start: { callSid: sid, streamSid: "MZv2", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } },
          });
          await vi.advanceTimersByTimeAsync(1);

          ws.emit({ event: "mark", mark: { name: "greeting-done" } });
          await vi.advanceTimersByTimeAsync(6000);

          const audioOut = H.audioOutInstances[0];
          expect(audioOut.enqueue).toHaveBeenCalledWith(cachedNudge);
        } finally {
          vi.useRealTimers();
        }
      });

      it("silence goodbye: an ElevenLabs business speaks the hangup goodbye live, bypassing a Google cache hit", async () => {
        vi.useFakeTimers();
        try {
          // The business's own main_phone (+18175803291), spoken as digit
          // groups — NOT the transfer target (+15551234567) and not raw E.164.
          const goodbyeText = "It seems like you may have stepped away. Feel free to call us back at 817 580 3291 anytime. Have a great day. Goodbye!";
          const cachedGoodbye = Buffer.from([5, 5]);
          // Google-voiced entry present, but the EL business looks it up under
          // its EL voiceId — a warm-EL miss — so the goodbye is spoken live in
          // the business voice, never the Google buffer.
          H.utteranceCacheInstance.get.mockImplementation((voiceKey, kind, text) =>
            voiceKey !== "voice-xyz" && text === goodbyeText ? cachedGoodbye : null
          );

          const ws = new FakeWs();
          handleVoiceSessionConnection(ws);
          const sid = `CA-session-fake-${++sidCounter}`;
          ws.emit({
            event: "start",
            start: { callSid: sid, streamSid: "MZv3", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } },
          });
          await vi.advanceTimersByTimeAsync(1);

          ws.emit({ event: "mark", mark: { name: "greeting-done" } });
          // identify_intent thresholds: nudge1=6000, nudge2=12000, hangup=20000.
          await vi.advanceTimersByTimeAsync(21000);

          const audioOut = H.audioOutInstances[0];
          expect(audioOut.enqueue).not.toHaveBeenCalledWith(cachedGoodbye);
          const goodbyeTurn = H.ttsTurns.find((t) =>
            t.write.mock.calls.some(([txt]) => txt === goodbyeText)
          );
          expect(goodbyeTurn).toBeTruthy();
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  // ---------------------------------------------------------------------
  // 14. TTS previous_text prosody continuity — session-level wiring
  // (Task 13 review fix round 1). The unit-level ElevenLabs handshake
  // behavior (trimming, omission on empty, the kill-switch) is covered in
  // tests/ttsStream.test.js and services/elevenlabs.js's own tests; these
  // cover the ORCHESTRATION session.js does around lastSpokenText: the
  // greeting anchors turn 1, each turn anchors the next, and a barge-in
  // (of either the greeting or a turn) must not leave a stale/partial
  // anchor for whatever speaks next.
  // ---------------------------------------------------------------------
  describe("14. previous_text prosody-continuity wiring (greeting -> turn -> turn, barge-in guards)", () => {
    it("14a. turn-to-turn: turn 2's TTS connection receives turn 1's actually-spoken text as previousText", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "Sure, I can help." },
        { type: "done", reply: { text: "Sure, I can help.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const turn1Tts = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn1Tts.write).toHaveBeenCalledWith("Sure, I can help.");

      // Turn 2 — a different reply — must continue from turn 1's spoken text,
      // not the greeting and not empty.
      H.llmFactory = () => makeGen([
        { type: "delta", text: "We open at nine." },
        { type: "done", reply: { text: "We open at nine.", toolResults: [] } },
      ]);
      tm.opts.onTurnEnd("what time do you open");
      await flush();
      await flush();

      const turn2Tts = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn2Tts).not.toBe(turn1Tts);
      expect(turn2Tts.opts.previousText).toBe("Sure, I can help.");
      expect(turn2Tts.write).toHaveBeenCalledWith("We open at nine.");
    });

    it("14b. greeting is turn 1's prosody anchor once it finishes without a barge-in", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "Our hours are nine to five." },
        { type: "done", reply: { text: "Our hours are nine to five.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const greetingTurn = H.ttsTurns[0];
      // Simulate the greeting's TTS turn completing normally — the same
      // shape ttsStream.js's finishDone() calls onDone with (see
      // tests/ttsStream.test.js #4).
      greetingTurn.opts.onDone({});

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const turn1Tts = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn1Tts.opts.previousText).toBe("Hello, thanks for calling Test Biz.");
    });

    it("14c. a barged greeting must NOT become turn 1's previous_text anchor", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "Our hours are nine to five." },
        { type: "done", reply: { text: "Our hours are nine to five.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const tm = H.turnManagerInstances[0];
      // Caller barges in mid-greeting: onInterrupt bumps state.speakEpoch and
      // aborts the greeting's activeTts. In production the aborted
      // connection never confirms isFinal, so onDone never fires — modeled
      // here by simply never calling greetingTurn.opts.onDone.
      tm.opts.onInterrupt("wait");
      await flush();

      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const turn1Tts = H.ttsTurns[H.ttsTurns.length - 1];
      // Must stay at its initial empty value — NOT the full greeting text
      // (the bug this fix closes) and not any other stale value.
      expect(turn1Tts.opts.previousText).toBe("");
    });

    /**
     * A next()-suspendable fake generator, local to this describe block: the
     * initial scripted events resolve immediately, then next() returns a
     * promise that stays pending until either onInterrupt's
     * activeGenerator.return() settles it (simulating a real async
     * generator's cancellation unblocking a suspended consumer) or the test
     * settles it directly. Needed only for 14d, which must interleave a
     * barge-in BETWEEN a turn having already spoken some text and that
     * turn's generator loop actually observing the epoch bump — makeGen's
     * hang:true (used by test "4.") resolves its pending next() never, which
     * would leave the for-await loop (and this test) stuck forever.
     */
    function makeSuspendableGen(initialEvents) {
      let resolveNext = null;
      let idx = 0;
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (idx < initialEvents.length) {
            return Promise.resolve({ value: initialEvents[idx++], done: false });
          }
          return new Promise((res) => { resolveNext = res; });
        },
        return(v) {
          resolveNext?.({ value: undefined, done: true });
          resolveNext = null;
          return Promise.resolve({ value: v, done: true });
        },
      };
    }

    it("14d. a barged turn's own (partial) spoken text must not contaminate the NEXT turn's anchor", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "Our hours are nine to five." },
        { type: "done", reply: { text: "Our hours are nine to five.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const greetingTurn = H.ttsTurns[0];
      greetingTurn.opts.onDone({}); // greeting settles -> anchor = greeting text

      const tm = H.turnManagerInstances[0];

      // Turn 1 speaks a full sentence (so it DOES write to tts, proving there
      // really is partial spoken text at risk of being committed), then its
      // generator suspends instead of reaching "done" — the barge-in happens
      // while it is still the current turn.
      H.llmFactory = () => makeSuspendableGen([{ type: "delta", text: "Let me check that for you. " }]);
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const turn1Tts = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn1Tts.write).toHaveBeenCalledWith("Let me check that for you.");

      // Caller barges in before turn 1 ever reaches its "done" event. This
      // resolves the suspended generator's pending next() (via return()),
      // letting the for-await loop's post-loop epoch check run and bail out
      // WITHOUT committing turn 1's partial text as the new anchor.
      tm.opts.onInterrupt("wait");
      await flush();

      // Turn 2 begins.
      H.llmFactory = () => makeGen([
        { type: "delta", text: "We're open every day." },
        { type: "done", reply: { text: "We're open every day.", toolResults: [] } },
      ]);
      tm.opts.onTurnEnd("what are your hours today");
      // The post-barge settle holds this final before it becomes a turn (see
      // POST_BARGE_SETTLE_MS), so turn 2 no longer starts on the same tick as
      // the final that triggers it. Identify turn 2 by what it SPEAKS rather
      // than by position: flushUntil spins real time, during which another
      // test's still-pending timers can append to the shared ttsTurns array.
      const spokeTurn2 = (t) =>
        t.opts.callSid === sid &&
        t.write.mock.calls.some((c) => /open every day/.test(c[0] || ""));
      await flushUntil(() => H.ttsTurns.some(spokeTurn2));

      const turn2Tts = H.ttsTurns.find(spokeTurn2);
      expect(turn2Tts).toBeDefined();
      expect(turn2Tts).not.toBe(turn1Tts);
      // Still the greeting — turn 1's barged partial text never overwrote it.
      expect(turn2Tts.opts.previousText).toBe("Hello, thanks for calling Test Biz.");
    });

    it("14e. a truncated turn anchors the NEXT turn to what was actually voiced (spokenText), not the full reply", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "Sure, I can help with that." },
        { type: "done", reply: { text: "Sure, I can help with that.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const turn1Tts = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn1Tts.write).toHaveBeenCalledWith("Sure, I can help with that.");

      // ElevenLabs died mid-turn; ttsStream repaired part of it but a barge
      // during the repair meant only "Sure, I can help" was actually voiced.
      // finishDone reports that via spokenText — the anchor must narrow to it,
      // NOT the full reply the caller never fully heard.
      turn1Tts.opts.onDone({
        truncated: true,
        repairedFrom: "duration",
        remainderChars: 11,
        spokenText: "Sure, I can help",
      });

      // Turn 2 must continue from the actually-voiced text.
      H.llmFactory = () => makeGen([
        { type: "delta", text: "We open at nine." },
        { type: "done", reply: { text: "We open at nine.", toolResults: [] } },
      ]);
      tm.opts.onTurnEnd("what time do you open");
      await flush();
      await flush();

      const turn2Tts = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn2Tts).not.toBe(turn1Tts);
      expect(turn2Tts.opts.previousText).toBe("Sure, I can help");
    });
  });

  // ---------------------------------------------------------------------
  // 15. Task 17 — mid-call voice consistency.
  //   A) micro-utterances warmed/played in the business's own EL voice
  //   B) sticky-Google after a REAL full-turn fallback (no engine ping-pong)
  // ---------------------------------------------------------------------
  describe("15. mid-call voice consistency (warm EL cache + sticky-Google)", () => {
    it("15A-a. warms the business's ElevenLabs voice (voiceId) with an EL synthesize override", async () => {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());

      expect(H.utteranceCacheInstance.warm).toHaveBeenCalledTimes(1);
      const [voiceKey, entries, opts] = H.utteranceCacheInstance.warm.mock.calls[0];
      // EL business warms under its EL voiceId, not the Google voice.
      expect(voiceKey).toBe("voice-xyz");
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.some((e) => e.text === "One moment.")).toBe(true);
      // With a per-call EL synthesizer so the warmed audio is EL-voiced.
      expect(typeof opts?.synthesize).toBe("function");
    });

    it("15A-b. a Google-provider business warms the Google voice with the DEFAULT backend (no EL override)", async () => {
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
      await startCall(ws, newSid());

      expect(H.utteranceCacheInstance.warm).toHaveBeenCalledTimes(1);
      const call = H.utteranceCacheInstance.warm.mock.calls[0];
      expect(call[0]).toBe("en-US-Chirp3-HD-Aoede"); // locale-matched Google voice
      expect(call[2]).toBeUndefined(); // no synthesize override — default (Google) backend
    });

    it("15A-c. a warm-EL cache HIT plays the pre-warmed EL buffer for a nudge — no live TTS turn", async () => {
      vi.useFakeTimers();
      try {
        const warmEl = Buffer.from([4, 2]);
        // Hit ONLY under the EL voiceId — the business's own warmed voice.
        H.utteranceCacheInstance.get.mockImplementation((voiceKey, kind, text) =>
          voiceKey === "voice-xyz" && text === "I'm still here whenever you're ready." ? warmEl : null
        );

        const ws = new FakeWs();
        handleVoiceSessionConnection(ws);
        const sid = `CA-session-fake-${++sidCounter}`;
        ws.emit({
          event: "start",
          start: { callSid: sid, streamSid: "MZ15a", customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" } },
        });
        await vi.advanceTimersByTimeAsync(1);

        const ttsCountBefore = H.ttsTurns.length;
        ws.emit({ event: "mark", mark: { name: "greeting-done" } });
        await vi.advanceTimersByTimeAsync(6000); // identify_intent nudge1

        const audioOut = H.audioOutInstances[0];
        // The warm EL buffer was played directly — zero-latency, no live turn.
        expect(audioOut.enqueue).toHaveBeenCalledWith(warmEl);
        expect(H.ttsTurns.length).toBe(ttsCountBefore);
      } finally {
        vi.useRealTimers();
      }
    });

    it("15B-a. a REAL full-turn Google fallback makes the call sticky-Google — the next turn skips ElevenLabs", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "Sure." },
        { type: "done", reply: { text: "Sure.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const turn1 = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn1.opts.forceFallback).toBe(false); // EL attempted for turn 1

      // This turn actually played a full-turn Google fallback.
      turn1.opts.onDone({ usedFallback: true });

      H.llmFactory = () => makeGen([
        { type: "delta", text: "We open at nine." },
        { type: "done", reply: { text: "We open at nine.", toolResults: [] } },
      ]);
      tm.opts.onTurnEnd("what time do you open");
      await flush();
      await flush();

      const turn2 = H.ttsTurns[H.ttsTurns.length - 1];
      expect(turn2).not.toBe(turn1);
      // Sticky-Google engaged — no ElevenLabs attempt on the later turn.
      expect(turn2.opts.forceFallback).toBe(true);
    });

    it("15B-b. an isTurn=false utterance (greeting/nudge) reporting a fallback does NOT make the call sticky", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "Sure." },
        { type: "done", reply: { text: "Sure.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());

      // The greeting (a fixed, isTurn=false utterance, like a silence nudge)
      // fell back to Google — but a micro-utterance fallback must NOT stick.
      const greetingTurn = H.ttsTurns[0];
      greetingTurn.opts.onDone({ usedFallback: true });

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("hello");
      await flush();
      await flush();

      const realTurn = H.ttsTurns[H.ttsTurns.length - 1];
      expect(realTurn).not.toBe(greetingTurn);
      // ElevenLabs still attempted — the call did not go sticky-Google.
      expect(realTurn.opts.forceFallback).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 16. Post-barge settle + barge recovery
  //
  // The bug these exist for, observed live on speakerphone: the caller
  // interrupts, the AI stops, the caller pauses a beat to gather the thought,
  // the AI answers the instant Deepgram endpoints (300ms), the caller resumes
  // and talks over it, the AI stops again — and the loop only ends when the
  // caller gives up and goes silent. Every test below pins one link of that
  // chain open.
  // -------------------------------------------------------------------------
  describe("16. post-barge settle", () => {
    async function startFakeTimerCall(streamSid) {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = `CA-session-fake-${++sidCounter}`;
      ws.emit({
        event: "start",
        start: {
          callSid: sid,
          streamSid,
          customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      return { ws, sid };
    }

    it("16a. a COMPLETE final arriving right after a barge is held for the settle, not sent straight to the LLM", async () => {
      vi.useFakeTimers();
      try {
        await startFakeTimerCall("MZ16a");
        const tm = H.turnManagerInstances[0];
        const before = runLlmTurn.mock.calls.length;

        // A COMPLETE utterance (isIncomplete false => classifyHold never
        // runs, wantedHoldMs 0). Without the settle this reaches the LLM on
        // the same tick.
        tm.opts.onInterrupt("wait");
        tm.opts.onTurnEnd("That is not what I meant.");
        await vi.advanceTimersByTimeAsync(200);
        expect(runLlmTurn.mock.calls.length).toBe(before); // settling

        await vi.advanceTimersByTimeAsync(600); // past POST_BARGE_SETTLE_MS
        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("16b. barge -> brief pause -> caller resumes: both halves reach the LLM as ONE turn", async () => {
      // The exact reported sequence. Two turns here is the bug.
      vi.useFakeTimers();
      try {
        await startFakeTimerCall("MZ16b");
        const tm = H.turnManagerInstances[0];
        const before = runLlmTurn.mock.calls.length;

        tm.opts.onInterrupt("no");
        tm.opts.onTurnEnd("No, that's not what I meant.");
        await vi.advanceTimersByTimeAsync(300);

        // The caller was not finished — they resume mid-settle.
        tm.opts.onTurnEnd("I wanted the Thursday slot instead.");
        await vi.advanceTimersByTimeAsync(1_500);

        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
        const text = runLlmTurn.mock.calls.at(-1)[0].userText;
        expect(text).toContain("not what I meant");
        expect(text).toContain("Thursday slot");
      } finally {
        vi.useRealTimers();
      }
    });

    it("16c. the settle cannot outlast the hold-chain ceiling", async () => {
      vi.useFakeTimers();
      try {
        await startFakeTimerCall("MZ16c");
        const tm = H.turnManagerInstances[0];
        const stt = H.sttInstances[0];
        const before = runLlmTurn.mock.calls.length;

        tm.opts.onInterrupt("wait");
        tm.opts.onTurnEnd("hold on I need to");

        // Caller keeps making noise, earning extension after extension.
        for (let i = 0; i < 12; i++) {
          await vi.advanceTimersByTimeAsync(400);
          stt.opts.onSpeechStarted();
        }
        await vi.advanceTimersByTimeAsync(1_000);

        // Flushed at the ceiling rather than held forever.
        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("16d. an ordinary complete final with no recent barge is NOT delayed", async () => {
      // The settle costs latency, so it must apply ONLY after an
      // interruption. This is the regression guard for every normal turn.
      vi.useFakeTimers();
      try {
        await startFakeTimerCall("MZ16d");
        const tm = H.turnManagerInstances[0];
        const before = runLlmTurn.mock.calls.length;

        tm.opts.onTurnEnd("That is not what I meant.");
        await vi.advanceTimersByTimeAsync(20);

        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("16d2. a barge older than BARGE_SETTLE_TTL_MS no longer delays a final", async () => {
      vi.useFakeTimers();
      try {
        await startFakeTimerCall("MZ16d2");
        const tm = H.turnManagerInstances[0];

        tm.opts.onInterrupt("wait");
        await vi.advanceTimersByTimeAsync(11_000); // past the 10s TTL

        const before = runLlmTurn.mock.calls.length;
        tm.opts.onTurnEnd("That is not what I meant.");
        await vi.advanceTimersByTimeAsync(20);

        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("16e. a barge with NO following final still leaves the ladder armed (no permanent dead air)", async () => {
      // onInterrupt clears the silence timer and its turn's -done mark is
      // epoch-suppressed, so nothing else can re-arm. An interim-triggered
      // barge whose utterance turns out to be empty/filler/echo used to
      // strand the call in silence for the rest of its duration.
      vi.useFakeTimers();
      try {
        await startFakeTimerCall("MZ16e");
        const tm = H.turnManagerInstances[0];
        const ttsBefore = H.ttsTurns.length;

        tm.opts.onInterrupt("wait");
        // No onTurnEnd ever follows.
        await vi.advanceTimersByTimeAsync(30_000);

        expect(H.ttsTurns.length).toBeGreaterThan(ttsBefore);
      } finally {
        vi.useRealTimers();
      }
    });

    it("16f. a barge clears turnManager's interrupt latch so the caller can interrupt again", async () => {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());
      await flush();

      const tm = H.turnManagerInstances[0];
      expect(tm.reset).not.toHaveBeenCalled();
      tm.opts.onInterrupt("wait");
      await flush();
      expect(tm.reset).toHaveBeenCalled();
    });

    it("16g. text queued behind an in-flight turn is folded into the barge, not replayed on a later turn", async () => {
      // startTurn's finally only replays queuedText when the epoch still
      // matches, which a barge guarantees it does not — so without folding it
      // in, this text resurfaced minutes later as a fresh caller utterance.
      vi.useFakeTimers();
      try {
        const hanging = makeGen([{ type: "delta", text: "Let me check " }], { hang: true });
        H.llmFactory = () => hanging;
        await startFakeTimerCall("MZ16g");
        const tm = H.turnManagerInstances[0];

        tm.opts.onTurnEnd("what are your hours");
        await vi.advanceTimersByTimeAsync(10);

        // Arrives while the LLM is still streaming -> queuedText.
        tm.opts.onTurnEnd("and your address");
        await vi.advanceTimersByTimeAsync(10);

        H.llmFactory = () => makeGen([
          { type: "delta", text: "Sure." },
          { type: "done", reply: { text: "Sure.", toolResults: [] } },
        ]);

        const before = runLlmTurn.mock.calls.length;
        tm.opts.onInterrupt("wait");
        // Deliberately free of self-correction markers ("actually", "no,",
        // "sorry") — extractFinalIntent would otherwise drop the folded-in
        // prefix and this would stop testing what it claims to.
        tm.opts.onTurnEnd("just the address please.");
        await vi.advanceTimersByTimeAsync(2_000);

        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
        const text = runLlmTurn.mock.calls.at(-1)[0].userText;
        expect(text).toContain("your address");
        expect(text).toContain("just the address");

        // And it is not replayed again afterwards.
        const after = runLlmTurn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runLlmTurn.mock.calls.length).toBe(after);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 17. Self-echo (lib/voice/echoGuard.js is NOT mocked here — these drive the
  //     real matcher through the real session wiring)
  // -------------------------------------------------------------------------
  describe("17. the AI never answers its own voice", () => {
    /** Make the playback-window check always pass, as it does on a live call. */
    function alwaysAudible() {
      H.audioOutInstances[0].aiAudioPlayingUntil.mockReturnValue(Number.MAX_SAFE_INTEGER);
    }

    it("17a. the greeting coming back through the caller's mic never becomes a turn", async () => {
      // The live speakerphone failure: Deepgram transcribes the AI's own
      // greeting, it clears the 4-word bar, and the session answers it — which
      // produces more audio, which echoes again.
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());
      await flush();

      alwaysAudible();
      const tm = H.turnManagerInstances[0];
      const before = runLlmTurn.mock.calls.length;

      tm.opts.onTurnEnd("Hello, thanks for calling Test Biz");
      await flush();
      await flush();

      expect(runLlmTurn.mock.calls.length).toBe(before);
      expect(log.debug).toHaveBeenCalledWith(
        "transcript_discarded",
        expect.objectContaining({ reason: "echo" })
      );
    });

    it("17b. a real caller utterance during the same window is still answered", async () => {
      // The guard must not become a general mute button.
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());
      await flush();

      alwaysAudible();
      const tm = H.turnManagerInstances[0];
      const before = runLlmTurn.mock.calls.length;

      tm.opts.onTurnEnd("I need to book an appointment for next week");
      await flush();
      await flush();

      expect(runLlmTurn.mock.calls.length).toBe(before + 1);
    });

    it("17c. an echo final rejected by turnManager still leaves the silence ladder armed", async () => {
      // An echo never reaches onTurnEnd, so nothing downstream re-arms the
      // ladder. Without the explicit re-arm in onFinal, a line that echoes
      // could leave the call silent for good.
      vi.useFakeTimers();
      try {
        const ws = new FakeWs();
        handleVoiceSessionConnection(ws);
        const sid = `CA-session-fake-${++sidCounter}`;
        ws.emit({
          event: "start",
          start: {
            callSid: sid,
            streamSid: "MZ17c",
            customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
          },
        });
        await vi.advanceTimersByTimeAsync(1);

        const tm = H.turnManagerInstances[0];
        const stt = H.sttInstances[0];
        tm.handleFinal.mockReturnValue({ action: "ignore", reason: "echo" });

        const ttsBefore = H.ttsTurns.length;
        stt.opts.onFinal("we are open monday through friday");
        await vi.advanceTimersByTimeAsync(30_000);

        expect(H.ttsTurns.length).toBeGreaterThan(ttsBefore);
      } finally {
        vi.useRealTimers();
      }
    });

    it("17d. an echo interim does not extend the post-barge settle", async () => {
      // Otherwise the stutter loop is simply traded for a hold that never
      // releases: every echo interim stamps the caller-speech window, and
      // onHoldExpired keeps earning another extension from it.
      vi.useFakeTimers();
      try {
        const ws = new FakeWs();
        handleVoiceSessionConnection(ws);
        const sid = `CA-session-fake-${++sidCounter}`;
        ws.emit({
          event: "start",
          start: {
            callSid: sid,
            streamSid: "MZ17d",
            customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
          },
        });
        await vi.advanceTimersByTimeAsync(1);

        H.audioOutInstances[0].aiAudioPlayingUntil.mockReturnValue(Number.MAX_SAFE_INTEGER);
        const tm = H.turnManagerInstances[0];
        const stt = H.sttInstances[0];
        const before = runLlmTurn.mock.calls.length;

        tm.opts.onInterrupt("wait");
        tm.opts.onTurnEnd("That is not what I meant.");

        // The AI's own greeting keeps arriving as interims through the settle.
        for (let i = 0; i < 6; i++) {
          await vi.advanceTimersByTimeAsync(300);
          stt.opts.onInterim("Hello, thanks for calling Test Biz", { confidence: 0.9 });
        }

        // The settle released on schedule instead of being pushed out.
        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 18. Loop breaker
  //
  // The backstop for the reported failure mode: a start/stop loop that never
  // ends on its own. These tests assert termination, not diagnosis — the
  // breaker deliberately knows nothing about WHY the AI keeps being cut off.
  // -------------------------------------------------------------------------
  describe("18. runaway barge-in backstop", () => {
    it("18a. three barge-ins in quick succession stop the audio outright", async () => {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());
      await flush();

      const tm = H.turnManagerInstances[0];
      const audioOut = H.audioOutInstances[0];

      tm.opts.onInterrupt("wait");
      tm.opts.onInterrupt("wait");
      expect(log.info).not.toHaveBeenCalledWith("loop_breaker_tripped", expect.anything());

      tm.opts.onInterrupt("wait");
      await flush();

      expect(log.info).toHaveBeenCalledWith(
        "loop_breaker_tripped",
        expect.objectContaining({ barges: 3 })
      );
      // A HARD clear (no fade): trailing off gracefully still emits audio, and
      // emitting audio is what keeps the loop alive.
      expect(audioOut.clear).toHaveBeenCalledWith();
    });

    it("18b. while yielding, a final arriving over live AI audio does not restart the loop", async () => {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());
      await flush();

      const tm = H.turnManagerInstances[0];
      const audioOut = H.audioOutInstances[0];
      tm.opts.onInterrupt("wait");
      tm.opts.onInterrupt("wait");
      tm.opts.onInterrupt("wait");
      await flush();

      audioOut._playing = true; // AI audio still going out
      const before = runLlmTurn.mock.calls.length;
      tm.opts.onTurnEnd("I need to book an appointment for next week");
      await flush();
      await flush();

      expect(runLlmTurn.mock.calls.length).toBe(before);
      expect(log.debug).toHaveBeenCalledWith(
        "transcript_discarded",
        expect.objectContaining({ reason: "loop_breaker_yield" })
      );
    });

    it("18c. one clean caller utterance with the line quiet resumes normal service", async () => {
      vi.useFakeTimers();
      try {
        const ws = new FakeWs();
        handleVoiceSessionConnection(ws);
        const sid = `CA-session-fake-${++sidCounter}`;
        ws.emit({
          event: "start",
          start: {
            callSid: sid,
            streamSid: "MZ18c",
            customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
          },
        });
        await vi.advanceTimersByTimeAsync(1);

        const tm = H.turnManagerInstances[0];
        tm.opts.onInterrupt("wait");
        tm.opts.onInterrupt("wait");
        tm.opts.onInterrupt("wait");

        const before = runLlmTurn.mock.calls.length;
        tm.opts.onTurnEnd("I need to book an appointment for next week");
        await vi.advanceTimersByTimeAsync(2_000); // outwait the post-barge settle

        expect(runLlmTurn.mock.calls.length).toBe(before + 1);
        expect(log.info).toHaveBeenCalledWith(
          "loop_breaker_released",
          expect.objectContaining({ callSid: sid })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("18d. barge-ins spread out over a long call never trip it", async () => {
      // Ordinary interruptions are a feature. Only a RATE is pathological.
      vi.useFakeTimers();
      try {
        const ws = new FakeWs();
        handleVoiceSessionConnection(ws);
        const sid = `CA-session-fake-${++sidCounter}`;
        ws.emit({
          event: "start",
          start: {
            callSid: sid,
            streamSid: "MZ18d",
            customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
          },
        });
        await vi.advanceTimersByTimeAsync(1);

        const tm = H.turnManagerInstances[0];
        for (let i = 0; i < 5; i++) {
          tm.opts.onInterrupt("wait");
          await vi.advanceTimersByTimeAsync(7_000); // outside the 6s window
        }

        expect(log.info).not.toHaveBeenCalledWith("loop_breaker_tripped", expect.anything());
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 19. An interrupted exchange survives in history
  //
  // A barged turn returns before applyReply, so the caller's question AND the
  // partial answer used to vanish. The next turn was then generated from
  // history ending before the interruption — which is why the reply after an
  // interruption sounded new and unrelated rather than like a continuation.
  // -------------------------------------------------------------------------
  describe("19. barge history coherence", () => {
    it("19a. records the caller's question, the audible part of the reply, and an interrupted note", async () => {
      H.llmFactory = () => makeGen(
        [{ type: "delta", text: "We are open from nine until five. " }],
        { hang: true }
      );

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);
      await flush();

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      const state = callState.getState(sid);
      const before = state.history.length;

      tm.opts.onInterrupt("wait");
      await flush();

      const added = state.history.slice(before);
      expect(added.length).toBe(3);
      expect(added[0]).toEqual({ role: "user", parts: [{ text: "what are your hours" }] });
      expect(added[1].role).toBe("model");
      expect(added[1].parts[0].text).toContain("open from nine until five");
      expect(added[2].role).toBe("user");
      expect(added[2].parts[0].text).toMatch(/interrupted you/i);
    });

    it("19b. records only what the caller actually HEARD, not everything handed to TTS", async () => {
      // audioOut still holds unplayed audio at the moment of the barge; that
      // part was never heard, so the model must not be told it said it.
      H.llmFactory = () => makeGen(
        [
          { type: "delta", text: "We are open from nine until five. " },
          { type: "delta", text: "We also open on Saturday mornings. " },
        ],
        { hang: true }
      );

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);
      await flush();

      const tm = H.turnManagerInstances[0];
      const audioOut = H.audioOutInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      // ~1.5s of audio still queued. At REPAIR_CHARS_PER_SEC that is ~22
      // unheard characters, and rounding DOWN to a sentence boundary lands
      // just after "...until five." — so the Saturday sentence, which was
      // written to TTS but never played, must not appear in history.
      audioOut.aiAudioPlayingUntil.mockReturnValue(performance.now() + 1_500);

      const state = callState.getState(sid);
      const before = state.history.length;
      tm.opts.onInterrupt("wait");
      await flush();

      const model = state.history.slice(before).find((h) => h.role === "model");
      expect(model.parts[0].text).toContain("open from nine until five");
      expect(model.parts[0].text).not.toContain("Saturday");
    });

    it("19c. barging the greeting records nothing (there is no caller turn to record)", async () => {
      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);
      await flush();

      const state = callState.getState(sid);
      const before = state.history.length;

      tm_barge: {
        const tm = H.turnManagerInstances[0];
        tm.opts.onInterrupt("wait");
      }
      await flush();

      expect(state.history.length).toBe(before);
    });

    it("19d. the record lands BEFORE the successor turn's LLM request is built", async () => {
      // The ordering that justifies doing this synchronously in onInterrupt
      // rather than in the barged generator's bail-out path.
      H.llmFactory = () => makeGen(
        [{ type: "delta", text: "We are open from nine until five. " }],
        { hang: true }
      );

      vi.useFakeTimers();
      try {
        const ws = new FakeWs();
        handleVoiceSessionConnection(ws);
        const sid = `CA-session-fake-${++sidCounter}`;
        ws.emit({
          event: "start",
          start: {
            callSid: sid,
            streamSid: "MZ19d",
            customParameters: { businessPhone: "+15550000000", callerPhone: "+15559999999" },
          },
        });
        await vi.advanceTimersByTimeAsync(1);

        const tm = H.turnManagerInstances[0];
        tm.opts.onTurnEnd("what are your hours");
        await vi.advanceTimersByTimeAsync(10);

        H.llmFactory = () => makeGen([
          { type: "delta", text: "Sure." },
          { type: "done", reply: { text: "Sure.", toolResults: [] } },
        ]);

        tm.opts.onInterrupt("wait");
        tm.opts.onTurnEnd("sorry, what about Saturday please");
        await vi.advanceTimersByTimeAsync(2_000);

        const historySent = runLlmTurn.mock.calls.at(-1)[0].history;
        expect(historySent.some((h) => h.parts?.[0]?.text === "what are your hours")).toBe(true);
        expect(historySent.some((h) => /interrupted you/i.test(h.parts?.[0]?.text || ""))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 20. Dead air while a tool runs
  // -------------------------------------------------------------------------
  describe("20. the line stays alive during a slow tool round", () => {
    const spokeStillWorking = (t) =>
      t.write.mock.calls.some((c) => /still working/i.test(c[0] || ""));

    it("20a. a stall with no audio playing plays the hold line", async () => {
      H.llmFactory = () => makeGen([
        { type: "delta", text: "One moment while I check that. " },
        { type: "stalled", sinceLastChunkMs: 2500 },
        { type: "done", reply: { text: "Thursday at three works.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());
      await flush();

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("can you check Thursday");
      await flush();
      await flush();

      expect(H.ttsTurns.some(spokeStillWorking)).toBe(true);
      expect(log.info).toHaveBeenCalledWith("llm_stalled", expect.anything());
    });

    it("20b. a stall while the model's own announcement is still playing stays silent", async () => {
      // The one thing the hold line must never do is talk over the "one
      // moment while I check that" the model just said.
      H.llmFactory = () => makeGen([
        { type: "delta", text: "One moment while I check that. " },
        { type: "stalled", sinceLastChunkMs: 2500 },
        { type: "done", reply: { text: "Thursday at three works.", toolResults: [] } },
      ]);

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      await startCall(ws, newSid());
      await flush();

      H.audioOutInstances[0]._playing = true; // announcement still going out
      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("can you check Thursday");
      await flush();
      await flush();

      expect(H.ttsTurns.some(spokeStillWorking)).toBe(false);
    });

    it("20c. a timeout AFTER a tool ran does not count toward the fallback threshold", async () => {
      // Two slow lookups used to drop the whole call into the deterministic
      // take-a-message script even though both tools succeeded.
      H.llmFactory = () => makeGen(
        [{ type: "toolEffect", effect: { success: true, capabilityEffects: [] } }],
        { throwAfter: Object.assign(new Error("timeout"), { code: "LLM_TIMEOUT" }) }
      );

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);
      await flush();

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("can you check Thursday for me");
      await flush();
      await flush();

      const state = callState.getState(sid);
      expect(state.consecutiveFailures || 0).toBe(0); // never incremented
      expect(log.info).toHaveBeenCalledWith("llm_timeout_after_tool_work", expect.anything());
    });

    it("20d. a timeout with NO tool work still counts (an actually-broken LLM must reach the fallback)", async () => {
      H.llmFactory = () => makeThrowingGen(
        Object.assign(new Error("timeout"), { code: "LLM_TIMEOUT" })
      );

      const ws = new FakeWs();
      handleVoiceSessionConnection(ws);
      const sid = newSid();
      await startCall(ws, sid);
      await flush();

      const tm = H.turnManagerInstances[0];
      tm.opts.onTurnEnd("what are your hours");
      await flush();
      await flush();

      expect(callState.getState(sid).consecutiveFailures).toBe(1);
    });
  });
});
