// ---------------------------------------------------------------------------
// G2 -- are caller transcripts gateable?
//
// THE GATE THAT CAN END THE ROUND. Every write guarantee we own -- the consent
// latch, the affirmative check, isUnusableTranscript, the write-order gate --
// fires on a COMPLETED CALLER TURN. OpenAI's own SDK docstring says the input
// transcript events "do not define complete turns or include a transcript-done
// event". So caller text exists and caller turns do not, and this measures
// whether we can rebuild them from timestamps well enough to authorise a write.
//
// G2a: word error rate against GROUND_TRUTH.
// G2b: turn segmentation from start_ms/end_ms gaps alone.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { inputText, segmentTurns } from "./lib/gptlive.js";
import { GROUND_TRUTH } from "./lib/audio.js";
import { FRONTEND_INSTRUCTIONS } from "./lib/livePrompt.js";
import { runSession } from "./lib/liveRun.js";
import { wer, median } from "./lib/score.js";
import { summary } from "./lib/spendLive.js";

const FIXTURES = [
  "clean_open", "trailing_lead_in", "no_terminal_punct", "name_spelling",
  "rep_time_q", "rep_confirm", "rep_digits", "rep_close", "barge_in", "partial_digits",
];

/** Pre-registered in verdicts-gptlive.json. One utterance in, one turn expected out. */
const EXPECTED_TURNS = Object.fromEntries(FIXTURES.map((f) => [f, 1]));

const GAP_MS = 500;

async function main() {
  console.log("G2 -- caller transcripts. The gate that can end the round.\n");
  const rows = [];

  for (const fx of FIXTURES) {
    const { state, marks, priced } = await runSession({
      label: `g2-${fx}`,
      probe: "G2",
      fixtures: [fx],
      instructions: FRONTEND_INSTRUCTIONS,
      tailMs: 4000,
      maxSeconds: 30,
    });

    const heard = inputText(state);
    const truth = GROUND_TRUTH[fx];
    const rate = wer(truth, heard);
    const turns = segmentTurns(state, GAP_MS);
    const gaps = [];
    for (let i = 1; i < state.inputTranscript.length; i++) {
      gaps.push(state.inputTranscript[i].start_ms - state.inputTranscript[i - 1].end_ms);
    }

    const row = {
      fixture: fx,
      truth,
      heard,
      wer: Number(rate.toFixed(3)),
      fragments: state.inputTranscript.length,
      turns: turns.length,
      expected_turns: EXPECTED_TURNS[fx],
      turns_correct: turns.length === EXPECTED_TURNS[fx],
      inter_fragment_gaps_ms: gaps,
      started_ms: marks.startedMs,
      usd: Number(priced.usd.toFixed(5)),
      error: marks.error ?? null,
    };
    rows.push(row);

    console.log(
      `  ${fx.padEnd(20)} WER ${rate.toFixed(3)}  frags ${String(row.fragments).padStart(2)}  ` +
      `turns ${row.turns}/${row.expected_turns} ${row.turns_correct ? "ok" : "MISMATCH"}  $${row.usd.toFixed(4)}`
    );
    if (rate > 0.3) console.log(`      truth: ${JSON.stringify(truth)}\n      heard: ${JSON.stringify(heard)}`);
  }

  const withText = rows.filter((r) => r.heard && r.heard.trim().length);
  const medianWer = median(rows.map((r) => r.wer));
  const segOk = rows.filter((r) => r.turns_correct).length;

  // Pre-registered thresholds. Not touched after seeing the numbers.
  const g2a_pass = withText.length >= 9 && medianWer <= 0.5;
  const g2a_predicted = withText.length >= 9 && medianWer <= 0.25;
  const g2b_pass = segOk >= 6;
  const g2b_predicted = segOk >= 8;

  const out = {
    at: new Date().toISOString(),
    gap_ms: GAP_MS,
    rows,
    g2a: {
      prediction: "transcript for >=9 of 10, median WER <= 0.25",
      fails_if: "no transcript at all, or median WER > 0.50",
      fixtures_with_text: withText.length,
      median_wer: medianWer,
      pass: g2a_pass,
      prediction_held: g2a_predicted,
    },
    g2b: {
      prediction: "gap rule yields expected turn count for 8 of 10",
      fails_if: "correct for fewer than 6 of 10",
      correct: segOk,
      of: rows.length,
      pass: g2b_pass,
      prediction_held: g2b_predicted,
    },
    pass: g2a_pass && g2b_pass,
    spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-g2.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\nG2a  transcript ${withText.length}/10, median WER ${medianWer}`);
  console.log(`     predicted <=0.25 -> ${g2a_predicted ? "HELD" : "MISSED"}; fails if >0.50 -> ${g2a_pass ? "PASS" : "FAIL"}`);
  console.log(`G2b  segmentation ${segOk}/10 correct at a ${GAP_MS}ms gap rule`);
  console.log(`     predicted >=8 -> ${g2b_predicted ? "HELD" : "MISSED"}; fails if <6 -> ${g2b_pass ? "PASS" : "FAIL"}`);
  console.log(`\nG2 ${out.pass ? "PASSED" : "FAILED -- STOP THE ROUND"}`);
  console.log(`spend so far: $${summary().spent.toFixed(4)} of $${summary().cap}`);
  process.exit(out.pass ? 0 : 1);
}

main();
