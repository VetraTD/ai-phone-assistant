// ---------------------------------------------------------------------------
// L1 — Gemini Live: model leg latency + barge-in. Decides V1, V2, V3.
//
//   node scripts/probes/l1-gemini-live.mjs
//
// METRIC NAME, deliberately: `model_leg_ms` = last caller audio frame sent ->
// first model audio byte received. NOT voice-to-voice. There is no Twilio leg
// and no playout queue in this harness, so calling it v2v would repeat the
// 2026-08-04 error where an assumed 1,500 ms turned out to be 3,062 ms.
//
// Note what model_leg_ms CONTAINS that the cascade's 940 ms llm_ttfb does not:
// the vendor's own endpointing wait. In the cascade that wait is a separate
// ~500 ms of stt_endpoint, and TTS time-to-first-byte is separate again. So a
// literal comparison against 940 ms is harsh on the vendor; the report states
// both that literal V1 result and the like-for-like turn comparison.
//
// Arms: 5 conversation runs x 5 turns (V1); 5 barge-in trials (V2, V3).
// ---------------------------------------------------------------------------
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import { geminiFrames, paceFrames, silenceFrames, sleep } from "./lib/audio.js";
import { SYSTEM_PROMPT, GEMINI_TOOLS, CONVERSATION_TURNS, PROMPT_STATS } from "./lib/prompt.js";
import { geminiToolResponses } from "./lib/tools.js";
import { emptyUsage, addUsage } from "./lib/geminiUsage.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { p50, p95, mean, errorGuard, writeRaw, readRaw } from "./lib/stats.js";

const MODEL = "gemini-3.1-flash-live-preview";
const N = 5;
const TURN_TIMEOUT_MS = 20000;
/** Worst-case per session, for the budget reservation. Real cost is ~1/3 of this. */
const EST_PER_SESSION = 0.08;
/** Re-run one arm and merge, so a fix does not mean paying for both arms again. */
const ONLY = process.env.PROBE_ONLY || null;
const runArm = (n) => !ONLY || ONLY === n;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const LIVE_CONFIG = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  tools: [GEMINI_TOOLS],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

/**
 * One live session with an event log. Every message is timestamped on ARRIVAL
 * so latency is measured where we actually learn something, not where a
 * convenience wrapper decided to surface it.
 */
async function openSession(tag) {
  const events = [];
  const state = {
    tag, events,
    audioChunks: 0, audioBytes: 0,
    firstAudioAt: null, lastAudioAt: null,
    interruptedAt: null, turnCompleteAt: null, generationCompleteAt: null,
    inputTranscript: "", outputTranscript: "",
    toolCalls: [], turnToolCalls: [], usage: emptyUsage(), closed: false, error: null,
    // Back-reference so the onmessage handler can answer a tool call. It is
    // assigned after connect() resolves, which is safe: no message can arrive
    // before the socket the handler belongs to exists.
    session: null,
  };
  const session = await ai.live.connect({
    model: MODEL,
    config: LIVE_CONFIG,
    callbacks: {
      onmessage: (msg) => {
        const at = Date.now();
        const sc = msg.serverContent;
        if (msg.setupComplete) events.push({ at, t: "setupComplete" });
        if (msg.usageMetadata) addUsage(state.usage, msg.usageMetadata);
        if (msg.toolCall) {
          const calls = msg.toolCall.functionCalls || [];
          state.toolCalls.push(...calls);
          state.turnToolCalls.push(...calls.map((f) => f.name));
          events.push({ at, t: "toolCall", names: calls.map((f) => f.name) });
          // Answer immediately. The model is blocked until we do, and every
          // millisecond we sit here lands inside model_leg_ms as if it were
          // the vendor's. See lib/tools.js for why the result is canned.
          try {
            state.session?.sendToolResponse({ functionResponses: geminiToolResponses(calls) });
          } catch (e) {
            events.push({ at: Date.now(), t: "toolResponseError", msg: e?.message });
          }
        }
        if (!sc) return;
        const part = sc.modelTurn?.parts?.find((p) => p.inlineData?.data);
        if (part) {
          const bytes = Buffer.from(part.inlineData.data, "base64").length;
          state.audioChunks++; state.audioBytes += bytes;
          if (state.firstAudioAt === null) { state.firstAudioAt = at; events.push({ at, t: "firstAudio" }); }
          state.lastAudioAt = at;
        }
        if (sc.inputTranscription?.text) state.inputTranscript += sc.inputTranscription.text;
        if (sc.outputTranscription?.text) state.outputTranscript += sc.outputTranscription.text;
        if (sc.interrupted) { state.interruptedAt = at; events.push({ at, t: "interrupted" }); }
        if (sc.generationComplete) { state.generationCompleteAt = at; events.push({ at, t: "generationComplete" }); }
        if (sc.turnComplete) { state.turnCompleteAt = at; events.push({ at, t: "turnComplete" }); }
      },
      onerror: (e) => { state.error = e?.message || String(e); events.push({ at: Date.now(), t: "error", msg: state.error }); },
      onclose: () => { state.closed = true; events.push({ at: Date.now(), t: "close" }); },
    },
  });
  state.session = session;
  return { session, state };
}

function sendAudio(session, frame) {
  session.sendRealtimeInput({
    audio: { data: frame.toString("base64"), mimeType: "audio/pcm;rate=16000" },
  });
}

/** Reset the per-turn observation window without dropping the session. */
function armTurn(state) {
  state.firstAudioAt = null; state.lastAudioAt = null;
  state.turnCompleteAt = null; state.generationCompleteAt = null;
  state.interruptedAt = null; state.audioChunks = 0; state.audioBytes = 0;
  state.outputTranscript = ""; state.turnToolCalls = [];
}

async function waitFor(pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (pred()) return true; await sleep(5); }
  return false;
}

/**
 * Send one caller utterance, then keep the stream alive with real silence
 * frames until the model answers.
 *
 * The padding is not padding: Twilio delivers a 20 ms frame every 20 ms for the
 * whole call, so silence is what the vendor's VAD actually hears at the end of
 * an utterance. Without it the socket simply goes quiet, which reads as a
 * stalled stream rather than end-of-turn, and the model never replies. That was
 * the first version of this probe, and it measured nothing.
 *
 * `model_leg_ms` is timed from the last SPEECH frame, so the vendor's own
 * endpointing wait is inside the number rather than hidden by the padding.
 *
 * @returns {Promise<{tSpeechEnd:number, model_leg_ms:number|null, padded_ms:number}>}
 */
async function sendUtterance(session, state, label, { maxPadMs = 4000 } = {}) {
  const fx = geminiFrames(label);
  await paceFrames(fx.frames, (f) => sendAudio(session, f));
  const tSpeechEnd = Date.now();
  const pad = silenceFrames("pcm16k", maxPadMs);
  const padRun = await paceFrames(pad, (f) => sendAudio(session, f), {
    stop: () => state.firstAudioAt !== null,
  });
  // If the pad ran out before any audio, keep waiting a little without sending
  // — at that point the vendor has had 4 s of silence and more will not help.
  if (state.firstAudioAt === null) await waitFor(() => state.firstAudioAt !== null, TURN_TIMEOUT_MS - maxPadMs);
  return {
    tSpeechEnd,
    seconds: fx.seconds,
    model_leg_ms: state.firstAudioAt !== null ? state.firstAudioAt - tSpeechEnd : null,
    padded_ms: padRun.elapsedMs,
  };
}

/** One 5-turn conversation. Produces one model_leg_ms per turn. */
async function conversationRun(idx) {
  reserve(`L1 conversation ${idx + 1}`, EST_PER_SESSION);
  const { session, state } = await openSession(`conv${idx + 1}`);
  const turns = [];
  try {
    await waitFor(() => state.events.some((e) => e.t === "setupComplete"), 10000);
    for (const label of CONVERSATION_TURNS) {
      armTurn(state);
      const sent = await sendUtterance(session, state, label);
      // Let the reply finish before the next caller turn, exactly as a real
      // caller would. Cutting it short would turn every turn into a barge-in.
      await waitFor(() => state.turnCompleteAt !== null, TURN_TIMEOUT_MS);
      turns.push({
        label, seconds: sent.seconds, model_leg_ms: sent.model_leg_ms, padded_ms: sent.padded_ms,
        audio_chunks: state.audioChunks, audio_bytes: state.audioBytes,
        heard: state.inputTranscript.trim(),
        said: state.outputTranscript.trim().slice(0, 300),
        // Per-turn, not cumulative: a tool turn costs a second model leg, and
        // the cascade baseline separates them the same way (~900 ms plain vs
        // ~1,800 ms tool). Averaging the two together would hide that.
        tools: [...state.turnToolCalls],
        turn_complete: state.turnCompleteAt !== null,
      });
      state.inputTranscript = "";
      await sleep(250);
    }
  } finally {
    try { session.close(); } catch {}
    await sleep(400);
  }
  const usage = state.usage;
  const cost = price(MODEL, usage);
  commit({ probe: "L1", arm: "conversation", run: idx + 1, model: MODEL, usage, usd: cost.usd });
  return { run: idx + 1, turns, usage, usd: cost.usd, usage_raw: state.usage, error: state.error };
}

/**
 * One barge-in trial: open, let the model start speaking, then talk over it
 * 400 ms in — the same 400 ms offset lib/probe/script.js uses, so this is the
 * same event the cascade's 340 ms trade was measured against.
 */
async function bargeRun(idx) {
  reserve(`L1 barge ${idx + 1}`, EST_PER_SESSION);
  const { session, state } = await openSession(`barge${idx + 1}`);
  let row = { trial: idx + 1 };
  try {
    await waitFor(() => state.events.some((e) => e.t === "setupComplete"), 10000);
    armTurn(state);
    const opener = await sendUtterance(session, state, "clean_open");
    const speaking = state.firstAudioAt !== null;
    if (!speaking) {
      row = { ...row, barged: false, skip_reason: "model never started speaking" };
    } else {
      // 400 ms into the model's reply, start talking over it.
      await sleep(400);
      const chunksBeforeBarge = state.audioChunks;
      state.interruptedAt = null;
      const barge = geminiFrames("barge_in");
      const tBargeStart = Date.now();
      let firstFrameAt = null;
      await paceFrames(barge.frames, (f) => {
        if (firstFrameAt === null) firstFrameAt = Date.now();
        sendAudio(session, f);
      });
      const gotInterrupt = await waitFor(() => state.interruptedAt !== null, TURN_TIMEOUT_MS);
      const chunksAtInterrupt = state.audioChunks;
      // Watch a further second for audio the vendor sends AFTER signalling the
      // interrupt — that is what would still be in our playout queue, and it is
      // the difference between "signalled" and "actually stopped".
      const lastAudioBefore = state.lastAudioAt;
      await sleep(1000);
      row = {
        ...row,
        barged: true,
        opener_model_leg_ms: opener.model_leg_ms,
        interrupted: gotInterrupt,
        barge_to_interrupted_ms: gotInterrupt ? state.interruptedAt - firstFrameAt : null,
        barge_to_last_audio_ms: state.lastAudioAt ? state.lastAudioAt - firstFrameAt : null,
        chunks_before_barge: chunksBeforeBarge,
        chunks_at_interrupt: chunksAtInterrupt,
        audio_after_interrupt: state.lastAudioAt && state.interruptedAt ? state.lastAudioAt > state.interruptedAt : false,
        audio_still_arriving_1s_later: state.lastAudioAt !== lastAudioBefore,
        said: state.outputTranscript.trim().slice(0, 200),
        heard: state.inputTranscript.trim(),
        barge_send_ms: Date.now() - tBargeStart,
      };
    }
  } finally {
    try { session.close(); } catch {}
    await sleep(400);
  }
  const usage = state.usage;
  const cost = price(MODEL, usage);
  commit({ probe: "L1", arm: "barge", run: idx + 1, model: MODEL, usage, usd: cost.usd });
  return { ...row, usage, usd: cost.usd, usage_raw: state.usage, error: state.error };
}


async function main() {
  console.log(`L1 — Gemini Live  ${MODEL}`);
  console.log(`prompt ${PROMPT_STATS.chars} chars (~${PROMPT_STATS.approx_tokens} tok), ${PROMPT_STATS.tools} tools, ${PROMPT_STATS.business}`);
  console.log(`spent so far $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);

  const guard = errorGuard(3);
  const prior = ONLY ? (readRaw("l1-gemini") || {}) : {};
  const conversations = [];
  for (let i = 0; runArm("conversation") && i < N; i++) {
    try {
      const r = await conversationRun(i);
      guard.ok();
      conversations.push(r);
      const legs = r.turns.map((t) => t.model_leg_ms).filter((n) => n != null);
      console.log(`  conv ${i + 1}: legs [${r.turns.map((t) => t.model_leg_ms ?? "MISS").join(", ")}] ms  p50 ${p50(legs)}  $${r.usd.toFixed(4)}`);
    } catch (err) {
      if (err.name === "BudgetExceeded" || err.name === "SocketErrorStreak") throw err;
      console.log(`  conv ${i + 1}: FAILED — ${err.message?.slice(0, 140)}`);
      conversations.push({ run: i + 1, error: err.message, turns: [] });
      guard.fail(err);
    }
  }

  const barges = [];
  for (let i = 0; runArm("barge") && i < N; i++) {
    try {
      const r = await bargeRun(i);
      guard.ok();
      barges.push(r);
      console.log(`  barge ${i + 1}: interrupted=${r.interrupted} at ${r.barge_to_interrupted_ms ?? "-"}ms  audio_after=${r.audio_after_interrupt}  $${r.usd.toFixed(4)}`);
    } catch (err) {
      if (err.name === "BudgetExceeded" || err.name === "SocketErrorStreak") throw err;
      console.log(`  barge ${i + 1}: FAILED — ${err.message?.slice(0, 140)}`);
      barges.push({ trial: i + 1, error: err.message });
      guard.fail(err);
    }
  }

  const finalConversations = runArm("conversation") ? conversations : (prior.conversations || []);
  const finalBarges = runArm("barge") ? barges : (prior.barges || []);

  const allLegs = finalConversations.flatMap((c) => (c.turns || []).map((t) => t.model_leg_ms)).filter((n) => n != null);
  const interrupts = finalBarges.filter((b) => b.interrupted).length;
  const stopLatencies = finalBarges.map((b) => b.barge_to_interrupted_ms).filter((n) => n != null);

  const summary = {
    probe: "L1", model: MODEL, n: N,
    prompt: PROMPT_STATS,
    model_leg_ms: { p50: p50(allLegs), p95: p95(allLegs), mean: mean(allLegs), n: allLegs.length, samples: allLegs },
    barge: {
      trials: finalBarges.length,
      interrupted_count: interrupts,
      stop_latency_ms: { p50: p50(stopLatencies), p95: p95(stopLatencies), samples: stopLatencies },
      audio_after_interrupt_count: finalBarges.filter((b) => b.audio_after_interrupt).length,
    },
    usd: finalConversations.reduce((s, c) => s + (c.usd || 0), 0) + finalBarges.reduce((s, b) => s + (b.usd || 0), 0),
  };

  writeRaw("l1-gemini", { summary, conversations: finalConversations, barges: finalBarges });
  console.log(`\n  model_leg_ms p50 ${summary.model_leg_ms.p50} (n=${allLegs.length})   barge interrupts ${interrupts}/${finalBarges.length}   stop p50 ${summary.barge.stop_latency_ms.p50}`);
  console.log(`  L1 cost $${summary.usd.toFixed(4)} — running total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`L1 ABORTED: ${e.message}`); process.exit(1); });
