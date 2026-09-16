// ---------------------------------------------------------------------------
// T2 -- tool-loop health on gemini-3.8-live.
//
// THE PRODUCTION DEFECT THIS IS ABOUT. A live call produced "five tool rounds
// in 800 ms, then the same sentence nine times." The mechanism is at
// lib/voice/live/index.js:3764:
//
//     if (sc.generationComplete || sc.turnComplete) {
//       ...
//       if (!sc.turnComplete) return;      // everything below needs turnComplete
//
// and `toolRoundsThisTurn = 0` lives BELOW that line. A model that does not
// emit turnComplete on a tool turn therefore never resets the round counter,
// never closes the turn, and re-offers until the cap trips.
//
// An earlier probe (turnend-events.mjs) asked this of 2.5 and 3.1 at N=1 each
// and printed "NOT the cause -- both emit turnComplete", so the production loop
// is still unexplained. But its raw data carried a second finding it did not
// print: 2.5 fired THREE separate toolCall rounds for check_appointment_
// availability in ~700 ms, each closing its own turn, against 3.1's single
// batched round. Re-firing a tool is not the same defect as a missing
// turnComplete and it is at least as expensive.
//
// PRE-REGISTERED PREDICTION (verdicts-g38.json T2): turnComplete present 5/5,
// but the same tool RE-FIRED inside one caller turn in 2 or more of 5. The M38
// pilot already showed check_avail -> set_call_intent -> check_avail in a single
// take with a 4,475 ms turn against ~1,050 ms on clean ones. I expect 3.8 to
// behave like 2.5 here, and I expect this to be the defect 3.8 carries.
//
// FAIL CONDITION: turnComplete ABSENT after a tool call in 2 or more of 5.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import {
  openSession, sendAudio, armTurn, waitForQuiet, setupOk, sleep,
} from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { commit, priceTokens, priceGeminiByMinutes, summary, reserve } from "./lib/spendLive.js";

const MODEL = process.env.M38 || "gemini-3.8-live";
const SURFACE = "aistudio";
const N = Number(process.env.T2_N || 5);

// A turn that RELIABLY forces a tool call. rep_time_q asks about a specific
// morning, which is what check_appointment_availability exists for.
const TURNS = ["clean_open", "rep_time_q"];

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

async function take(i) {
  reserve(`T2/${i}`, 90, 0.03);
  let ctx = null;
  const row = { take: i, turns: [] };
  const startedAt = Date.now();
  try {
    ctx = await openSession({ surface: SURFACE, model: MODEL, answerTools: true });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;
    row.connect_ms = Date.now() - startedAt;

    for (const fixture of TURNS) {
      const evStart = st.events.length;
      armTurn(st);
      await paceFrames(pcmFrames(fixture), (f) => sendAudio(ctx.session, f));
      await paceFrames(silenceFrames("pcm16k", 2500), (f) => sendAudio(ctx.session, f));
      await waitForQuiet(st, { quietMs: 900, maxMs: 14000 });
      // A tool turn can keep going after the audio goes quiet -- give the loop
      // room to re-fire if it is going to, or the re-fire count is an artefact
      // of when we stopped looking.
      await sleep(1500);

      const ev = st.events.slice(evStart);
      const toolEvents = ev.filter((e) => e.t === "toolCall");
      const names = toolEvents.flatMap((e) => e.names || []);
      const counts = {};
      for (const n of names) counts[n] = (counts[n] || 0) + 1;

      const firstTool = ev.find((e) => e.t === "toolCall");
      const tcAfterTool = firstTool ? ev.find((e) => e.t === "turnComplete" && e.at >= firstTool.at) : null;

      row.turns.push({
        fixture,
        tool_rounds: toolEvents.length,
        tool_names: toolEvents.map((e) => e.names),
        tool_counts: counts,
        // A round carrying >1 tool is BATCHING (3.1's shape). Several rounds
        // each carrying one tool is SPLITTING (2.5's shape).
        batched: toolEvents.some((e) => (e.names || []).length > 1),
        refired: Object.values(counts).some((c) => c > 1),
        max_same_tool: Math.max(0, ...Object.values(counts)),
        turn_completes: ev.filter((e) => e.t === "turnComplete").length,
        turn_complete_after_tool_ms: tcAfterTool && firstTool ? tcAfterTool.at - firstTool.at : null,
        had_tool: toolEvents.length > 0,
        transcript: st.outputTranscript.slice(0, 260),
        event_order: ev.map((e) => e.t).join(">"),
      });
    }
    row.tool_turns = row.turns.filter((t) => t.had_tool);
  } catch (e) {
    row.error = e.message;
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const u = ctx?.state?.usage || {};
  row.usage = { ...u };
  let priced = priceTokens(MODEL, {
    audio_in: u.audio_in || 0, audio_out: u.audio_out || 0,
    text_in: u.text_in || 0, text_out: u.text_out || 0,
  });
  if (!(priced.usd > 0)) {
    priced = priceGeminiByMinutes({
      inSeconds: (Date.now() - startedAt) / 1000,
      outSeconds: (ctx?.state?.audioBytes || 0) / (24000 * 2),
    });
    row.usd_estimated = true;
  }
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "T2", arm: MODEL, label: `t2-${i}`, model: MODEL, usd: priced.usd, estimated: !!row.usd_estimated, note: row.error });

  const tt = (row.tool_turns || []);
  console.log(
    `  take ${i}  ` +
    `toolTurns ${tt.length}  ` +
    `rounds ${tt.map((t) => t.tool_rounds).join("/") || "-"}  ` +
    `${tt.some((t) => t.refired) ? "RE-FIRED x" + Math.max(0, ...tt.map((t) => t.max_same_tool)) : "no re-fire"}  ` +
    `${tt.some((t) => t.batched) ? "batched" : "split  "}  ` +
    `tcAfterTool ${tt.map((t) => t.turn_complete_after_tool_ms ?? "NONE").join("/") || "-"}  ` +
    `$${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`
  );
  for (const t of tt) console.log(`      ${t.fixture}: ${t.event_order}   ${JSON.stringify(t.tool_counts)}`);
  return row;
}

async function main() {
  console.log(`T2 -- tool-loop health.  ${MODEL} @ ${SURFACE}`);
  console.log(`budget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const out = { at: new Date().toISOString(), model: MODEL, surface: SURFACE, n: N, turns: TURNS, rows: [] };
  for (let i = 1; i <= N; i++) out.rows.push(await take(i));

  const good = out.rows.filter((r) => !r.error);
  const toolTurns = good.flatMap((r) => r.tool_turns || []);
  const missingTc = toolTurns.filter((t) => t.turn_complete_after_tool_ms === null);
  const refired = good.filter((r) => (r.tool_turns || []).some((t) => t.refired));
  const batched = good.filter((r) => (r.tool_turns || []).some((t) => t.batched));
  const noTool = good.filter((r) => (r.tool_turns || []).length === 0);

  out.tally = {
    takes: good.length,
    errored: out.rows.length - good.length,
    takes_with_no_tool_call_at_all: noTool.length,
    tool_turns_seen: toolTurns.length,
    tool_turns_missing_turnComplete: missingTc.length,
    takes_that_refired_a_tool: refired.length,
    worst_same_tool_count: Math.max(0, ...toolTurns.map((t) => t.max_same_tool)),
    takes_that_batched: batched.length,
    median_turnComplete_after_tool_ms:
      toolTurns.map((t) => t.turn_complete_after_tool_ms).filter((x) => x != null).sort((a, b) => a - b)[
        Math.floor(toolTurns.filter((t) => t.turn_complete_after_tool_ms != null).length / 2)
      ] ?? null,
  };

  out.verdict = {
    predicted: "turnComplete present 5/5; the same tool re-fired inside one caller turn in 2 or more of 5",
    measured_turnComplete: `${toolTurns.length - missingTc.length} of ${toolTurns.length} tool turns closed with turnComplete`,
    measured_refire: `${refired.length} of ${good.length} takes re-fired a tool (worst: same tool x${out.tally.worst_same_tool_count})`,
    // PRE-REGISTERED FAIL CONDITION
    fails: missingTc.length >= 2,
    prediction_held_refire: refired.length >= 2,
    baselines: {
      "gemini-live-2.5-flash-native-audio": "turnComplete 914ms after toolCall; fired check_appointment_availability 3x in ~700ms, splitting",
      "gemini-3.1-flash-live-preview": "turnComplete 6,750ms after toolCall; batched set_call_intent + check_avail in ONE round",
      "gpt-live-1": "no turnComplete event exists at all -- boundaries must be reconstructed",
    },
  };

  fs.writeFileSync("scripts/probes/results-t2.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\n--- T2 ---`);
  console.log(`  tool turns seen                 ${out.tally.tool_turns_seen}`);
  console.log(`  missing turnComplete            ${out.tally.tool_turns_missing_turnComplete}   ${out.verdict.fails ? "*** FAILS ***" : "pass"}`);
  console.log(`  takes that re-fired a tool      ${out.tally.takes_that_refired_a_tool}/${good.length}   (predicted 2+, ${out.verdict.prediction_held_refire ? "PREDICTION HELD" : "prediction wrong"})`);
  console.log(`  worst same-tool count in a turn ${out.tally.worst_same_tool_count}`);
  console.log(`  takes that batched              ${out.tally.takes_that_batched}/${good.length}`);
  console.log(`  median turnComplete after tool  ${out.tally.median_turnComplete_after_tool_ms}ms`);
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
