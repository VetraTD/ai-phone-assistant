// ---------------------------------------------------------------------------
// Round 2, OpenAI arms. Decides W4 and OpenAI's half of W5.
//
//   node scripts/probes/r2-openai-arms.mjs <arm>
//   arms: silence | longbarge | split | all
//
// `silence` exists because round 1's headline OpenAI number is not a property
// of the vendor. The harness set `silence_duration_ms: 500` on OpenAI and left
// Gemini's VAD at its default, then reported OpenAI as ~940 ms slower. Round 2
// has since measured that Gemini's endpointing on a complete utterance is only
// ~150 ms, so essentially the whole gap is this one setting. Sweeping it is the
// difference between a vendor comparison and a comparison of two config files.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { openSession, appendAudio, billableUsage } from "./lib/openai.js";
import { openaiFrames, paceFrames, silenceFrames, sleep } from "./lib/audio.js";
import { SYSTEM_PROMPT, OPENAI_TOOLS, CONVERSATION_TURNS, SLOPE_TURNS } from "./lib/prompt.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { p50, errorGuard, writeRaw, readRaw } from "./lib/stats.js";

const ARM = process.argv[2] || "all";
const MODEL = process.env.PROBE_MODEL || "gpt-realtime-2.1-mini";
const N = 5;
const EST = 0.06;

const serverVad = (ms) => ({
  type: "server_vad", threshold: 0.5, prefix_padding_ms: 300,
  silence_duration_ms: ms, create_response: true, interrupt_response: true,
});

const money = (n) => `$${n.toFixed(4)}`;
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(5); }
  return false;
};
function bill(arm, run, s) {
  const usage = billableUsage(s.state.usage);
  const c = price(MODEL, usage);
  commit({ probe: "R2", arm, run, model: MODEL, usage, usd: c.usd });
  return c.usd;
}
const armTurn = (st) => {
  st.firstAudioAt = null; st.lastAudioAt = null;
  st.responseCreatedAt = null; st.responseDoneAt = null;
  st.outputTranscript = ""; st.turnToolCalls = []; st.audioChunks = 0;
};

// ---------------------------------------------------------------------------
// ARM 1 — silence_duration_ms sweep on the real conversation script. W4.
// ---------------------------------------------------------------------------
async function silenceRun(ms, idx) {
  reserve(`R2 openai silence ${ms} ${idx + 1}`, EST);
  const s = await openSession({
    model: MODEL, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS, turnDetection: serverVad(ms),
  });
  const turns = [];
  try {
    await waitFor(() => s.state.sessionUpdated, 10000);
    for (const label of CONVERSATION_TURNS) {
      armTurn(s.state);
      const before = s.state.inputTranscript;
      await paceFrames(openaiFrames(label).frames, (f) => appendAudio(s.send, f));
      const tEnd = Date.now();
      await paceFrames(silenceFrames("ulaw8k", 6000), (f) => appendAudio(s.send, f), {
        stop: () => s.state.firstAudioAt !== null,
      });
      await waitFor(() => s.state.firstAudioAt !== null, 20000);
      // Drain fully, or this reply's tail lands in the next turn's window.
      await waitFor(() => s.state.lastAudioAt && Date.now() - s.state.lastAudioAt >= 800, 15000);
      turns.push({
        label,
        model_leg_ms: s.state.firstAudioAt ? s.state.firstAudioAt - tEnd : null,
        commit_ms: s.state.responseCreatedAt ? s.state.responseCreatedAt - tEnd : null,
        heard: s.state.inputTranscript.slice(before.length).trim(),
        tools: [...s.state.turnToolCalls],
      });
      await sleep(200);
    }
  } finally { s.close(); await sleep(250); }
  return { silence_ms: ms, run: idx + 1, turns, usd: bill(`silence:${ms}`, idx + 1, s), error: s.state.error };
}

// ---------------------------------------------------------------------------
// ARM 2 — barge-in against a LONG reply, matched to the Gemini arm. W5.
// ---------------------------------------------------------------------------
async function longBarge(idx) {
  reserve(`R2 openai longbarge ${idx + 1}`, EST);
  const s = await openSession({
    model: MODEL, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS, turnDetection: serverVad(500),
  });
  let row = { trial: idx + 1 };
  try {
    await waitFor(() => s.state.sessionUpdated, 10000);
    armTurn(s.state);
    // Same instruction the Gemini arm uses, so the two are comparable. Recorded
    // as a deviation: a real caller cannot make the model monologue on demand.
    s.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text:
        "Before we start, please read me your full list of opening hours for every day of the week, " +
        "one day at a time, slowly, and then describe the parking and directions in detail." }] },
    });
    s.send({ type: "response.create" });
    const speaking = await waitFor(() => s.state.firstAudioAt !== null, 20000);
    if (!speaking) { row = { ...row, barged: false, skip_reason: "model never spoke" }; }
    else {
      await sleep(1500);
      const inFlight = s.state.lastAudioAt && Date.now() - s.state.lastAudioAt < 600;
      const chunksBefore = s.state.audioChunks;
      const cancelledBefore = s.state.cancelled;
      let firstFrameAt = null;
      await paceFrames(openaiFrames("barge_in").frames, (f) => {
        if (firstFrameAt === null) firstFrameAt = Date.now();
        appendAudio(s.send, f);
      });
      const gotSpeech = await waitFor(() => s.state.speechStartedAt > firstFrameAt, 12000);
      const gotCancel = await waitFor(() => s.state.cancelled > cancelledBefore, 6000);
      const signalAt = s.state.speechStartedAt;
      const chunksAtSignal = s.state.audioChunks;
      await sleep(1200);
      row = {
        ...row, barged: true,
        audio_in_flight_at_barge: !!inFlight,
        chunks_before_barge: chunksBefore,
        interrupted: gotSpeech && gotCancel,
        speech_detected: gotSpeech, response_cancelled: gotCancel,
        barge_to_signal_ms: gotSpeech ? signalAt - firstFrameAt : null,
        audio_after_interrupt: gotSpeech && s.state.lastAudioAt > signalAt,
        chunks_after_interrupt: s.state.audioChunks - chunksAtSignal,
        ms_of_audio_after_interrupt: gotSpeech && s.state.lastAudioAt > signalAt ? s.state.lastAudioAt - signalAt : 0,
      };
    }
  } finally { s.close(); await sleep(250); }
  row.usd = bill("longbarge", idx + 1, s);
  return row;
}

// ---------------------------------------------------------------------------
// ARM 3 — a 12-turn call, matched to the Gemini slope arm. Measures DRIFT.
// The mini went 980 -> 2,748 ms across five turns and was still climbing; a real
// receptionist call is 10-15 turns, so this is where the product actually lives.
// ---------------------------------------------------------------------------
async function slope(idx) {
  reserve(`R3 openai slope ${idx + 1}`, EST * 3);
  const s = await openSession({
    model: MODEL, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS, turnDetection: serverVad(500),
  });
  const turns = [];
  try {
    await waitFor(() => s.state.sessionUpdated, 10000);
    for (const label of SLOPE_TURNS) {
      armTurn(s.state);
      await paceFrames(openaiFrames(label).frames, (f) => appendAudio(s.send, f));
      const tEnd = Date.now();
      await paceFrames(silenceFrames("ulaw8k", 6000), (f) => appendAudio(s.send, f), {
        stop: () => s.state.firstAudioAt !== null,
      });
      await waitFor(() => s.state.firstAudioAt !== null, 25000);
      await waitFor(() => s.state.lastAudioAt && Date.now() - s.state.lastAudioAt >= 800, 15000);
      turns.push({ label, model_leg_ms: s.state.firstAudioAt ? s.state.firstAudioAt - tEnd : null,
                   tools: [...s.state.turnToolCalls] });
      await sleep(200);
    }
  } finally { s.close(); await sleep(250); }
  return { run: idx + 1, turns, usd: bill("slope", idx + 1, s), error: s.state.error };
}

async function main() {
  console.log(`R2 OpenAI — ${MODEL}`);
  console.log(`arm: ${ARM}   spent $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);
  const guard = errorGuard(3);
  const out = readRaw(`r2-openai-${MODEL}`) || {};

  if (ARM === "silence" || ARM === "all") {
    const rows = [];
    for (const ms of [200, 300, 500]) {
      const cell = [];
      for (let i = 0; i < N; i++) {
        try { const r = await silenceRun(ms, i); guard.ok(); cell.push(r); }
        catch (e) {
          if (e.name === "BudgetExceeded" || e.name === "SocketErrorStreak") throw e;
          cell.push({ silence_ms: ms, run: i + 1, error: e.message?.slice(0, 120), turns: [] });
          guard.fail(e);
        }
      }
      rows.push(...cell);
      const legs = cell.flatMap((r) => (r.turns || []).map((t) => t.model_leg_ms)).filter((n) => n > 0);
      const commits = cell.flatMap((r) => (r.turns || []).map((t) => t.commit_ms)).filter((n) => n > 0);
      const miss = cell.flatMap((r) => (r.turns || []).map((t) => t.model_leg_ms)).filter((n) => n == null).length;
      console.log(`  silence ${String(ms).padStart(3)}ms  leg p50 ${String(p50(legs)).padStart(5)} ms   endpoint p50 ${String(p50(commits)).padStart(5)} ms   n=${legs.length}  missed=${miss}`);
    }
    out.silence = rows;
    console.log("");
  }

  if (ARM === "slope" || ARM === "all") {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      try { const r = await slope(i); guard.ok(); rows.push(r); }
      catch (e) {
        if (e.name === "BudgetExceeded" || e.name === "SocketErrorStreak") throw e;
        rows.push({ run: i + 1, error: e.message?.slice(0, 120), turns: [] }); guard.fail(e);
      }
    }
    out.slope = rows;
    for (const r of rows) if (r.turns?.length) console.log(`  slope ${r.run}: [${r.turns.map((t) => t.model_leg_ms ?? "MISS").join(", ")}]`);
    const f = rows.map((r) => (r.turns || [])[0]?.model_leg_ms).filter(Boolean);
    const l = rows.map((r) => (r.turns || [])[11]?.model_leg_ms).filter(Boolean);
    if (f.length && l.length) console.log(`  -> turn1 p50 ${p50(f)} ms  turn12 p50 ${p50(l)} ms  drift ${p50(l) - p50(f)} ms`);
    console.log("");
  }

  if (ARM === "longbarge" || ARM === "all") {
    const rows = [];
    for (let i = 0; i < N; i++) {
      try { const r = await longBarge(i); guard.ok(); rows.push(r); }
      catch (e) {
        if (e.name === "BudgetExceeded" || e.name === "SocketErrorStreak") throw e;
        rows.push({ trial: i + 1, error: e.message?.slice(0, 120) }); guard.fail(e);
      }
    }
    out.longbarge = rows;
    for (const r of rows) if (r.barged) {
      console.log(`  longbarge ${r.trial}: in_flight=${r.audio_in_flight_at_barge} signal@${r.barge_to_signal_ms}ms cancelled=${r.response_cancelled}  audio_after=${r.audio_after_interrupt} (+${r.chunks_after_interrupt} chunks, ${r.ms_of_audio_after_interrupt}ms)`);
    }
    console.log("");
  }

  out.meta = { model: MODEL, n: N, at: new Date().toISOString() };
  writeRaw(`r2-openai-${MODEL}`, out);
  console.log(`  running total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`R2 openai ABORTED: ${e.message}`); process.exit(1); });
