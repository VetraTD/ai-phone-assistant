/**
 * Cutoff simulation — measure how often the assistant talks over the caller,
 * without placing a single phone call.
 *
 * WHY THIS EXISTS
 * The reported bug is "the AI kept randomly cutting me off". The only existing
 * way to measure that is scripts/latency-probe.js, which places real Twilio
 * calls and costs ~15k ElevenLabs characters plus a Gemini bill per run — and
 * its caller audio is clean pre-rendered TTS with no hesitation, so it
 * structurally cannot produce the mid-sentence final that causes the bug.
 *
 * The insight that makes this free: whether the assistant cuts the caller off
 * is decided ENTIRELY by the TIMING of STT events relative to caller speech,
 * plus the turn-taking rules. Audio quality and reply content play no part. So
 * mock exactly the four paid boundaries — Deepgram, ElevenLabs, Gemini,
 * Supabase — and run everything that makes the decision for real:
 *
 *   REAL: turnManager (cue/word/echo gates), echoGuard, inboundVad, audioOut,
 *         and session.js's own hold logic (classifyHold, settle, ceiling).
 *   MODELLED: Deepgram's endpointing behaviour, LLM time-to-first-chunk, TTS
 *         time-to-first-byte. These are inputs to the decision, not the
 *         decision, and each is a measured number from docs/latency-and-tts-tests.md.
 *
 * WHAT IT CANNOT TELL YOU
 * Whether real Deepgram endpoints the way this models it, and whether real
 * acoustic echo occurs on a real handset. Those still need a couple of real
 * calls. What this replaces is needing TWELVE of them to gather statistics.
 *
 *   npm run sim:cutoff
 */

import { describe, it, vi, beforeEach, afterEach, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mock ONLY the paid boundaries.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  sttInstances: [],
  ttsTurns: [],
  /** Modelled first-chunk latencies, overridden per scenario. */
  llmTtfbMs: 940,
  ttsTtfbMs: 95,
  /** Set by the driver: absolute virtual ms when assistant audio first reached the wire. */
  assistantAudioAtMs: [],
  /** Every hold decision session.js made, with the rule that fired. */
  holdCalls: [],
  nowMs: () => 0,
  /** Deterministic call ids — Math.random() made runs unreproducible. */
  sidCounter: 0,
  /** 20ms audio frames emitted per TTS write. See the mock below. */
  ttsChunkFrames: 1,
  /** Every turnManager.handleFinal decision, with the rule that fired. */
  finalDecisions: [],
  /** Live audioOut instances, so the probe can ask whether audio was audible. */
  audioOuts: [],
}));

vi.mock("../lib/voice/sttStream.js", () => ({
  createSttStream: vi.fn(async (opts) => {
    const inst = { opts, sendAudio: vi.fn(), close: vi.fn(), getLastSpeechEndAt: () => null };
    H.sttInstances.push(inst);
    return inst;
  }),
}));

vi.mock("../lib/voice/ttsStream.js", async (importActual) => ({
  ...(await importActual()),
  createTtsTurn: vi.fn((opts) => {
    let firstWrite = true;
    const turn = {
      opts,
      createdAtMs: H.nowMs(),
      write: vi.fn(() => {
        if (!firstWrite) return;
        firstWrite = false;
        // Model TTS time-to-first-byte: the caller hears nothing until now.
        setTimeout(() => {
          // createdAt is recorded too: a cutoff must be a turn that STARTED
          // during the caller's utterance. Without that, a reply to the
          // PREVIOUS utterance whose audio happens to land inside this one's
          // window is miscounted — which is a caller barging in, the opposite
          // of the assistant cutting them off.
          H.assistantAudioAtMs.push({ atMs: H.nowMs(), createdAtMs: turn.createdAtMs });
          opts.onFirstAudio?.();
          // One 160-byte frame is 20ms of audio, which leaves the assistant
          // "playing" for only 20ms — long enough for the cutoff measurement
          // below, far too short to interrupt. The barge probe raises this so
          // there is real playback to talk over. Default 1 keeps every
          // pre-existing scenario byte-identical.
          opts.onAudioChunk?.(Buffer.alloc(160 * H.ttsChunkFrames, 0x7f));
        }, H.ttsTtfbMs);
      }),
      end: vi.fn(() => setTimeout(() => opts.onDone?.({}), 10)),
      abort: vi.fn(),
    };
    H.ttsTurns.push(turn);
    return turn;
  }),
}));

// The LLM boundary. Modelled as "first chunk after llmTtfbMs, then a short
// reply" — long enough to still be speaking when the next caller line starts,
// short enough that reply content never matters.
// NOTE the event shape: llmTurn yields {type:"delta", text} / {type:"done",
// reply}, NOT the {delta} / {done} that services/gemini.js's getReplyStreaming
// emits — llmTurn translates between them. Getting this wrong makes the session
// silently ignore every event and never speak, which is exactly what the
// detector self-test below caught.
vi.mock("../lib/voice/llmTurn.js", () => ({
  runLlmTurn: vi.fn(async function* () {
    await new Promise((r) => setTimeout(r, H.llmTtfbMs));
    yield { type: "delta", text: "Sure, I can help with that." };
    yield {
      type: "done",
      reply: { text: "Sure, I can help with that.", toolResults: [], usage: null, finishReason: "STOP" },
    };
  }),
}));

// Pass-through spy on the REAL hold classifier. Without this, a flat sweep of
// VOICE_HOLD_NO_PUNCT_MS is ambiguous: it could mean the knob does nothing, or
// that the scripted pauses never produce a final that reaches the branch at
// all. Recording every decision distinguishes the two.
vi.mock("../lib/transcriptUtils.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    classifyHold: (text, rawText) => {
      const result = actual.classifyHold(text, rawText);
      H.holdCalls.push({ text, rule: result.rule, holdMs: result.holdMs });
      return result;
    },
  };
});

// Pass-through spy on the REAL audioOut, so the probe can state whether the
// assistant was actually AUDIBLE when a transcript arrived. "No cut" proves
// nothing if there was no playback to cut.
vi.mock("../lib/voice/audioOut.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    createAudioOut: (opts) => {
      const inst = actual.createAudioOut(opts);
      H.audioOuts.push(inst);
      return inst;
    },
  };
});

// Pass-through spy on the REAL turn manager, so the barge probe can report
// WHY a decision went the way it did instead of only that it did. A row that
// says "no cut" is ambiguous on its own: it could mean the gates worked, or
// that the assistant was not speaking and there was nothing to cut.
vi.mock("../lib/voice/turnManager.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    createTurnManager: (opts) => {
      const tm = actual.createTurnManager(opts);
      return {
        ...tm,
        handleFinal: (text, meta) => {
          const decision = tm.handleFinal(text, meta);
          H.finalDecisions.push({ text, meta, ...decision });
          return decision;
        },
      };
    },
  };
});

vi.mock("../services/supabase.js", () => ({
  isEnabled: () => false,
  lookupBusinessByPhone: vi.fn(async () => null),
  loadConfig: () => ({
    businessName: "Simulation Dental",
    greeting: "Thanks for calling Simulation Dental.",
    _hasCustomGreeting: true,
    timezone: "America/Chicago",
    businessHours: null,
    transferPhoneNumber: null,
    allowedTasks: ["general_question", "take_message"],
    capabilities: {},
    languagesSpoken: ["en"],
    voiceProvider: "elevenlabs",
    voiceId: "",
    smsFollowupEnabled: false,
    smsTemplates: {},
  }),
  createCall: vi.fn(async () => null),
  fetchBusinessKnowledge: vi.fn(async () => []),
  listIntegrationsForBusiness: vi.fn(async () => []),
  fetchCallerContext: vi.fn(async () => null),
  insertTranscript: vi.fn(async () => {}),
  completeCall: vi.fn(async () => {}),
  markCallTransferred: vi.fn(async () => {}),
  BUILTIN_TOOL_NAMES: [],
  normalizeAllowedTasks: (t) => t || [],
}));

vi.mock("../services/notifications.js", () => ({
  notifyCustomerRequest: vi.fn(async () => {}),
  notifyCallMissed: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

vi.mock("../services/googleTts.js", () => ({ synthesizeMulaw: vi.fn(async () => Buffer.alloc(160, 0xff)) }));
vi.mock("../services/elevenlabs.js", () => ({
  synthesizeMulawOnce: vi.fn(async () => Buffer.alloc(160, 0xff)),
  trimPreviousText: (s) => s,
}));
vi.mock("../services/gemini.js", () => ({
  getReplyStreaming: vi.fn(),
  isBusinessOpen: () => true,
  generateSummaryAndSentiment: vi.fn(async () => ({})),
  ACTION_TOOL_NAMES: [],
  // Reached from session.js's leak-guard context (handleTurnError -> the
  // per-call tool vocabulary). Omitting it made the whole sim throw before
  // either scenario could report a number — vitest treats a missing export on a
  // factory mock as an error, not undefined.
  callToolNames: () => [],
}));
vi.mock("../lib/logger.js", () => ({
  log: { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} },
  createRequestId: () => "sim",
}));
vi.mock("../lib/sentry.js", () => ({ captureException: () => {} }));
vi.mock("twilio", () => ({ default: () => ({ calls: () => ({ update: async () => {} }) }) }));

// NOT imported at module scope. session.js and its graph (utteranceCache's LRU,
// ttsHealth's circuit breaker, callState's Map) hold process-wide state that
// carried between scenarios and made the fluent control flip between 0 and 1
// cutoff across runs. Each scenario re-imports a completely fresh graph.
async function freshSession() {
  vi.resetModules();
  return (await import("../lib/voice/session.js")).handleVoiceSessionConnection;
}

// ---------------------------------------------------------------------------
// Caller scripts — shaped like real speech, i.e. with mid-sentence pauses.
//
// The pause band matters. Deepgram's endpointing window is 150ms, so ANY gap
// longer than that can finalize a fragment mid-sentence. Real callers pause far
// longer than that while thinking, reciting digits, or choosing a word.
// ---------------------------------------------------------------------------

const SPEECH_MS_PER_WORD = 320;
const speak = (text) => ({ text, speakMs: Math.max(400, text.split(/\s+/).length * SPEECH_MS_PER_WORD) });
const pause = (silenceMs) => ({ silenceMs });

const HESITANT_SCRIPT = [
  { label: "open-clean", segments: [speak("Hi there I have a question about an appointment")] },
  { label: "think-mid", segments: [speak("I'd like to book"), pause(500), speak("an appointment for next week")] },
  { label: "name-pause", segments: [speak("My name is"), pause(700), speak("Nithin")] },
  { label: "digits", segments: [speak("It's five five five"), pause(600), speak("one two three four")] },
  { label: "symptom", segments: [speak("I've been having"), pause(400), speak("some pain on the left side")] },
  { label: "long-think", segments: [speak("Can I get"), pause(800), speak("something Tuesday morning")] },
  { label: "short-ack", segments: [speak("yes that works")] },
  { label: "close-clean", segments: [speak("No that's everything thank you")] },
];

const FLUENT_SCRIPT = [
  { label: "f1", segments: [speak("Hi I have a question about an appointment")] },
  { label: "f2", segments: [speak("I would like to book an appointment for next week")] },
  { label: "f3", segments: [speak("My name is Nithin and my number is five five five one two three four")] },
  { label: "f4", segments: [speak("Can I get something Tuesday morning please")] },
  { label: "f5", segments: [speak("No that's everything thank you")] },
];

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

const FRAME_MS = 20;
const FRAME_BYTES = 160;
const LOUD = Buffer.alloc(FRAME_BYTES, 0x10); // far from mu-law silence -> VAD sees voice
const QUIET = Buffer.alloc(FRAME_BYTES, 0xff); // mu-law digital silence

class FakeWs {
  constructor() {
    this.handlers = {};
    this.readyState = 1;
    this.sent = [];
  }
  on(ev, cb) {
    (this.handlers[ev] ||= []).push(cb);
    return this;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {}
  emit(msg) {
    for (const cb of this.handlers.message || []) cb(JSON.stringify(msg));
  }
}

/**
 * Model Deepgram: interims while speech is flowing, and a final once a gap of
 * `endpointMs` has elapsed since the last voiced frame.
 *
 * `midSentencePunctuated` reflects smart_format: Deepgram punctuates what it
 * BELIEVES is a sentence end, which is often wrong mid-utterance. This is the
 * pessimistic-but-observed case that makes classifyHold's no-punctuation branch
 * unreachable, so it is the default.
 */
async function runCall({
  script,
  endpointMs = 150,
  llmTtfbMs = 940,
  ttsTtfbMs = 95,
  midSentencePunctuated = true,
  interCallerGapMs = 1200,
  holdNoPunctMs,
}) {
  if (holdNoPunctMs === undefined) delete process.env.VOICE_HOLD_NO_PUNCT_MS;
  else process.env.VOICE_HOLD_NO_PUNCT_MS = String(holdNoPunctMs);
  H.sttInstances.length = 0;
  H.ttsTurns.length = 0;
  H.assistantAudioAtMs.length = 0;
  H.holdCalls.length = 0;
  H.llmTtfbMs = llmTtfbMs;
  H.ttsTtfbMs = ttsTtfbMs;

  let clock = 0;
  H.nowMs = () => clock;

  const handleVoiceSessionConnection = await freshSession();
  const ws = new FakeWs();
  // Hand the session the SAME virtual clock the caller script and the mocked
  // boundaries run on. Without this, turnManager/audioOut judged their VAD and
  // echo windows against wall clock while the audio moved in virtual time —
  // see the note in beforeEach, and session.js's `now` jsdoc.
  handleVoiceSessionConnection(ws, undefined, { now: () => clock });
  ws.emit({
    event: "start",
    start: {
      callSid: `SIM-${++H.sidCounter}`,
      streamSid: `SIMSTREAM-${H.sidCounter}`,
      customParameters: { businessPhone: "+15550000000", callerPhone: "+15559998888" },
    },
  });
  await vi.advanceTimersByTimeAsync(5);

  const stt = H.sttInstances[0];
  if (!stt) throw new Error("STT stream never opened");

  // Let the greeting settle before the caller speaks.
  //
  // onDone is the TTS stream finishing, NOT the caller-side playback mark. Our
  // FakeWs does not echo marks, so without emitting greeting-done by hand the
  // barge-in gate stays shut and every caller line for the first
  // VOICE_GREETING_GUARD_MAX_MS is discarded — the sim would be measuring the
  // greeting watchdog rather than turn-taking, and reporting zero cutoffs
  // because nothing reached a turn at all.
  H.ttsTurns[0]?.opts?.onDone?.({});
  ws.emit({ event: "mark", mark: { name: "greeting-done" } });
  await vi.advanceTimersByTimeAsync(600);

  const utterances = [];

  for (const line of script) {
    const startedAt = clock;
    let spokenSoFar = "";
    let sinceVoiceMs = 0;
    let pendingFinalText = null;

    for (const seg of line.segments) {
      if (seg.silenceMs !== undefined) {
        // Silence: still feeding frames, so the VAD hangover decays for real.
        for (let t = 0; t < seg.silenceMs; t += FRAME_MS) {
          ws.emit({ event: "media", media: { payload: QUIET.toString("base64") } });
          sinceVoiceMs += FRAME_MS;
          // Deepgram finalizes once the gap exceeds its endpointing window.
          if (pendingFinalText === null && sinceVoiceMs >= endpointMs && spokenSoFar) {
            pendingFinalText = midSentencePunctuated ? `${spokenSoFar}.` : spokenSoFar;
            stt.opts.onFinal?.(pendingFinalText);
          }
          clock += FRAME_MS;
          await vi.advanceTimersByTimeAsync(FRAME_MS);
        }
        continue;
      }

      // Speech.
      pendingFinalText = null;
      sinceVoiceMs = 0;
      const words = seg.text.split(/\s+/);
      const perWord = Math.max(FRAME_MS, Math.round(seg.speakMs / words.length));
      let wordIdx = 0;
      for (let t = 0; t < seg.speakMs; t += FRAME_MS) {
        ws.emit({ event: "media", media: { payload: LOUD.toString("base64") } });
        if (t > 0 && t % perWord < FRAME_MS && wordIdx < words.length) {
          spokenSoFar = `${spokenSoFar} ${words[wordIdx]}`.trim();
          wordIdx++;
          stt.opts.onInterim?.(spokenSoFar);
        }
        sinceVoiceMs = 0;
        clock += FRAME_MS;
        await vi.advanceTimersByTimeAsync(FRAME_MS);
      }
      spokenSoFar = `${spokenSoFar} ${words.slice(wordIdx).join(" ")}`.trim();
    }

    // End of the caller's utterance: silence until Deepgram's final lands.
    const endedAt = clock;
    for (let t = 0; t < endpointMs + 60; t += FRAME_MS) {
      ws.emit({ event: "media", media: { payload: QUIET.toString("base64") } });
      clock += FRAME_MS;
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    }
    stt.opts.onFinal?.(`${spokenSoFar}.`);

    utterances.push({ label: line.label, startedAt, endedAt });

    // WAIT for the assistant to actually answer before speaking again, then
    // leave a human-sized gap. A FIXED gap here was a harness artifact, not a
    // model of anything: when a hold delayed the reply past the gap, the
    // scripted caller ploughed on and the late reply was scored as the
    // assistant cutting them off. Real callers wait to be answered.
    const repliesBefore = H.assistantAudioAtMs.length;
    for (let waited = 0; waited < 8000; waited += FRAME_MS) {
      if (H.assistantAudioAtMs.length > repliesBefore) break;
      ws.emit({ event: "media", media: { payload: QUIET.toString("base64") } });
      clock += FRAME_MS;
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    }
    for (let t = 0; t < interCallerGapMs; t += FRAME_MS) {
      ws.emit({ event: "media", media: { payload: QUIET.toString("base64") } });
      clock += FRAME_MS;
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    }
  }

  // A cutoff is assistant audio reaching the wire while the caller was still
  // mid-utterance. Not "the assistant replied quickly" — actually overlapping.
  const cutoffs = [];
  for (const u of utterances) {
    // BOTH conditions: the turn was started while the caller was still
    // speaking, AND its audio reached the wire while they were still speaking.
    const hit = H.assistantAudioAtMs.find(
      (a) => a.createdAtMs >= u.startedAt && a.atMs > u.startedAt && a.atMs < u.endedAt
    );
    if (hit !== undefined) {
      cutoffs.push({ label: u.label, msIntoUtterance: hit.atMs - u.startedAt, remainingMs: u.endedAt - hit.atMs });
    }
  }
  const rules = {};
  for (const h of H.holdCalls) rules[h.rule] = (rules[h.rule] || 0) + 1;
  return {
    utterances,
    cutoffs,
    replies: H.assistantAudioAtMs.length,
    turnsTaken: H.ttsTurns.length,
    audioAt: [...H.assistantAudioAtMs],
    holdCalls: H.holdCalls.length,
    rules,
  };
}

// ---------------------------------------------------------------------------

function pct(n, d) {
  return d === 0 ? "0.0%" : `${((n / d) * 100).toFixed(1)}%`;
}
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe("cutoff simulation", () => {
  beforeEach(() => {
    // CLOCK — fixed 2026-08-04. This block used to warn that no number printed
    // here was quotable.
    //
    // The problem: turnManager and audioOut read performance.now() directly,
    // which vitest does not fake, so their VAD and echo windows were judged
    // against WALL CLOCK while the caller script and every timer ran on the
    // virtual clock. Consecutive runs of identical input disagreed about which
    // utterance was cut off. Faking `performance` globally was tried and made
    // it worse — audioOut's pacing pump reads it too, so freezing it changed
    // playback behaviour rather than just the measurement.
    //
    // The fix was the one this comment already prescribed: session.js now takes
    // a `now` option and threads it into createAudioOut/createTurnManager and
    // into every echoGuard timestamp it supplies (echoGuard itself never reads
    // a clock — all its time is caller-supplied). runCall passes the virtual
    // clock in, so the whole decision path shares one clock.
    //
    // The CONTROL CHECK below still stands as the guard: if the fluent control
    // is dirty, something else is mismodelled and the run is not quotable.
    vi.useFakeTimers();
    delete process.env.VOICE_ECHO_SHORT_TOKENS;
    delete process.env.VOICE_CUE_REQUIRES_VOICE;
    delete process.env.VOICE_HOLD_NO_PUNCT_MS;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("measures how often the assistant talks over the caller", async () => {
    const scenarios = [
      // Punctuated mid-sentence finals: smart_format guesses a sentence end, so
      // classifyHold returns terminal_punctuation and the no-punct hold never
      // engages. This is the case the hold CANNOT help with.
      { name: "punctuated finals @150ms", script: HESITANT_SCRIPT, endpointMs: 150 },
      { name: "punctuated finals @300ms", script: HESITANT_SCRIPT, endpointMs: 300 },

      // Unpunctuated mid-sentence finals: the case classifyHold's no-punct
      // branch exists for. Sweeping the knob here is the only place it can show
      // an effect, so this is the real before/after for the shipped fix.
      { name: "unpunctuated, hold OFF (pre-fix)", script: HESITANT_SCRIPT, endpointMs: 150, midSentencePunctuated: false, holdNoPunctMs: 0 },
      { name: "unpunctuated, hold 500 (shipped)", script: HESITANT_SCRIPT, endpointMs: 150, midSentencePunctuated: false, holdNoPunctMs: 500 },
      { name: "unpunctuated, hold 900", script: HESITANT_SCRIPT, endpointMs: 150, midSentencePunctuated: false, holdNoPunctMs: 900 },

      { name: "fluent (control)", script: FLUENT_SCRIPT, endpointMs: 150 },
    ];

    // DETECTOR SELF-TEST, first and non-negotiable. An instrument that reports
    // zero everywhere is far more likely broken than the product is perfect, so
    // prove it can see a cutoff before trusting it not to see one: an assistant
    // with zero LLM and TTS latency, answering into a long mid-sentence pause,
    // MUST talk over the caller.
    const selfTest = await runCall({
      script: [{ label: "self-test", segments: [speak("I would like to book"), pause(2500), speak("an appointment for next week")] }],
      llmTtfbMs: 0,
      ttsTtfbMs: 0,
    });
    console.log(
      `\n  detector self-test: replies=${selfTest.replies} turns=${selfTest.turnsTaken} cutoffs=${selfTest.cutoffs.length}`
    );
    if (selfTest.replies === 0) {
      throw new Error(
        "SIM BROKEN: the assistant never produced audio, so a cutoff could never be observed. " +
          "Every zero below would be meaningless."
      );
    }
    if (selfTest.cutoffs.length === 0) {
      throw new Error(
        "SIM BROKEN: an assistant with zero latency answering into a 2.5s mid-sentence pause " +
          "was not recorded as a cutoff. The detector cannot detect."
      );
    }

    const rows = [];
    for (const s of scenarios) {
      const { utterances, cutoffs, replies, rules } = await runCall(s);
      rows.push({
        name: s.name,
        turns: utterances.length,
        replies,
        cutoffs: cutoffs.length,
        rate: pct(cutoffs.length, utterances.length),
        medianRemaining: median(cutoffs.map((c) => c.remainingMs)),
        labels: cutoffs.map((c) => c.label).join(", ") || "—",
        rules: Object.entries(rules).map(([k, v]) => `${k}:${v}`).join(" ") || "none",
      });
    }

    console.log("\n  CUTOFF SIMULATION — assistant audio starting while the caller is still speaking\n");
    console.log("  scenario                          turns  cutoffs   rate   talked-over  where");
    console.log("  " + "-".repeat(84));
    for (const r of rows) {
      console.log(
        `  ${r.name.padEnd(32)} ${String(r.turns).padStart(5)} ${String(r.cutoffs).padStart(8)}  ${r.rate.padStart(6)}  ${String(r.medianRemaining + "ms").padStart(11)}  ${r.labels}`
      );
    }
    console.log("");
    console.log("  hold rules that actually fired (what classifyHold decided per scenario):");
    for (const r of rows) console.log(`    ${r.name.padEnd(32)} ${r.rules}`);
    // CONTROL CHECK. Fluent speech has no mid-sentence pause, so nothing can
    // finalize mid-utterance and the assistant has nothing to talk over. A
    // non-zero control means the harness is mismodelling something, and every
    // number above is then unsafe to quote — say so loudly rather than let the
    // table read as a finding.
    const control = rows.find((r) => r.name.startsWith("fluent"));
    const holdSweep = rows.filter((r) => r.name.startsWith("unpunctuated"));
    // Only a real problem if the branch NEVER RAN. If it ran and the cutoff
    // count still did not move, that is a finding about the product, not a
    // defect in the harness — so do not cry wolf.
    const branchNeverRan = holdSweep.length > 0 && holdSweep.every((r) => !r.rules.includes("no_terminal_punctuation"));

    console.log("");
    if (control && control.cutoffs > 0) {
      console.log("  *** HARNESS NOT TRUSTWORTHY: the fluent control recorded a cutoff. Fluent");
      console.log("      speech cannot produce a mid-utterance final, so this is a modelling");
      console.log("      bug in the simulation, not a product defect. Do not quote these rates.");
    }
    if (branchNeverRan) {
      console.log("  *** HARNESS SUSPECT: classifyHold's no_terminal_punctuation branch never ran");
      console.log("      in the unpunctuated sweep, so the knob could not have had an effect. The");
      console.log("      scripted pauses are not producing the final this branch exists for.");
    }
    console.log("");
    console.log("  A non-zero rate on the hesitant script and ~0 on the fluent control is the");
    console.log("  signature of the reported bug: it is mid-sentence pauses, not fast callers.");
    console.log("  If hesitant is also ~0, the cutoff hypothesis is WRONG and the turn-taking");
    console.log("  fixes should not be trusted to have fixed anything.\n");

    expect(rows.length).toBe(scenarios.length);
  }, 120_000);

  // -------------------------------------------------------------------------
  // FALSE BARGE-IN PROBE — the other half of the reported bug.
  //
  // The table above measures the assistant talking over the CALLER. This
  // measures the reverse: the caller being heard to interrupt when they did
  // not. Reported as "whenever we intend to cut it off, it cuts off, but
  // whenever we are not and we accidentally slip a word or rarely a cough it
  // will cut", and markedly worse on the UK number.
  //
  // Runs the REAL inboundVad, turnManager, echoGuard, audioOut and session
  // wiring. Only the noise itself is modelled: a burst of voiced frames plus
  // whatever Deepgram would have made of it, with the confidence such a
  // transcript actually carries.
  //
  // The measurement is whether the assistant's TTS turn was aborted, which is
  // exactly what a barge-in does to it.
  // -------------------------------------------------------------------------
  async function runBargeProbe({ burstMs, text, confidence, endpointMs = 150 }) {
    H.sttInstances.length = 0;
    H.ttsTurns.length = 0;
    H.assistantAudioAtMs.length = 0;
    H.finalDecisions.length = 0;
    H.audioOuts.length = 0;
    H.llmTtfbMs = 200;
    H.ttsTtfbMs = 40;
    // ~5s of assistant audio, so it is still playing after even the longest
    // burst below. At 2s the deliberate-interruption cases arrived AFTER
    // playback had finished, and "no cut" then meant "nothing left to cut"
    // rather than "the gates held" — a probe that proves nothing.
    H.ttsChunkFrames = 250;

    let clock = 0;
    H.nowMs = () => clock;
    const tick = async (ms, buf) => {
      for (let t = 0; t < ms; t += FRAME_MS) {
        ws.emit({ event: "media", media: { payload: buf.toString("base64") } });
        clock += FRAME_MS;
        await vi.advanceTimersByTimeAsync(FRAME_MS);
      }
    };

    const handleVoiceSessionConnection = await freshSession();
    const ws = new FakeWs();
    handleVoiceSessionConnection(ws, undefined, { now: () => clock });
    ws.emit({
      event: "start",
      start: {
        callSid: `SIMBARGE-${++H.sidCounter}`,
        streamSid: `SIMBARGESTREAM-${H.sidCounter}`,
        customParameters: { businessPhone: "+15550000000", callerPhone: "+15559998888" },
      },
    });
    await vi.advanceTimersByTimeAsync(5);

    const stt = H.sttInstances[0];
    if (!stt) throw new Error("STT stream never opened");

    // Settle the greeting, then have the caller ask something so the assistant
    // starts a reply we can try to interrupt. The mark is emitted by hand for
    // the reason given in the cutoff scenario above: FakeWs does not echo marks,
    // and without it the barge-in gate never opens, so this scenario would
    // report "no cutoff" for the trivial reason that no turn ever began.
    H.ttsTurns[0]?.opts?.onDone?.({});
    ws.emit({ event: "mark", mark: { name: "greeting-done" } });
    await tick(400, QUIET);
    await tick(600, LOUD);
    await tick(endpointMs + 60, QUIET);
    const audioCountBefore = H.assistantAudioAtMs.length;
    stt.opts.onFinal?.("What time do you open on Tuesday?", { confidence: 0.95 });

    // Wait for the REPLY's audio specifically — not merely for any audio. The
    // greeting has already played by this point, so a bare length check exits
    // instantly and the probe then measures the greeting's TTS turn, which the
    // caller's own legitimate question had already barged. That reads as "a
    // cough cut the assistant off" when nothing of the sort happened.
    for (let waited = 0; waited < 4000 && H.assistantAudioAtMs.length === audioCountBefore; waited += FRAME_MS) {
      await tick(FRAME_MS, QUIET);
    }
    const replyTurn = H.ttsTurns[H.ttsTurns.length - 1];
    const playingBefore = H.assistantAudioAtMs.length > audioCountBefore;

    // Let the caller's own speech fall out of the VAD's memory before the
    // noise. Without this the burst inherits the 600ms run they just produced,
    // and the sustained-speech gate passes for the wrong reason.
    await tick(600, QUIET);

    // The noise: a burst of genuine energy (a cough HAS energy — that is the
    // whole problem) followed by whatever STT made of it.
    const audioAtMs = H.assistantAudioAtMs[H.assistantAudioAtMs.length - 1]?.atMs ?? null;
    await tick(burstMs, LOUD);
    const clockAtFinal = clock;
    const audioOut = H.audioOuts[H.audioOuts.length - 1];
    const audibleAtFinal = !!audioOut?.isPlaying?.(150);
    stt.opts.onFinal?.(text, { confidence });
    await vi.advanceTimersByTimeAsync(50);

    return {
      aborted: replyTurn?.abort.mock.calls.length > 0,
      playingBefore,
      audioAtMs,
      clockAtFinal,
      sinceAudioMs: audioAtMs === null ? null : clockAtFinal - audioAtMs,
      turnsAtFinal: H.ttsTurns.length,
      audibleAtFinal,
      decision: H.finalDecisions[H.finalDecisions.length - 1] || null,
    };
  }

  it("does not let a cough or a stray word cut the assistant off, but a real interruption still does", async () => {
    const cases = [
      // A cough. ~220ms of energy — enough to latch the VAD, which is why the
      // old "was there energy recently" check could never reject it — forced
      // by STT into the nearest vocabulary item, with the low confidence such
      // a transcript actually carries.
      { name: "cough heard as 'sorry'", burstMs: 220, text: "sorry", confidence: 0.28, expectAbort: false },
      // A stray word slipped while the assistant talks. Two words used to sail
      // straight through: the old rule doubted only ONE-word finals.
      { name: "stray two-word mutter", burstMs: 240, text: "uh what", confidence: 0.35, expectAbort: false },
      // Line noise that STT rendered as an interrupt cue. A cue used to bypass
      // every remaining gate outright.
      { name: "noise heard as cue 'no'", burstMs: 200, text: "no", confidence: 0.22, expectAbort: false },

      // ...and the half that must NOT regress. A guard that stops real
      // interruptions is worse than the noise it filters.
      { name: "deliberate 'stop'", burstMs: 500, text: "stop", confidence: 0.93, expectAbort: true },
      { name: "deliberate sentence", burstMs: 900, text: "actually can we make it Wednesday instead", confidence: 0.91, expectAbort: true },
    ];

    const rows = [];
    for (const c of cases) {
      rows.push({ ...c, ...(await runBargeProbe(c)) });
    }

    console.log("\n  FALSE BARGE-IN PROBE — was the assistant cut off?\n");
    console.log("  case                          expected     actual   ok   sinceAudio  audible  decision");
    console.log("  " + "-".repeat(86));
    for (const r of rows) {
      const ok = r.aborted === r.expectAbort ? "yes" : "NO";
      console.log(
        `  ${r.name.padEnd(28)} ${(r.expectAbort ? "cut" : "no cut").padEnd(11)} ${(r.aborted ? "cut" : "no cut").padEnd(8)} ${ok.padEnd(4)} ${String(r.sinceAudioMs).padStart(7)}ms  ${(r.audibleAtFinal ? "yes" : "NO ").padEnd(4)} ${(r.decision ? `${r.decision.action}/${r.decision.reason ?? "-"}` : "none")}`
      );
    }
    console.log("");

    // SELF-TEST, non-negotiable. If the assistant was not actually audible when
    // the transcript landed, "not cut off" is meaningless — every row would
    // pass for the wrong reason, and the table would read as a finding.
    for (const r of rows) {
      expect(r.playingBefore, `${r.name}: the reply never produced audio, so this proves nothing`).toBe(true);
      expect(r.audibleAtFinal, `${r.name}: assistant was not audible, so there was nothing to cut off`).toBe(true);
    }
    for (const r of rows) {
      expect(r.aborted, `${r.name}: expected ${r.expectAbort ? "a barge-in" : "no barge-in"}`).toBe(r.expectAbort);
    }
  }, 120_000);
});
