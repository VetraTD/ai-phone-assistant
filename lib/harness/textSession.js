/**
 * Text-in / text-out session driver.
 *
 * Drives the REAL production brain — real prompt assembly and tool dispatch
 * (services/gemini.js getReplyStreaming, via lib/voice/llmTurn.js's timeout
 * wrapper), the real reply-state reducer (lib/voice/replyState.js), and the real
 * capability effect dispatch (lib/capabilities/effects.js) — with no Twilio,
 * Deepgram, ElevenLabs, or Supabase. Capability data reads/writes and post-turn
 * notifications are served by the in-memory fakes in lib/harness/fakeDeps.js.
 *
 * This is the shared foundation for the CLI chat and the eval suite: those get a
 * turn-taking conversation identical to what a live caller drives, minus audio.
 *
 * NB the initial step is IDENTIFY_INTENT, not GREETING. The live session opens a
 * call at GREETING (lib/callState.js) but advances to IDENTIFY_INTENT the instant
 * it plays the (static, non-LLM) greeting, before any caller utterance is
 * processed — so every real getReplyStreaming turn in production starts at
 * IDENTIFY_INTENT or later. Starting a text turn there is what makes the reducer's
 * "intent set at IDENTIFY_INTENT advances to GATHER_DETAILS" transition fire the
 * same way it does live. There is no greeting turn to replay here.
 */

import { runLlmTurn } from "../voice/llmTurn.js";
import { applyReplyState } from "../voice/replyState.js";
import { STEPS } from "../callState.js";
import {
  dispatchCapabilityEffects,
  mergeCapabilityState as mergeCapabilityStateInto,
} from "../capabilities/effects.js";
import { makeFakeEffectsDeps } from "./fakeDeps.js";

/**
 * @param {object} params
 * @param {object} params.config - normalized business config (see tests/fixtures)
 * @param {object} [params.extras] - the getReplyStreaming extras bag (knowledge,
 *   integrations, callerContext, businessId, callerPhone, transferAllowed, …)
 * @param {object} [params.modelOverrides] - forwarded as extras.modelOverrides
 * @param {object} params.fakes - `{ deps, store, effects? }`. `deps` is the
 *   capability-deps surface (makeFakeDeps) handed to packs via
 *   extras.capabilityDeps. `effects` is a makeFakeEffectsDeps() result
 *   (`{ deps, captured }`) for post-turn effect dispatch; created internally if
 *   omitted (its captured log is then unreachable — pass one to inspect it).
 * @param {string} [params.callerNumber="+15550001111"]
 * @param {number} [params.firstChunkTimeoutMs]
 * @param {number} [params.totalTimeoutMs]
 * @returns {{ sendTurn: (text:string)=>Promise<object>, getState: ()=>object, transcript: Array }}
 */
export function createTextSession({
  config,
  extras = {},
  modelOverrides,
  fakes,
  callerNumber = "+15550001111",
  firstChunkTimeoutMs,
  totalTimeoutMs,
}) {
  if (!fakes || !fakes.deps) {
    throw new Error("createTextSession requires fakes.deps (from makeFakeDeps)");
  }
  const effects = fakes.effects || makeFakeEffectsDeps();
  const businessId = extras.businessId ?? config?.businessId ?? null;

  // Mirrors the live session's turn-relevant state shape (lib/callState.js) —
  // only the fields the reducer and effect dispatch touch.
  const state = {
    step: STEPS.IDENTIFY_INTENT,
    intent: null,
    history: [],
    capabilityState: {},
    consecutiveFailures: 0,
    config,
  };

  const transcript = [];

  // Reducer hooks — identical wiring to lib/voice/session.js:1452-1482, minus
  // the logging/timers the pure reducer deliberately leaves to the caller.
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
      call: {
        callSid: "text-harness",
        businessId,
        callId: null,
        callerNumber,
        twilioNumber: null,
        config,
      },
      deps: effects.deps,
    });
  }

  async function sendTurn(userText) {
    const startedAt = Date.now();
    let firstEventMs = null;
    let text = "";
    let reply = null;
    let slowCount = 0;
    const toolEffects = [];

    const turnExtras = { ...extras, capabilityDeps: fakes.deps };
    if (modelOverrides !== undefined) turnExtras.modelOverrides = modelOverrides;

    const gen = runLlmTurn({
      history: state.history,
      userText,
      step: state.step,
      intent: state.intent,
      config,
      extras: turnExtras,
      firstChunkTimeoutMs,
      totalTimeoutMs,
    });

    for await (const ev of gen) {
      if (firstEventMs === null) firstEventMs = Date.now() - startedAt;
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "slow") slowCount += 1;
      else if (ev.type === "toolEffect") toolEffects.push(ev.effect);
      else if (ev.type === "done") reply = ev.reply;
    }

    const totalMs = Date.now() - startedAt;

    // A turn that never produced a `done` reply (e.g. total-timeout abort or a
    // generator that ended without one) leaves state untouched, exactly as the
    // live session's applyReply is simply never called in that case. The salvage
    // path is a session-only concern; report the timings and move on.
    if (!reply) {
      transcript.push({ role: "user", text: userText, toolCalls: [], step: state.step, intent: state.intent });
      return {
        text,
        reply: null,
        toolCalls: [],
        toolResults: [],
        toolEffects,
        state: { step: state.step, intent: state.intent },
        timings: { firstEventMs, totalMs, slowCount },
        notes: [],
      };
    }

    const toolResults = reply.toolResults || [];
    const toolCalls = (reply.toolCallEvents || []).map((e) => ({ name: e.name, args: e.args }));

    const { capabilityNotes } = applyReplyState(
      state,
      { userText, reply },
      { STEPS, mergeCapabilityState, dispatchEffects }
    );

    transcript.push({ role: "user", text: userText, toolCalls: [], step: state.step, intent: state.intent });
    transcript.push({ role: "model", text, toolCalls, step: state.step, intent: state.intent });

    return {
      text,
      reply,
      toolCalls,
      toolResults,
      toolEffects,
      state: { step: state.step, intent: state.intent },
      timings: { firstEventMs, totalMs, slowCount },
      notes: capabilityNotes,
    };
  }

  function getState() {
    return state;
  }

  return { sendTurn, getState, transcript };
}
