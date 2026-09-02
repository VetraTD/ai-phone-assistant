// ---------------------------------------------------------------------------
// Shared Gemini Live session for round 2.
//
// Round 1's probes each carried their own copy of this plumbing. That is why
// the same two bugs — per-turn usage overwritten instead of accumulated, and a
// turn boundary taken from `turnComplete` instead of a quiet period — had to be
// found and fixed three times. One implementation now, so a fix lands once.
//
// Supports both surfaces, because they are not interchangeable:
//   vertex:   the BAA- and residency-eligible path. ADC auth, explicit project
//             and location. Only `gemini-live-2.5-flash-native-audio` exists,
//             and only in europe-west1 / us-central1 — NOT europe-west2.
//   aistudio: the consumer API-key path. Only `gemini-3.1-flash-live-preview`.
//             Fast and cheap and not deployable for this estate.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import { geminiToolResponses } from "./tools.js";
import { emptyUsage, addUsage } from "./geminiUsage.js";
import { SYSTEM_PROMPT, GEMINI_TOOLS } from "./prompt.js";

export const VERTEX_PROJECT = "vetra-uk-edc8ca";
export const VERTEX_LOCATION = "europe-west1";
export const VERTEX_MODEL = "gemini-live-2.5-flash-native-audio";
export const STUDIO_MODEL = "gemini-3.1-flash-live-preview";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function client(surface, location = VERTEX_LOCATION) {
  return surface === "vertex"
    ? new GoogleGenAI({ vertexai: true, project: VERTEX_PROJECT, location })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

/**
 * @param {object} opts
 * @param {"vertex"|"aistudio"} opts.surface
 * @param {string} [opts.model]
 * @param {string} [opts.location]
 * @param {object} [opts.automaticActivityDetection] - VAD tuning, or {disabled:true} for manual
 * @param {boolean} [opts.answerTools=true]
 */
export async function openSession(opts) {
  const surface = opts.surface || "vertex";
  const model = opts.model || (surface === "vertex" ? VERTEX_MODEL : STUDIO_MODEL);
  const ai = client(surface, opts.location);

  const state = {
    surface, model, events: [],
    firstAudioAt: null, lastAudioAt: null, audioChunks: 0, audioBytes: 0,
    interruptedAt: null, turnCompleteAt: null, generationCompleteAt: null,
    inputTranscript: "", outputTranscript: "",
    turnToolCalls: [], usage: emptyUsage(), session: null, error: null,
  };

  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [GEMINI_TOOLS],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (opts.automaticActivityDetection) {
    config.realtimeInputConfig = { automaticActivityDetection: opts.automaticActivityDetection };
  }

  const session = await ai.live.connect({
    model, config,
    callbacks: {
      onmessage: (msg) => {
        const at = Date.now();
        if (msg.setupComplete) state.events.push({ at, t: "setupComplete" });
        if (msg.usageMetadata) addUsage(state.usage, msg.usageMetadata);
        if (msg.toolCall) {
          const calls = msg.toolCall.functionCalls || [];
          state.turnToolCalls.push(...calls.map((c) => c.name));
          state.events.push({ at, t: "toolCall", names: calls.map((c) => c.name) });
          if (opts.answerTools !== false) {
            try { state.session?.sendToolResponse({ functionResponses: geminiToolResponses(calls) }); } catch {}
          }
        }
        const sc = msg.serverContent;
        if (!sc) return;
        if (sc.modelTurn?.parts?.some((p) => p.inlineData?.data)) {
          const b = sc.modelTurn.parts.find((p) => p.inlineData?.data);
          state.audioChunks++;
          state.audioBytes += Buffer.from(b.inlineData.data, "base64").length;
          state.lastAudioAt = at;
          if (state.firstAudioAt === null) { state.firstAudioAt = at; state.events.push({ at, t: "firstAudio" }); }
        }
        if (sc.inputTranscription?.text) state.inputTranscript += sc.inputTranscription.text;
        if (sc.outputTranscription?.text) state.outputTranscript += sc.outputTranscription.text;
        if (sc.interrupted) { state.interruptedAt = at; state.events.push({ at, t: "interrupted" }); }
        if (sc.generationComplete) { state.generationCompleteAt = at; }
        if (sc.turnComplete) { state.turnCompleteAt = at; state.events.push({ at, t: "turnComplete" }); }
      },
      onerror: (e) => { state.error = e?.message || String(e); },
      onclose: (e) => state.events.push({ at: Date.now(), t: "close", reason: e?.reason }),
    },
  });
  state.session = session;
  return { session, state };
}

export const sendAudio = (session, f) =>
  session.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } });

export function armTurn(state) {
  state.firstAudioAt = null; state.lastAudioAt = null;
  state.interruptedAt = null; state.turnCompleteAt = null; state.generationCompleteAt = null;
  state.audioChunks = 0; state.audioBytes = 0;
  state.outputTranscript = ""; state.turnToolCalls = [];
}

export async function waitFor(pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (pred()) return true; await sleep(5); }
  return false;
}

/**
 * Wait until the model has stopped sending audio. `turnComplete` is not the
 * same event — round 1 proved audio keeps arriving after it, which credited one
 * turn's reply tail to the next turn's latency window.
 */
export async function waitForQuiet(state, { quietMs = 800, maxMs = 15000 } = {}) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (state.lastAudioAt && Date.now() - state.lastAudioAt >= quietMs) return true;
    await sleep(20);
  }
  return false;
}

export const setupOk = (state) => waitFor(() => state.events.some((e) => e.t === "setupComplete"), 15000);
