// ---------------------------------------------------------------------------
// L2 — OpenAI Realtime mini: latency, barge-in, and semantic_vad. V4, V5.
//
//   node scripts/probes/l2-openai-mini.mjs
//
// Three arms:
//   A  5 conversations x 5 turns, server_vad      -> model_leg_ms       (V5)
//   B  5 barge-in trials                          -> module fate parity with L1
//   C  semantic_vad x eagerness{low,medium,high}
//      x {no_terminal_punct, trailing_lead_in,
//         partial_digits} x 5                     -> cut-in rate        (V4)
//
// Arm C is the one that matters most, because semantic_vad is OpenAI's headline
// advantage over Gemini and the three fixtures are the exact utterances our
// hand-built endpointing gets wrong.
//
// HOW "CUT-IN" IS DEFINED, since PLAN.md does not pin it down and the number is
// meaningless without it:
//
//   The caller says something incomplete and pauses. A cut-in is the vendor
//   deciding the turn is OVER during that pause — observed as `response.created`
//   arriving inside the pause window.
//
//   The window is not arbitrary: it is exactly what lib/transcriptUtils.js's
//   classifyHold already charges for that rule (1,500 ms for
//   no_terminal_punctuation and partial_digits, 2,000 ms for trailing_lead_in).
//   So the question this arm answers is precisely "would the vendor have waited
//   as long as our own hand-built rule does?" — which is the question that
//   decides whether the rule can be deleted.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { openSession, appendAudio, billableUsage } from "./lib/openai.js";
import { openaiFrames, paceFrames, silenceFrames, sleep } from "./lib/audio.js";
import { SYSTEM_PROMPT, OPENAI_TOOLS, CONVERSATION_TURNS, PROMPT_STATS } from "./lib/prompt.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { p50, p95, mean, errorGuard, writeRaw, readRaw } from "./lib/stats.js";

const MODEL = process.env.PROBE_MODEL || "gpt-realtime-2.1-mini";
const PROBE = process.env.PROBE_ID || "L2";
const N = Number(process.env.PROBE_N || 5);
const TURN_TIMEOUT_MS = 25000;
const EST_PER_SESSION = Number(process.env.PROBE_EST || 0.06);
/** L3 is a reference ceiling only and skips the expensive semantic_vad grid. */
const RUN_VAD_GRID = process.env.PROBE_SKIP_VAD !== "true";
/**
 * Re-run a single arm and merge it into the existing raw file. Used after the
 * turn-boundary fix, so the corrected conversation latencies replace the
 * contaminated ones without paying again for the barge and semantic_vad arms,
 * whose single-turn sessions the bug could not have touched.
 */
const ONLY = process.env.PROBE_ONLY || null;
const runArm = (name) => !ONLY || ONLY === name;

const SERVER_VAD = {
  type: "server_vad", threshold: 0.5, prefix_padding_ms: 300,
  silence_duration_ms: 500, create_response: true, interrupt_response: true,
};

/** classifyHold's own charge per rule — see the header. */
const PAUSE_WINDOW_MS = {
  no_terminal_punct: 1500,
  trailing_lead_in: 2000,
  partial_digits: 1500,
};

async function waitFor(pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (pred()) return true; await sleep(5); }
  return false;
}

function armTurn(state) {
  state.firstAudioAt = null; state.lastAudioAt = null;
  state.responseCreatedAt = null; state.responseDoneAt = null;
  state.outputTranscript = ""; state.turnToolCalls = [];
  state.audioChunks = 0; state.audioBytes = 0;
}

/**
 * One caller utterance plus the trailing silence the vendor VAD needs to hear.
 * Twilio sends a frame every 20 ms for the life of a call, so the silence is
 * the transport behaving normally, not a nudge to make the model answer.
 */
async function sendUtterance(s, label, { maxPadMs = 5000 } = {}) {
  const fx = openaiFrames(label);
  await paceFrames(fx.frames, (f) => appendAudio(s.send, f));
  const tSpeechEnd = Date.now();
  await paceFrames(silenceFrames("ulaw8k", maxPadMs), (f) => appendAudio(s.send, f), {
    stop: () => s.state.firstAudioAt !== null,
  });
  await waitFor(() => s.state.firstAudioAt !== null, TURN_TIMEOUT_MS);
  return {
    tSpeechEnd, seconds: fx.seconds,
    model_leg_ms: s.state.firstAudioAt !== null ? s.state.firstAudioAt - tSpeechEnd : null,
  };
}

/**
 * The model may answer a turn with a tool call first and speak only afterwards,
 * so "done" is a response.done that landed at or after the first audio — not
 * simply the first response.done, which would stop the clock on the tool leg.
 */
const turnSettled = (state) =>
  state.responseDoneAt !== null && state.firstAudioAt !== null &&
  state.responseDoneAt >= state.firstAudioAt;

/**
 * Wait until the model has actually STOPPED sending audio.
 *
 * response.done is not the same event as "the audio finished arriving". In the
 * first L2 run one turn scored a model_leg of -1,988 ms with an empty
 * transcript, because the previous reply was still streaming when the next
 * caller utterance began and its tail was credited to the wrong turn. A quiet
 * period is the only boundary that cannot do that.
 */
async function waitForQuiet(state, { quietMs = 800, maxMs = 15000 } = {}) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (state.lastAudioAt && Date.now() - state.lastAudioAt >= quietMs) return true;
    await sleep(20);
  }
  return false;
}

async function conversationRun(idx) {
  reserve(`${PROBE} conversation ${idx + 1}`, EST_PER_SESSION);
  const s = await openSession({
    model: MODEL, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS, turnDetection: SERVER_VAD,
  });
  const turns = [];
  try {
    await waitFor(() => s.state.sessionUpdated, 10000);
    for (const label of CONVERSATION_TURNS) {
      armTurn(s.state);
      const before = s.state.inputTranscript;
      const sent = await sendUtterance(s, label);
      await waitFor(() => turnSettled(s.state), TURN_TIMEOUT_MS);
      await waitForQuiet(s.state);
      turns.push({
        label, seconds: sent.seconds, model_leg_ms: sent.model_leg_ms,
        audio_chunks: s.state.audioChunks, audio_bytes: s.state.audioBytes,
        heard: s.state.inputTranscript.slice(before.length).trim(),
        said: s.state.outputTranscript.trim().slice(0, 300),
        tools: [...s.state.turnToolCalls],
      });
      await sleep(250);
    }
  } finally { s.close(); await sleep(300); }
  const usage = billableUsage(s.state.usage);
  const cost = price(MODEL, usage);
  commit({ probe: PROBE, arm: "conversation", run: idx + 1, model: MODEL, usage, usd: cost.usd });
  return { run: idx + 1, turns, usage, usd: cost.usd, error: s.state.error };
}

async function bargeRun(idx) {
  reserve(`${PROBE} barge ${idx + 1}`, EST_PER_SESSION);
  const s = await openSession({
    model: MODEL, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS, turnDetection: SERVER_VAD,
  });
  let row = { trial: idx + 1 };
  try {
    await waitFor(() => s.state.sessionUpdated, 10000);
    armTurn(s.state);
    const opener = await sendUtterance(s, "clean_open");
    if (s.state.firstAudioAt === null) {
      row = { ...row, barged: false, skip_reason: "model never started speaking" };
    } else {
      await sleep(400);
      const chunksBeforeBarge = s.state.audioChunks;
      const cancelledBefore = s.state.cancelled;
      const barge = openaiFrames("barge_in");
      let firstFrameAt = null;
      await paceFrames(barge.frames, (f) => {
        if (firstFrameAt === null) firstFrameAt = Date.now();
        appendAudio(s.send, f);
      });
      // OpenAI signals a barge-in by cancelling the in-flight response, so the
      // observable is speech_started + a cancelled response.done, not a
      // dedicated "interrupted" event as on Gemini.
      const gotSpeech = await waitFor(
        () => s.state.speechStartedAt !== null && s.state.speechStartedAt > firstFrameAt,
        TURN_TIMEOUT_MS
      );
      const gotCancel = await waitFor(() => s.state.cancelled > cancelledBefore, 5000);
      const lastAudioBefore = s.state.lastAudioAt;
      await sleep(1000);
      row = {
        ...row, barged: true,
        opener_model_leg_ms: opener.model_leg_ms,
        interrupted: gotSpeech && gotCancel,
        speech_detected: gotSpeech,
        response_cancelled: gotCancel,
        barge_to_speech_started_ms: gotSpeech ? s.state.speechStartedAt - firstFrameAt : null,
        barge_to_last_audio_ms: s.state.lastAudioAt ? s.state.lastAudioAt - firstFrameAt : null,
        chunks_before_barge: chunksBeforeBarge,
        audio_still_arriving_1s_later: s.state.lastAudioAt !== lastAudioBefore,
      };
    }
  } finally { s.close(); await sleep(300); }
  const usage = billableUsage(s.state.usage);
  const cost = price(MODEL, usage);
  commit({ probe: PROBE, arm: "barge", run: idx + 1, model: MODEL, usage, usd: cost.usd });
  return { ...row, usage, usd: cost.usd, error: s.state.error };
}

/** One semantic_vad trial: incomplete utterance, then a pause. Did it cut in? */
async function vadTrial(eagerness, label, idx) {
  reserve(`${PROBE} vad ${eagerness}/${label} ${idx + 1}`, EST_PER_SESSION);
  const s = await openSession({
    model: MODEL, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS,
    turnDetection: { type: "semantic_vad", eagerness, create_response: true, interrupt_response: true },
  });
  const windowMs = PAUSE_WINDOW_MS[label] ?? 1500;
  let row = { eagerness, label, trial: idx + 1, window_ms: windowMs };
  try {
    await waitFor(() => s.state.sessionUpdated, 10000);
    armTurn(s.state);
    await paceFrames(openaiFrames(label).frames, (f) => appendAudio(s.send, f));
    const tSpeechEnd = Date.now();
    // Hold the pause open with real silence for exactly as long as our own
    // classifyHold rule would have waited, then look at what the vendor did.
    await paceFrames(silenceFrames("ulaw8k", windowMs), (f) => appendAudio(s.send, f));
    const createdAt = s.state.responseCreatedAt;
    const audioAt = s.state.firstAudioAt;
    row = {
      ...row,
      cut_in: createdAt !== null && createdAt - tSpeechEnd < windowMs,
      audio_in_window: audioAt !== null && audioAt - tSpeechEnd < windowMs,
      response_created_ms: createdAt !== null ? createdAt - tSpeechEnd : null,
      first_audio_ms: audioAt !== null ? audioAt - tSpeechEnd : null,
      heard: s.state.inputTranscript.trim(),
      said: s.state.outputTranscript.trim().slice(0, 160),
    };
  } finally { s.close(); await sleep(200); }
  const usage = billableUsage(s.state.usage);
  const cost = price(MODEL, usage);
  commit({ probe: PROBE, arm: `vad:${eagerness}:${label}`, run: idx + 1, model: MODEL, usage, usd: cost.usd });
  return { ...row, usage, usd: cost.usd, error: s.state.error };
}

async function main() {
  console.log(`${PROBE} — OpenAI Realtime  ${MODEL}`);
  console.log(`prompt ${PROMPT_STATS.chars} chars, ${PROMPT_STATS.tools} tools, ${PROMPT_STATS.business}`);
  console.log(`spent so far $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);

  const guard = errorGuard(3);
  const prior = ONLY ? (readRaw(PROBE === "L3" ? "l3-openai-full" : "l2-openai-mini") || {}) : {};
  const conversations = [];
  for (let i = 0; runArm("conversation") && i < N; i++) {
    try {
      const r = await conversationRun(i);
      guard.ok(); conversations.push(r);
      console.log(`  conv ${i + 1}: legs [${r.turns.map((t) => t.model_leg_ms ?? "MISS").join(", ")}] ms  $${r.usd.toFixed(4)}`);
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
      guard.ok(); barges.push(r);
      console.log(`  barge ${i + 1}: interrupted=${r.interrupted} speech@${r.barge_to_speech_started_ms ?? "-"}ms cancelled=${r.response_cancelled}  $${r.usd.toFixed(4)}`);
    } catch (err) {
      if (err.name === "BudgetExceeded" || err.name === "SocketErrorStreak") throw err;
      console.log(`  barge ${i + 1}: FAILED — ${err.message?.slice(0, 140)}`);
      barges.push({ trial: i + 1, error: err.message });
      guard.fail(err);
    }
  }

  const vad = [];
  if (RUN_VAD_GRID && runArm("vad")) {
    console.log("");
    for (const eagerness of ["low", "medium", "high"]) {
      for (const label of ["no_terminal_punct", "trailing_lead_in", "partial_digits"]) {
        const cell = [];
        for (let i = 0; i < N; i++) {
          try {
            const r = await vadTrial(eagerness, label, i);
            guard.ok(); vad.push(r); cell.push(r);
          } catch (err) {
            if (err.name === "BudgetExceeded" || err.name === "SocketErrorStreak") throw err;
            vad.push({ eagerness, label, trial: i + 1, error: err.message });
            guard.fail(err);
          }
        }
        const cutIns = cell.filter((r) => r.cut_in).length;
        console.log(
          `  vad ${eagerness.padEnd(6)} ${label.padEnd(18)} cut-in ${cutIns}/${cell.length}` +
          `  waited ${cell.length - cutIns}/${cell.length}  (window ${PAUSE_WINDOW_MS[label]}ms)`
        );
      }
    }
  }

  // Merge with whatever arms this invocation did not re-run.
  const finalConversations = runArm("conversation") ? conversations : (prior.conversations || []);
  const finalBarges = runArm("barge") ? barges : (prior.barges || []);
  const finalVad = (RUN_VAD_GRID && runArm("vad")) ? vad : (prior.vad || []);

  const allLegs = finalConversations.flatMap((c) => (c.turns || []).map((t) => t.model_leg_ms)).filter((n) => n != null);
  const v4Cells = finalVad.filter((r) => r.eagerness === "low" && ["no_terminal_punct", "trailing_lead_in"].includes(r.label));
  const summary = {
    probe: PROBE, model: MODEL, n: N, prompt: PROMPT_STATS,
    model_leg_ms: { p50: p50(allLegs), p95: p95(allLegs), mean: mean(allLegs), n: allLegs.length, samples: allLegs },
    barge: {
      trials: finalBarges.length,
      interrupted_count: finalBarges.filter((b) => b.interrupted).length,
      speech_latency_ms: { p50: p50(finalBarges.map((b) => b.barge_to_speech_started_ms).filter((n) => n != null)) },
    },
    semantic_vad: finalVad.length ? {
      grid: ["low", "medium", "high"].flatMap((e) =>
        ["no_terminal_punct", "trailing_lead_in", "partial_digits"].map((l) => {
          const cell = finalVad.filter((r) => r.eagerness === e && r.label === l && !r.error);
          return { eagerness: e, label: l, n: cell.length, cut_in: cell.filter((r) => r.cut_in).length,
                   waited: cell.filter((r) => !r.cut_in).length, window_ms: PAUSE_WINDOW_MS[l] };
        })),
      v4: { n: v4Cells.length, waited: v4Cells.filter((r) => !r.cut_in).length, cut_in: v4Cells.filter((r) => r.cut_in).length },
    } : null,
    usd: [...conversations, ...barges, ...vad].reduce((s, r) => s + (r.usd || 0), 0),
  };

  writeRaw(PROBE === "L3" ? "l3-openai-full" : "l2-openai-mini",
    { summary, conversations: finalConversations, barges: finalBarges, vad: finalVad });
  console.log(`\n  model_leg_ms p50 ${summary.model_leg_ms.p50} (n=${allLegs.length})   barge ${summary.barge.interrupted_count}/${finalBarges.length}`);
  if (summary.semantic_vad) console.log(`  V4 cells (low, no_terminal_punct + trailing_lead_in): waited ${summary.semantic_vad.v4.waited}/${summary.semantic_vad.v4.n}`);
  console.log(`  ${PROBE} cost $${summary.usd.toFixed(4)} — running total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`${PROBE} ABORTED: ${e.message}`); process.exit(1); });
