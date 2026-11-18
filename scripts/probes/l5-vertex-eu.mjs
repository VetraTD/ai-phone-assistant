// ---------------------------------------------------------------------------
// L5 — does Gemini Live work at all in europe-west1? V7.
//
//   node scripts/probes/l5-vertex-eu.mjs
//
// This is the hard gate, not a nice-to-have. The estate is UK-first. If Gemini
// Live cannot serve from a European region, then no amount of latency or cost
// advantage matters, because the residency requirement is not negotiable and
// OpenAI wins the decision by default.
//
// The reported symptom is specific: the session opens, turn 1 answers, and then
// turn 2 returns silence — no `model_turn` at all. So the assertion is NOT
// "did it connect". A probe that only checked the handshake would have passed
// while the product was broken.
//
// PROJECT DISCIPLINE. `project` and `location` are passed explicitly and the
// resolved values are printed before anything is spent. The machine's gcloud
// default is `physicianmessagingapp`, an unrelated estate, and a client that
// silently inherits it would produce a perfectly clean run against the wrong
// project — which is exactly how this trap has caught this work before.
//
// Sequenced last because it depends on ADC, which is interactive.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import { geminiFrames, paceFrames, silenceFrames, sleep } from "./lib/audio.js";
import { SYSTEM_PROMPT, GEMINI_TOOLS } from "./lib/prompt.js";
import { geminiToolResponses } from "./lib/tools.js";
import { emptyUsage, addUsage } from "./lib/geminiUsage.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { errorGuard, writeRaw } from "./lib/stats.js";

const PROJECT = "vetra-uk-edc8ca";
const LOCATION = "europe-west1";
const MODEL = process.env.PROBE_MODEL || "gemini-live-2.5-flash-native-audio";
const N = 5;
/** 4 turns, per PLAN.md. Turn 1 is the control; 2-4 are where silence is reported. */
const TURNS = ["clean_open", "rep_time_q", "rep_digits", "rep_confirm"];
const TURN_TIMEOUT_MS = 20000;
const EST_PER_SESSION = 0.04;

const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });

const LIVE_CONFIG = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  tools: [GEMINI_TOOLS],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

async function waitFor(pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (pred()) return true; await sleep(5); }
  return false;
}

/**
 * Wait until the model has actually STOPPED sending audio.
 *
 * The first version of this probe advanced to the next caller turn on
 * `turnComplete`. That is not the same event: audio kept arriving afterwards,
 * so turn 1's reply tail landed inside turn 2's measurement window and turn 2
 * scored a model_leg of -1,800 ms with `heard: ""` and a `said` that was a
 * fragment of turn 1 ("Are you a new"). Read naively that looks like turn 2
 * answering, which would have scored V7 a pass on turn-1 audio — the precise
 * mistake this probe exists to avoid.
 *
 * Quiet period, not turnComplete: no audio chunk for `quietMs`.
 */
async function waitForQuiet(state, { quietMs = 800, maxMs = 15000 } = {}) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const since = state.lastAudioAt ? Date.now() - state.lastAudioAt : Infinity;
    if (state.lastAudioAt && since >= quietMs) return true;
    await sleep(20);
  }
  return false;
}

async function openSession() {
  const state = {
    events: [], firstAudioAt: null, lastAudioAt: null, turnCompleteAt: null, audioChunks: 0,
    inputTranscript: "", outputTranscript: "", turnToolCalls: [],
    usage: emptyUsage(), session: null, error: null,
  };
  const session = await ai.live.connect({
    model: MODEL,
    config: LIVE_CONFIG,
    callbacks: {
      onmessage: (msg) => {
        const at = Date.now();
        if (msg.setupComplete) state.events.push({ at, t: "setupComplete" });
        if (msg.usageMetadata) addUsage(state.usage, msg.usageMetadata);
        if (msg.toolCall) {
          const calls = msg.toolCall.functionCalls || [];
          state.turnToolCalls.push(...calls.map((c) => c.name));
          try { state.session?.sendToolResponse({ functionResponses: geminiToolResponses(calls) }); } catch {}
        }
        const sc = msg.serverContent;
        if (!sc) return;
        // The assertion target: a model_turn carrying audio.
        if (sc.modelTurn?.parts?.some((p) => p.inlineData?.data)) {
          state.audioChunks++;
          state.lastAudioAt = at;
          if (state.firstAudioAt === null) { state.firstAudioAt = at; state.events.push({ at, t: "modelTurnAudio" }); }
        }
        if (sc.inputTranscription?.text) state.inputTranscript += sc.inputTranscription.text;
        if (sc.outputTranscription?.text) state.outputTranscript += sc.outputTranscription.text;
        if (sc.turnComplete) { state.turnCompleteAt = at; state.events.push({ at, t: "turnComplete" }); }
      },
      onerror: (e) => { state.error = e?.message || String(e); state.events.push({ at: Date.now(), t: "error", msg: state.error }); },
      onclose: (e) => state.events.push({ at: Date.now(), t: "close", reason: e?.reason }),
    },
  });
  state.session = session;
  return { session, state };
}

const sendAudio = (session, f) =>
  session.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } });

async function run(idx) {
  reserve(`L5 run ${idx + 1}`, EST_PER_SESSION);
  const { session, state } = await openSession();
  const turns = [];
  try {
    await waitFor(() => state.events.some((e) => e.t === "setupComplete"), 15000);
    for (let i = 0; i < TURNS.length; i++) {
      const label = TURNS[i];
      state.firstAudioAt = null; state.lastAudioAt = null; state.turnCompleteAt = null;
      state.audioChunks = 0; state.outputTranscript = ""; state.turnToolCalls = [];
      const before = state.inputTranscript;
      await paceFrames(geminiFrames(label).frames, (f) => sendAudio(session, f));
      const tSpeechEnd = Date.now();
      await paceFrames(silenceFrames("pcm16k", 5000), (f) => sendAudio(session, f), {
        stop: () => state.firstAudioAt !== null,
      });
      await waitFor(() => state.firstAudioAt !== null, TURN_TIMEOUT_MS);
      // Drain the reply fully before the next caller turn, or its tail lands in
      // the next turn's window. See waitForQuiet.
      await waitForQuiet(state);
      turns.push({
        turn: i + 1, label,
        model_turn: state.firstAudioAt !== null,
        model_leg_ms: state.firstAudioAt !== null ? state.firstAudioAt - tSpeechEnd : null,
        audio_chunks: state.audioChunks,
        heard: state.inputTranscript.slice(before.length).trim(),
        said: state.outputTranscript.trim().slice(0, 200),
        tools: [...state.turnToolCalls],
      });
      await sleep(250);
    }
  } finally { try { session.close(); } catch {} await sleep(400); }

  const usage = state.usage;
  const cost = price(MODEL, usage);
  commit({ probe: "L5", arm: "vertex-eu", run: idx + 1, model: MODEL, usage, usd: cost.usd });

  const later = turns.filter((t) => t.turn >= 2);
  return {
    run: idx + 1, turns,
    turn1_ok: turns[0]?.model_turn === true,
    turns_2_4_ok: later.length > 0 && later.every((t) => t.model_turn),
    silent_turns: later.filter((t) => !t.model_turn).map((t) => t.turn),
    usage, usd: cost.usd, error: state.error,
  };
}

async function main() {
  console.log(`L5 — Gemini Live on Vertex`);
  console.log(`  project  ${PROJECT}`);
  console.log(`  location ${LOCATION}`);
  console.log(`  model    ${MODEL}`);
  console.log(`  (NOT physicianmessagingapp — passed explicitly, not inherited from gcloud)`);
  console.log(`spent so far $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);

  const guard = errorGuard(3);
  const runs = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await run(i);
      guard.ok(); runs.push(r);
      console.log(
        `  run ${i + 1}: turn1=${r.turn1_ok ? "OK" : "SILENT"}  turns2-4=${r.turns_2_4_ok ? "OK" : "SILENT " + JSON.stringify(r.silent_turns)}` +
        `  legs [${r.turns.map((t) => t.model_leg_ms ?? "MISS").join(", ")}]  $${r.usd.toFixed(4)}`
      );
    } catch (err) {
      if (err.name === "BudgetExceeded") throw err;
      console.log(`  run ${i + 1}: FAILED — ${err.message?.slice(0, 220)}`);
      runs.push({ run: i + 1, error: err.message });
      try { guard.fail(err); } catch (stop) { console.log(stop.message); break; }
    }
  }

  const ok = runs.filter((r) => r.turn1_ok && r.turns_2_4_ok).length;
  const summary = {
    probe: "L5", project: PROJECT, location: LOCATION, model: MODEL, n: runs.length,
    fully_working_runs: ok,
    turn1_ok_runs: runs.filter((r) => r.turn1_ok).length,
    turn2_silence_reproduced: runs.some((r) => r.turn1_ok && !r.turns_2_4_ok),
    connect_failures: runs.filter((r) => r.error && !r.turns).length,
    errors: [...new Set(runs.map((r) => r.error).filter(Boolean))],
    usd: runs.reduce((s, r) => s + (r.usd || 0), 0),
  };
  writeRaw("l5-vertex-eu", { summary, runs });
  console.log(`\n  fully working ${ok}/${runs.length}   turn-2 silence reproduced: ${summary.turn2_silence_reproduced}`);
  if (summary.errors.length) console.log(`  errors: ${summary.errors.map((e) => e.slice(0, 160)).join(" | ")}`);
  console.log(`  L5 cost $${summary.usd.toFixed(4)} — running total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`L5 ABORTED: ${e.message}`); process.exit(1); });
