// ---------------------------------------------------------------------------
// G2-repeat -- N takes of one fixture.
//
// Written because g2's name_spelling take returned ZERO transcript fragments,
// input and output, while the model spoke 11 seconds of audio -- on a session
// that took 9,083ms to reach session.started against ~1,500ms everywhere else.
//
// Two readings fit that single take and they have opposite consequences:
//
//   (a) spelled names specifically defeat the transcript -- fatal, because
//       name spelling is the defect we have failed to fix four times; or
//   (b) a session can degrade, losing transcription entirely for a whole turn,
//       independent of what was said.
//
// Only repetition separates them, and "never compare two arms at N=1" is a rule
// this directory learned the hard way. A control fixture runs alongside, so a
// degradation window hitting BOTH is visible as a window rather than read as a
// property of the spelled name.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { inputText, outputText, segmentTurns } from "./lib/gptlive.js";
import { GROUND_TRUTH } from "./lib/audio.js";
import { FRONTEND_INSTRUCTIONS } from "./lib/livePrompt.js";
import { runSession } from "./lib/liveRun.js";
import { wer } from "./lib/score.js";
import { summary } from "./lib/spendLive.js";

const fixture = process.argv[2] || "name_spelling";
const control = process.argv[3] || "clean_open";
const n = Number(process.argv[4] || 3);

async function take(fx, i) {
  const { state, marks, priced } = await runSession({
    label: `g2r-${fx}-${i}`,
    probe: "G2r",
    fixtures: [fx],
    instructions: FRONTEND_INSTRUCTIONS,
    tailMs: 4000,
    maxSeconds: 30,
  });
  const heard = inputText(state);
  const row = {
    fixture: fx, take: i,
    started_ms: marks.startedMs,
    in_frags: state.inputTranscript.length,
    out_frags: state.outputTranscript.length,
    audio_bytes: state.audioOut.reduce((a, b) => a + b.bytes, 0),
    heard,
    spoke: outputText(state),
    wer: Number(wer(GROUND_TRUTH[fx], heard).toFixed(3)),
    turns_800: segmentTurns(state, 800).length,
    usd: Number(priced.usd.toFixed(5)),
  };
  console.log(
    `  ${fx.padEnd(16)} take ${i}  start ${String(row.started_ms).padStart(5)}ms  ` +
    `in ${String(row.in_frags).padStart(2)} out ${String(row.out_frags).padStart(2)}  ` +
    `WER ${row.wer}  $${row.usd.toFixed(4)}`
  );
  if (!row.in_frags) console.log(`      NO INPUT TRANSCRIPT. spoke: ${JSON.stringify(row.spoke.slice(0, 80))}`);
  return row;
}

async function main() {
  console.log(`G2-repeat -- ${fixture} x${n}, control ${control} x${n}, alternating.\n`);
  const rows = [];
  // Alternating, so a degradation window cannot land entirely on one fixture.
  for (let i = 1; i <= n; i++) {
    rows.push(await take(fixture, i));
    rows.push(await take(control, i));
  }

  const subject = rows.filter((r) => r.fixture === fixture);
  const ctrl = rows.filter((r) => r.fixture === control);
  const blanks = (rs) => rs.filter((r) => r.in_frags === 0).length;
  const slowStarts = rows.filter((r) => r.started_ms > 4000);

  const out = {
    at: new Date().toISOString(),
    fixture, control, n, rows,
    subject_blank_transcripts: `${blanks(subject)}/${subject.length}`,
    control_blank_transcripts: `${blanks(ctrl)}/${ctrl.length}`,
    subject_median_wer: subject.map((r) => r.wer).sort()[Math.floor(subject.length / 2)],
    slow_starts_over_4s: slowStarts.map((r) => ({ fixture: r.fixture, take: r.take, started_ms: r.started_ms })),
    reading: blanks(subject) === subject.length && blanks(ctrl) === 0
      ? "FIXTURE-SPECIFIC: the spelled name defeats transcription"
      : blanks(subject) === 0
        ? "TRANSIENT: the g2 blank was a degraded session, not a property of the fixture"
        : "MIXED: blanks on both, or intermittent -- a degradation window, and transcription can vanish for a whole turn",
    spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-g2r.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\nblank transcripts: ${fixture} ${out.subject_blank_transcripts}, ${control} ${out.control_blank_transcripts}`);
  console.log(`slow starts (>4s): ${out.slow_starts_over_4s.length}/${rows.length}`);
  console.log(`READING: ${out.reading}`);
  console.log(`spend so far: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main();
