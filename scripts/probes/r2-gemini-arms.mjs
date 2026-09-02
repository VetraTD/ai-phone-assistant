// ---------------------------------------------------------------------------
// Round 2, Gemini arms. Decides W1, W2, W3, W7 and half of W5.
//
//   node scripts/probes/r2-gemini-arms.mjs <arm>
//   arms: conversation | endpointing | split | longbarge | all
//
// Everything runs on `gemini-live-2.5-flash-native-audio` / Vertex /
// europe-west1 — the ONLY production-viable Gemini candidate, per phase-A
// discovery. Round 1's headline Gemini numbers came from a preview model on the
// AI Studio API-key surface, which is neither a residency nor a BAA path, so
// they describe a configuration this estate cannot deploy.
// ---------------------------------------------------------------------------
import "dotenv/config";
import {
  openSession, sendAudio, armTurn, waitFor, waitForQuiet, setupOk, sleep,
  VERTEX_MODEL, VERTEX_LOCATION,
} from "./lib/geminiSession.js";
import { geminiFrames, paceFrames, silenceFrames } from "./lib/audio.js";
import { CONVERSATION_TURNS } from "./lib/prompt.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { p50, p95, errorGuard, writeRaw, readRaw } from "./lib/stats.js";

const ARM = process.argv[2] || "all";
const N = 5;
const EST = 0.05;

/** classifyHold's own charge per rule — the same windows round 1 used for OpenAI. */
const PAUSE_WINDOW_MS = { no_terminal_punct: 1500, trailing_lead_in: 2000, partial_digits: 1500 };

/**
 * Three VAD arms chosen to mirror OpenAI's eagerness low/medium/high, so the
 * two vendors are asked the same question rather than compared on whatever
 * each happened to default to.
 *   patient  ~ eagerness low
 *   default  ~ what every round-1 Gemini number was measured with
 *   eager    ~ eagerness high
 */
const VAD_ARMS = {
  patient: { endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 1200 },
  default: null,
  eager:   { endOfSpeechSensitivity: "END_SENSITIVITY_HIGH", silenceDurationMs: 300 },
};

const money = (n) => `$${n.toFixed(4)}`;
const bill = (probe, arm, run, usage) => {
  const c = price(VERTEX_MODEL, usage);
  commit({ probe, arm, run, model: VERTEX_MODEL, location: VERTEX_LOCATION, usage, usd: c.usd });
  return c.usd;
};

// ---------------------------------------------------------------------------
// ARM 1 — the same 5-turn script L1/L2 ran, so cost and latency are directly
// comparable. L5 ran only 4 turns and omitted the end_call turn, which makes
// its per-turn cost a slightly different measurement. W7.
// ---------------------------------------------------------------------------
async function conversation(idx) {
  reserve(`R2 gemini conv ${idx + 1}`, EST);
  const { session, state } = await openSession({ surface: "vertex" });
  const turns = [];
  try {
    await setupOk(state);
    for (const label of CONVERSATION_TURNS) {
      armTurn(state);
      const before = state.inputTranscript;
      const fx = geminiFrames(label);
      await paceFrames(fx.frames, (f) => sendAudio(session, f));
      const tEnd = Date.now();
      await paceFrames(silenceFrames("pcm16k", 4000), (f) => sendAudio(session, f), {
        stop: () => state.firstAudioAt !== null,
      });
      await waitFor(() => state.firstAudioAt !== null, 20000);
      await waitForQuiet(state);
      turns.push({
        label, model_leg_ms: state.firstAudioAt ? state.firstAudioAt - tEnd : null,
        heard: state.inputTranscript.slice(before.length).trim(),
        said: state.outputTranscript.trim().slice(0, 200),
        tools: [...state.turnToolCalls], audio_bytes: state.audioBytes,
      });
      await sleep(250);
    }
  } finally { try { session.close(); } catch {} await sleep(300); }
  const usd = bill("R2", "conversation", idx + 1, state.usage);
  return { run: idx + 1, turns, usage: state.usage, usd, error: state.error };
}

// ---------------------------------------------------------------------------
// ARM 2 — endpointing. The arm round 1 ran against OpenAI and never against
// Gemini, which is the single biggest asymmetry in the round-1 recommendation.
// W1, W2.
// ---------------------------------------------------------------------------
async function endpointing(armName, label, idx) {
  reserve(`R2 gemini vad ${armName}/${label} ${idx + 1}`, EST);
  const { session, state } = await openSession({
    surface: "vertex",
    automaticActivityDetection: VAD_ARMS[armName] || undefined,
  });
  const windowMs = PAUSE_WINDOW_MS[label];
  let row = { arm: armName, label, trial: idx + 1, window_ms: windowMs };
  try {
    await setupOk(state);
    armTurn(state);
    await paceFrames(geminiFrames(label).frames, (f) => sendAudio(session, f));
    const tEnd = Date.now();
    // Hold the pause open with real silence for exactly as long as our own
    // classifyHold rule would have waited, then see what the vendor did.
    await paceFrames(silenceFrames("pcm16k", windowMs), (f) => sendAudio(session, f));
    row = {
      ...row,
      cut_in: state.firstAudioAt !== null && state.firstAudioAt - tEnd < windowMs,
      first_audio_ms: state.firstAudioAt ? state.firstAudioAt - tEnd : null,
      heard: state.inputTranscript.trim(),
      said: state.outputTranscript.trim().slice(0, 140),
    };
  } finally { try { session.close(); } catch {} await sleep(200); }
  row.usd = bill("R2", `vad:${armName}:${label}`, idx + 1, state.usage);
  return row;
}

// ---------------------------------------------------------------------------
// ARM 3 — pure generation, with automatic VAD DISABLED.
//
// This is the only clean way to separate "the model thinks fast" from "the
// vendor waits a long time before deciding the caller stopped". We send the
// utterance, then an explicit activityEnd, and time from that signal. No VAD
// wait is inside the number. W3.
// ---------------------------------------------------------------------------
async function generationSplit(idx) {
  reserve(`R2 gemini split ${idx + 1}`, EST);
  const { session, state } = await openSession({
    surface: "vertex",
    automaticActivityDetection: { disabled: true },
  });
  let row = { trial: idx + 1 };
  try {
    await setupOk(state);
    armTurn(state);
    session.sendRealtimeInput({ activityStart: {} });
    await paceFrames(geminiFrames("clean_open").frames, (f) => sendAudio(session, f));
    session.sendRealtimeInput({ activityEnd: {} });
    const tEnd = Date.now();
    await waitFor(() => state.firstAudioAt !== null, 20000);
    row = {
      ...row,
      generation_ms: state.firstAudioAt ? state.firstAudioAt - tEnd : null,
      tools: [...state.turnToolCalls],
      heard: state.inputTranscript.trim(),
      said: state.outputTranscript.trim().slice(0, 140),
    };
    await waitForQuiet(state, { maxMs: 8000 });
  } finally { try { session.close(); } catch {} await sleep(250); }
  row.usd = bill("R2", "split", idx + 1, state.usage);
  return row;
}

// ---------------------------------------------------------------------------
// ARM 4 — barge-in against a LONG reply.
//
// Round 1's replies were 2-3 s and had usually finished streaming before the
// interrupt mattered, so V2/V3 measured signal timing and not much else. Here
// the model is asked for a long answer first, so there is guaranteed audio in
// flight when the caller talks over it. W5, and the real test of what
// turnManager still has to own.
// ---------------------------------------------------------------------------
async function longBarge(idx) {
  reserve(`R2 gemini longbarge ${idx + 1}`, EST);
  const { session, state } = await openSession({ surface: "vertex" });
  let row = { trial: idx + 1 };
  try {
    await setupOk(state);
    armTurn(state);
    // Force a long reply. The prompt caps replies at 1-2 sentences, so this is
    // an explicit instruction rather than a fixture, and it is recorded as a
    // deviation: a real caller cannot make the model monologue on demand.
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text:
        "Before we start, please read me your full list of opening hours for every day of the week, " +
        "one day at a time, slowly, and then describe the parking and directions in detail." }] }],
      turnComplete: true,
    });
    const speaking = await waitFor(() => state.firstAudioAt !== null, 20000);
    if (!speaking) { row = { ...row, barged: false, skip_reason: "model never spoke" }; }
    else {
      // Let it get properly going, then talk over it.
      await sleep(1500);
      const chunksBefore = state.audioChunks;
      const stillFlowing = state.lastAudioAt && Date.now() - state.lastAudioAt < 600;
      state.interruptedAt = null;
      let firstFrameAt = null;
      await paceFrames(geminiFrames("barge_in").frames, (f) => {
        if (firstFrameAt === null) firstFrameAt = Date.now();
        sendAudio(session, f);
      });
      const gotInt = await waitFor(() => state.interruptedAt !== null, 12000);
      const lastAtInterrupt = state.lastAudioAt;
      const chunksAtInterrupt = state.audioChunks;
      await sleep(1200);
      row = {
        ...row, barged: true,
        audio_in_flight_at_barge: !!stillFlowing,
        chunks_before_barge: chunksBefore,
        interrupted: gotInt,
        barge_to_interrupted_ms: gotInt ? state.interruptedAt - firstFrameAt : null,
        // The number that decides turnManager: did audio keep arriving AFTER
        // the vendor told us it had been interrupted?
        audio_after_interrupt: gotInt && state.lastAudioAt > state.interruptedAt,
        chunks_after_interrupt: state.audioChunks - chunksAtInterrupt,
        ms_of_audio_after_interrupt: gotInt && state.lastAudioAt > state.interruptedAt
          ? state.lastAudioAt - state.interruptedAt : 0,
        audio_arrived_after_settle: state.lastAudioAt !== lastAtInterrupt,
      };
    }
  } finally { try { session.close(); } catch {} await sleep(300); }
  row.usd = bill("R2", "longbarge", idx + 1, state.usage);
  return row;
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`R2 Gemini — ${VERTEX_MODEL} @ vertex/${VERTEX_LOCATION}`);
  console.log(`arm: ${ARM}   spent $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);
  const guard = errorGuard(3);
  const prior = readRaw("r2-gemini") || {};
  const out = { ...prior };

  const run = async (name, fn, list) => {
    const rows = [];
    for (const args of list) {
      try { const r = await fn(...args); guard.ok(); rows.push(r); }
      catch (e) {
        if (e.name === "BudgetExceeded" || e.name === "SocketErrorStreak") throw e;
        console.log(`    ${name} failed: ${e.message?.slice(0, 120)}`);
        rows.push({ error: e.message }); guard.fail(e);
      }
    }
    return rows;
  };

  if (ARM === "conversation" || ARM === "all") {
    const rows = await run("conv", conversation, Array.from({ length: N }, (_, i) => [i]));
    out.conversations = rows;
    for (const r of rows) if (r.turns) console.log(`  conv ${r.run}: [${r.turns.map((t) => t.model_leg_ms ?? "MISS").join(", ")}] ${money(r.usd)}`);
    const legs = rows.flatMap((r) => (r.turns || []).map((t) => t.model_leg_ms)).filter((n) => n > 0);
    const perTurn = rows.filter((r) => r.usd).reduce((s, r) => s + r.usd, 0) / (rows.filter((r) => r.usd).length * 5);
    console.log(`  -> leg p50 ${p50(legs)} ms (n=${legs.length})   $/turn ${money(perTurn)}\n`);
  }

  if (ARM === "endpointing" || ARM === "all") {
    const rows = [];
    for (const armName of ["patient", "default", "eager"]) {
      for (const label of Object.keys(PAUSE_WINDOW_MS)) {
        const cell = await run("vad", endpointing, Array.from({ length: N }, (_, i) => [armName, label, i]));
        rows.push(...cell);
        const valid = cell.filter((r) => !r.error);
        const cut = valid.filter((r) => r.cut_in).length;
        console.log(`  vad ${armName.padEnd(7)} ${label.padEnd(18)} cut-in ${cut}/${valid.length}  waited ${valid.length - cut}/${valid.length}  (window ${PAUSE_WINDOW_MS[label]}ms)`);
      }
    }
    out.endpointing = rows;
    console.log("");
  }

  if (ARM === "split" || ARM === "all") {
    const rows = await run("split", generationSplit, Array.from({ length: N }, (_, i) => [i]));
    out.split = rows;
    const g = rows.map((r) => r.generation_ms).filter((n) => n > 0);
    console.log(`  generation-only (manual activityEnd): [${g.join(", ")}]  p50 ${p50(g)} ms\n`);
  }

  if (ARM === "longbarge" || ARM === "all") {
    const rows = await run("longbarge", longBarge, Array.from({ length: N }, (_, i) => [i]));
    out.longbarge = rows;
    for (const r of rows) if (r.barged) {
      console.log(`  longbarge ${r.trial}: in_flight=${r.audio_in_flight_at_barge} interrupted=${r.interrupted}@${r.barge_to_interrupted_ms}ms  audio_after=${r.audio_after_interrupt} (+${r.chunks_after_interrupt} chunks, ${r.ms_of_audio_after_interrupt}ms)`);
    }
    console.log("");
  }

  out.meta = { model: VERTEX_MODEL, surface: "vertex", location: VERTEX_LOCATION, n: N, at: new Date().toISOString() };
  writeRaw("r2-gemini", out);
  console.log(`  running total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`R2 gemini ABORTED: ${e.message}`); process.exit(1); });
