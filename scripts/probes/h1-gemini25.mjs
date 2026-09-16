// ---------------------------------------------------------------------------
// H1/H2/H3 -- Gemini 2.5 native audio on Vertex europe-west1.
//
// The comparison that has never been run. Round 3 dropped 2.5 because "it lost
// its only advantage when BAA became unaffordable", and the quality finding
// against it came from the SIX-tool harness that report-r3.md itself calls "not
// trustworthy". The owner made UK/EU residency hard on 2026-09-14, which
// restores the exact advantage that was written off.
//
//   H1  the trail-off. 3.1 fails it 3 of 5 at its most patient setting and no
//       setting fixes it. Round 2 says 2.5 held 5/5 -- on the broken harness.
//   H2  turn-2 survival in the EU. Public reports say the only EU-reachable
//       native-audio model "breaks on turn 2". Unreproduced is not measured.
//   H3  does it check the diary, on the corrected 11-tool set. report-r3.md
//       calls this the highest-value outstanding test.
//
// DETECTION DIFFERS FROM G3 ON PURPOSE. GPT-Live streams continuously and pads
// with silence, so arrival of audio is not speech and G3 had to use RMS energy.
// Gemini is turn-based and sends audio only while speaking. This run RECORDS
// inter-chunk gaps to prove that rather than assuming it -- if the gaps show a
// continuous stream, these numbers are void and must be re-scored by energy.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import {
  openSession, sendAudio, armTurn, waitForQuiet, setupOk,
  VERTEX_PROJECT, VERTEX_LOCATION,
} from "./lib/geminiSession.js";
import { geminiFrames, FRAME_BYTES, paceFrames, silenceFrames, ulawToPcm16k, loadUlaw } from "./lib/audio.js";
import { TOOL_NAMES } from "./lib/prompt.js";
import { commit, priceTokens, summary, reserve } from "./lib/spendLive.js";

const MODEL = "gemini-live-2.5-flash-native-audio";
const TRAIL_FIXTURES = ["no_terminal_punct", "trailing_lead_in"];
const N_TRAIL = Number(process.env.H_N || 5);
const N_MULTI = Number(process.env.H_MULTI || 5);
const MULTI_TURNS = ["clean_open", "rep_time_q", "rep_confirm", "rep_close"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PCM16 16k frames, which is the only input format Gemini Live accepts. */
function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

function priceSession(state) {
  const u = state.usage || {};
  const usage = {
    audio_in: u.audio_in || u.promptAudio || 0,
    audio_out: u.audio_out || u.responseAudio || 0,
    text_in: u.text_in || u.promptText || 0,
    text_out: u.text_out || u.responseText || 0,
  };
  return { usage, priced: priceTokens(MODEL, usage) };
}

function chunkGaps(state) {
  const log = state.audioChunkLog || [];
  const gaps = [];
  for (let i = 1; i < log.length; i++) gaps.push(log[i].at - log[i - 1].at);
  return gaps;
}

// --- H1: the trail-off -------------------------------------------------------

async function trailTake(fx, i) {
  reserve(`H1/${fx}-${i}`, 60, 0.05);
  const t0 = Date.now();
  let ctx = null;
  const row = { arm: "H1", fixture: fx, take: i };

  try {
    ctx = await openSession({ surface: "vertex", model: MODEL });
    const ok = await setupOk(ctx.state);
    row.connect_ms = Date.now() - t0;
    if (!ok) { row.error = "setupComplete never arrived"; return row; }

    const st = ctx.state;
    armTurn(st);
    const frames = pcmFrames(fx);
    await paceFrames(frames, (f) => sendAudio(ctx.session, f));
    const speechEndAt = Date.now();

    // Audio that arrived WHILE the caller was still speaking is a cut-in here,
    // because this stream is turn-based. The gap log below proves that.
    const during = (st.audioChunkLog || []).filter((c) => c.at < speechEndAt);
    row.chunks_during_caller_speech = during.length;
    row.bytes_during_caller_speech = during.reduce((a, b) => a + b.bytes, 0);
    row.interrupted_during = Boolean(st.interruptedAt && st.interruptedAt < speechEndAt);

    // Keep feeding silence: a stream that stops is a stall, not a pause.
    await paceFrames(silenceFrames("pcm16k", 4000), (f) => sendAudio(ctx.session, f));
    await waitForQuiet(st, { quietMs: 900, maxMs: 12000 });

    row.held = during.length === 0;
    row.turn_latency_ms = st.firstAudioAt ? st.firstAudioAt - speechEndAt : null;
    row.caller_text = st.inputTranscript;
    row.model_text = st.outputTranscript;
    row.tools = st.turnToolCalls;
    row.chunk_gaps_ms = chunkGaps(st);
    row.audio_chunks = st.audioChunks;
  } catch (err) {
    row.error = err.message;
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const { usage, priced } = priceSession(ctx?.state || {});
  row.usd = Number(priced.usd.toFixed(5));
  row.usage = usage;
  commit({ probe: "H1", arm: row.fixture, label: `${fx}-${i}`, model: MODEL, usd: priced.usd, note: row.error });

  console.log(
    `  ${fx.padEnd(18)} take ${i}  ${row.held ? "HELD    " : "CUT IN  "}` +
    `${row.chunks_during_caller_speech ? `${row.chunks_during_caller_speech} chunks during speech` : "silent while caller spoke"}` +
    `  connect ${row.connect_ms}ms  $${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`
  );
  return row;
}

// --- H2/H3: multi-turn survival and the diary check --------------------------

async function multiTake(i) {
  reserve(`H2/${i}`, 120, 0.1);
  const t0 = Date.now();
  let ctx = null;
  const row = { arm: "H2", take: i, turns: [] };

  try {
    ctx = await openSession({ surface: "vertex", model: MODEL });
    const ok = await setupOk(ctx.state);
    row.connect_ms = Date.now() - t0;
    if (!ok) { row.error = "setupComplete never arrived"; return row; }
    const st = ctx.state;

    for (let t = 0; t < MULTI_TURNS.length; t++) {
      armTurn(st);
      const label = MULTI_TURNS[t];
      await paceFrames(pcmFrames(label), (f) => sendAudio(ctx.session, f));
      const speechEndAt = Date.now();
      await paceFrames(silenceFrames("pcm16k", 3000), (f) => sendAudio(ctx.session, f));
      const gotAudio = await waitForQuiet(st, { quietMs: 900, maxMs: 15000 });

      row.turns.push({
        n: t + 1,
        fixture: label,
        got_audio: st.audioChunks > 0,
        audio_chunks: st.audioChunks,
        latency_ms: st.firstAudioAt ? st.firstAudioAt - speechEndAt : null,
        caller_text: st.inputTranscript,
        model_text: st.outputTranscript,
        tools: [...st.turnToolCalls],
        quiet_reached: gotAudio,
      });
      await sleep(300);
    }

    row.all_turns_answered = row.turns.every((t) => t.got_audio);
    row.first_dead_turn = row.turns.find((t) => !t.got_audio)?.n ?? null;
    row.availability_checked = row.turns.some((t) => t.tools.includes("check_appointment_availability"));
    row.all_tools = row.turns.flatMap((t) => t.tools);
  } catch (err) {
    row.error = err.message;
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const { usage, priced } = priceSession(ctx?.state || {});
  row.usd = Number(priced.usd.toFixed(5));
  row.usage = usage;
  commit({ probe: "H2", arm: "multi", label: `multi-${i}`, model: MODEL, usd: priced.usd, note: row.error });

  const dead = row.first_dead_turn;
  console.log(
    `  multi take ${i}  turns answered ${row.turns.filter((t) => t.got_audio).length}/${row.turns.length}` +
    `${dead ? `  DIED AT TURN ${dead}` : ""}  availability ${row.availability_checked ? "YES" : "no"}` +
    `  $${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`
  );
  return row;
}

async function main() {
  console.log(`Gemini 2.5 native audio -- ${VERTEX_PROJECT} / ${VERTEX_LOCATION}`);
  console.log(`tools declared: ${TOOL_NAMES.length} (${TOOL_NAMES.includes("check_appointment_availability") ? "includes availability" : "MISSING AVAILABILITY"})`);
  console.log(`budget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  console.log("H1 -- the trail-off");
  const trail = [];
  for (const fx of TRAIL_FIXTURES) {
    for (let i = 1; i <= N_TRAIL; i++) trail.push(await trailTake(fx, i));
  }

  console.log("\nH2/H3 -- multi-turn survival in the EU, and the diary check");
  const multi = [];
  for (let i = 1; i <= N_MULTI; i++) multi.push(await multiTake(i));

  // --- scoring, against the pre-registration ---
  const byFixture = {};
  for (const fx of TRAIL_FIXTURES) {
    const rs = trail.filter((r) => r.fixture === fx && !r.error);
    const cutIns = rs.filter((r) => !r.held).length;
    byFixture[fx] = {
      held: rs.filter((r) => r.held).length, cut_ins: cutIns, of: rs.length,
      pass: cutIns < 2, prediction_held: cutIns === 0,
    };
  }
  const h1pass = Object.values(byFixture).every((b) => b.pass);

  const okMulti = multi.filter((r) => !r.error);
  const died = okMulti.filter((r) => r.first_dead_turn !== null);
  const h2pass = died.length < 2;
  const availChecked = okMulti.filter((r) => r.availability_checked).length;
  const h3pass = availChecked >= 3;

  const allGaps = trail.flatMap((r) => r.chunk_gaps_ms || []);
  const bigGaps = allGaps.filter((g) => g > 400).length;

  const out = {
    at: new Date().toISOString(),
    model: MODEL, project: VERTEX_PROJECT, location: VERTEX_LOCATION,
    tools_declared: TOOL_NAMES.length,
    stream_shape: {
      inter_chunk_gaps_over_400ms: bigGaps,
      total_gaps: allGaps.length,
      verdict: bigGaps > 0
        ? "turn-based: the stream has real gaps, so arrival of audio IS speech and arrival-based detection is valid"
        : "CONTINUOUS: arrival-based detection is VOID and these numbers must be re-scored by energy, as G3 had to be",
    },
    H1: { prediction: "holds 5 of 5 on both fixtures", fails_if: "2+ cut in on either", byFixture, pass: h1pass },
    H2: {
      prediction: "turn 2 works; the public report does not reproduce",
      fails_if: "2+ of 5 sessions produce no audio for turn 2 or later",
      sessions: okMulti.length, died: died.length,
      dead_turns: died.map((r) => ({ take: r.take, first_dead_turn: r.first_dead_turn })),
      pass: h2pass,
    },
    H3: {
      prediction: "calls check_appointment_availability in 4 of 5 or better",
      fails_if: "fewer than 3 of 5",
      checked: availChecked, of: okMulti.length, pass: h3pass,
      gemini_3_1_baseline: "20 of 20", gpt_live_baseline: "7 of 10",
    },
    trail, multi, spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-gemini25.json", JSON.stringify(out, null, 2) + "\n");

  console.log("\n--- stream shape ---");
  console.log(`  ${out.stream_shape.verdict}`);
  console.log(`  gaps over 400ms: ${bigGaps} of ${allGaps.length}`);
  console.log("\n--- verdicts ---");
  for (const [fx, b] of Object.entries(byFixture)) {
    console.log(`H1 ${fx}: held ${b.held}/${b.of}, cut in ${b.cut_ins} -> ${b.pass ? "PASS" : "FAIL"} (predicted 0 cut-ins: ${b.prediction_held ? "HELD" : "MISSED"})`);
  }
  console.log(`H2 turn-2 survival: ${died.length} of ${okMulti.length} sessions died -> ${h2pass ? "PASS" : "FAIL -- 2.5 IS DISQUALIFIED"}`);
  console.log(`H3 diary checked: ${availChecked} of ${okMulti.length} -> ${h3pass ? "PASS" : "FAIL"} (3.1 was 20/20, GPT-Live 7/10)`);
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main();
