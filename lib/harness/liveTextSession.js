/**
 * Text-in / audio-out session driver for the Gemini Live front-end.
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 *
 * On 2026-09-03 the Live front-end invented five appointment slots and
 * confirmed a booking that never happened -- on the production configuration,
 * with all ten tools declared and used correctly one call earlier. One
 * observation in ten calls is an anecdote. This is the instrument that turns
 * "it sometimes lies" into a rate a shipping decision can rest on.
 *
 * It satisfies the SAME interface as lib/harness/textSession.js -- `sendTurn`,
 * `getState`, `transcript` -- so eval/run.js swaps at one point and all 45
 * scenarios, 19 assert helpers, the judge and matrix mode work unchanged.
 *
 * ---------------------------------------------------------------------------
 * Two things about it that are deliberate and easy to get wrong
 * ---------------------------------------------------------------------------
 *
 * 1. IT KEEPS `responseModalities: AUDIO`, and reads the reply out of
 *    `outputAudioTranscription`. A text-out Live session would be cheaper and
 *    faster and would be measuring a DIFFERENT model configuration from the
 *    one that fabricated. The whole point is the audio-native path, so the
 *    audio is generated and thrown away. This costs real money and is why the
 *    probe is pre-registered rather than run casually.
 *
 * 2. IT REUSES PRODUCTION'S OWN PIECES -- `connectLive`, `buildLiveTools`,
 *    `createToolRunner`, `applyReplyState`. The handoff's section 8 names the
 *    failure this avoids: two drivers that drift until the eval is quietly
 *    measuring something production no longer does. Nothing about the tool
 *    loop is reimplemented here; the only thing this file owns is turning a
 *    persistent socket into a request/response shape.
 *
 * ---------------------------------------------------------------------------
 * What it CANNOT answer
 * ---------------------------------------------------------------------------
 *
 * How anything sounds, felt latency, barge-in, echo, turn-end behaviour, or
 * whether `inputAudioTranscription` is punctuated -- text in means no input
 * transcription at all. Those are a handset. Do not let a green run here read
 * as a call that went well.
 *
 * A session here is also LONGER-LIVED than a call turn: one socket per
 * scenario, so the vendor's own context growth across turns is in play exactly
 * as it is on a real call, and cost is quadratic in turn count for the same
 * reason.
 */

import { Modality } from "@google/genai";

import { connectLive, liveSurface } from "../voice/live/client.js";
import { buildLiveTools, createToolRunner } from "../voice/live/tools.js";
import { buildSystemInstruction } from "../../services/gemini.js";
import { buildMinimalInstruction } from "../voice/live/minimalPrompt.js";
import {
  applyReplyState,
  applyCallerSpellingSignal,
  spellingSettled,
} from "../voice/replyState.js";
import { getStrings } from "../voice/strings.js";
import { STEPS } from "../callState.js";
import {
  dispatchCapabilityEffects,
  mergeCapabilityState as mergeCapabilityStateInto,
} from "../capabilities/effects.js";
import { makeFakeEffectsDeps } from "./fakeDeps.js";

/** How long to wait for `turnComplete` before giving up on a turn. */
const TURN_TIMEOUT_MS = 45_000;

/**
 * @param {object} params - same shape as createTextSession, plus `env`/`connect`
 * @returns {{ sendTurn: Function, getState: Function, transcript: Array, close: Function }}
 */
export function createLiveTextSession({
  config,
  extras = {},
  fakes,
  callerNumber = "+15550001111",
  turnTimeoutMs = TURN_TIMEOUT_MS,
  env = process.env,
  connect = connectLive,
}) {
  if (!fakes || !fakes.deps) {
    throw new Error("createLiveTextSession requires fakes.deps (from makeFakeDeps)");
  }
  const effects = fakes.effects || makeFakeEffectsDeps();
  const businessId = extras.businessId ?? config?.businessId ?? null;

  let callerContext = extras.callerContext ?? null;

  // Same starting step as the text driver, and for the same reason: production
  // leaves GREETING the instant the greeting is played, so every real model
  // turn begins at IDENTIFY_INTENT or later.
  const state = {
    step: STEPS.IDENTIFY_INTENT,
    intent: null,
    history: [],
    capabilityState: {},
    consecutiveFailures: 0,
    config,
  };

  const transcript = [];

  let session = null;
  let closed = false;

  // Per-turn accumulators. Reset at the top of every sendTurn, read when the
  // vendor says the turn is complete.
  let turnText = "";
  let turnDone = null;
  let turnUsage = null;
  const turnToolCalls = [];
  const turnToolResults = [];
  let turnCapabilityEffects = [];
  let turnIntentArgs;
  let turnEndCallArgs;

  function mergeCapabilityState(patch) {
    mergeCapabilityStateInto(state, patch);
  }

  function dispatchEffects(effectsList) {
    return dispatchCapabilityEffects(effectsList, {
      STEPS,
      setStep(nextStep) {
        state.step = nextStep;
      },
      setCapabilityState: mergeCapabilityState,
      setCallerContext(next) {
        callerContext = next || null;
      },
      call: {
        callSid: "live-harness",
        businessId,
        callId: null,
        callerNumber,
        twilioNumber: null,
        config,
        callerContext,
      },
      deps: effects.deps,
    });
  }

  // The extras bag the tool runner closes over. `capabilityDeps` is what makes
  // the packs read the in-memory store instead of a database; the Live tool
  // ctx forwards it as depsOverride exactly as services/gemini.js does.
  const runnerExtras = {
    ...extras,
    businessId,
    callerPhone: extras.callerPhone ?? callerNumber,
    callId: null,
    capabilityDeps: fakes.deps,
  };

  const runner = createToolRunner({
    config,
    extras: runnerExtras,
    turnState: () => ({
      step: state.step,
      callerTurnCount: Math.max(1, transcript.filter((t) => t.role === "user").length),
      spellingSettled: spellingSettled(state),
      transferAllowed: extras.transferAllowed !== false,
    }),
  });

  async function onToolCall(toolCall) {
    for (const fc of toolCall.functionCalls || []) {
      turnToolCalls.push({ name: fc.name, args: fc.args });
    }
    const out = await runner.handleToolCall(toolCall);
    if (out.toolResults?.length) turnToolResults.push(...out.toolResults);
    if (out.capabilityEffects?.length) turnCapabilityEffects.push(...out.capabilityEffects);
    if (out.intentArgs) turnIntentArgs = out.intentArgs;
    if (out.endCallArgs) turnEndCallArgs = out.endCallArgs;
    session.sendToolResponse({ functionResponses: out.functionResponses });
  }

  async function ensureConnected() {
    if (session || closed) return;

    // Lazily, so the factory stays synchronous and interchangeable with
    // createTextSession -- and so the ~2.2 s handshake (LVX17) lands inside
    // the first turn's measured time rather than vanishing into setup.
    const instruction =
      env.LIVE_PROMPT === "minimal"
        ? buildMinimalInstruction(config)
        : buildSystemInstruction(state.step, state.intent, config, runnerExtras);

    const out = await connect({
      env,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: instruction }] },
        outputAudioTranscription: {},
        tools: env.LIVE_TOOLS === "none" ? [] : buildLiveTools(config, runnerExtras),
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: env.LIVE_VOICE || "Kore" } },
          languageCode: env.LIVE_LANGUAGE_CODE || "en-GB",
        },
      },
      callbacks: {
        onmessage: async (msg) => {
          if (msg?.usageMetadata) turnUsage = msg.usageMetadata;
          if (msg?.toolCall) {
            try {
              await onToolCall(msg.toolCall);
            } catch {
              // A tool failure must not strand the turn: the vendor is waiting
              // on a response and will otherwise sit silent to the timeout.
            }
            return;
          }
          const sc = msg?.serverContent;
          if (!sc) return;
          if (sc.outputTranscription?.text) turnText += sc.outputTranscription.text;
          if (sc.turnComplete) turnDone?.();
        },
        onerror: () => turnDone?.(),
        onclose: () => turnDone?.(),
      },
    });
    session = out.session;
  }

  async function sendTurn(userText) {
    const startedAt = Date.now();
    await ensureConnected();

    turnText = "";
    turnUsage = null;
    turnToolCalls.length = 0;
    turnToolResults.length = 0;
    turnCapabilityEffects = [];
    turnIntentArgs = undefined;
    turnEndCallArgs = undefined;

    // Before the turn is sent, not after the reply -- same placement as the
    // text driver and the live session. Read afterwards, every spelling signal
    // is a turn late.
    applyCallerSpellingSignal(state, userText, getStrings(config));

    let timedOut = false;
    const done = new Promise((resolve) => {
      turnDone = resolve;
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, turnTimeoutMs).unref?.();
    });

    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: userText }] }],
      turnComplete: true,
    });
    await done;
    turnDone = null;

    const totalMs = Date.now() - startedAt;
    const text = turnText.trim();

    // The shape applyReplyState consumes. Five fields, and no more -- see
    // lib/voice/replyState.js. Assembled rather than faked: every value here
    // came out of the real tool runner.
    const reply = {
      text,
      intentArgs: turnIntentArgs,
      endCallArgs: turnEndCallArgs,
      capabilityEffects: turnCapabilityEffects,
      capabilityState: runner.capabilityState,
      toolResults: [...turnToolResults],
      toolCallEvents: turnToolCalls.map((t) => ({ name: t.name, args: t.args })),
      usage: normaliseUsage(turnUsage),
      finishReason: timedOut ? "TIMEOUT" : null,
    };

    const { capabilityNotes } = applyReplyState(
      state,
      { userText, reply },
      {
        STEPS,
        mergeCapabilityState,
        dispatchEffects,
        spellRequestRe: getStrings(config).spellRequestRe,
      }
    );

    const toolCalls = [...turnToolCalls];
    transcript.push({ role: "user", text: userText, toolCalls: [], step: state.step, intent: state.intent });
    transcript.push({ role: "model", text, toolCalls, step: state.step, intent: state.intent });

    return {
      text,
      reply,
      toolCalls,
      toolResults: [...turnToolResults],
      toolEffects: [...turnCapabilityEffects],
      state: { step: state.step, intent: state.intent },
      // No streaming deltas on this path, so there is no honest first-event
      // time to report. null, not totalMs: a fabricated number here would end
      // up in the eval's latency rollup looking like a measurement.
      timings: { firstEventMs: null, totalMs, slowCount: 0 },
      usage: reply.usage,
      finishReason: reply.finishReason,
      notes: capabilityNotes,
    };
  }

  function getState() {
    return state;
  }

  function close() {
    closed = true;
    try {
      session?.close();
    } catch {
      /* already gone */
    }
    session = null;
  }

  return { sendTurn, getState, transcript, close, surface: liveSurface(env) };
}

/**
 * Live reports `promptTokenCount` / `responseTokenCount`; the eval's cost
 * report and truncation telemetry read `promptTokens` / `outputTokens`.
 *
 * Accumulation is NOT done here. `usageMetadata` on a Live session is already
 * cumulative for the session, and adding it up per turn is defect #1 and #7 of
 * the handoff's harness list -- the same mistake made twice, over-reporting a
 * multi-turn run several-fold.
 */
function normaliseUsage(u) {
  if (!u) return null;
  return {
    promptTokens: u.promptTokenCount ?? null,
    outputTokens: u.responseTokenCount ?? u.candidatesTokenCount ?? null,
    totalTokens: u.totalTokenCount ?? null,
  };
}
