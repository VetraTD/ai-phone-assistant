// ---------------------------------------------------------------------------
// G3 -- the trail-off.
//
// Gemini 3.1 cuts into a trailing-off caller 5/5 at default and 3/5 even at
// END_SENSITIVITY_LOW + 1200ms. No setting fixes it, because in speech-to-speech
// the VAD is the vendor's. That is the defect we failed to fix three times and
// the strongest single argument for moving.
//
// TWO INSTRUMENT DEFECTS WERE FOUND AND FIXED BEFORE THIS NUMBER MEANT ANYTHING:
//
// 1. The first run played caller audio from t=0, so the model's GREETING
//    collided with a caller who never waited for it. All ten takes reported an
//    identical 0.61s offset into two fixtures of different lengths -- the tell
//    that it was a greeting firing on a timer, not a response. runSession now
//    waits for the greeting to go quiet before the caller speaks.
//
// 2. Classification read the output TRANSCRIPT, which lags the output AUDIO by
//    2.6-3.0 seconds (measured this round). The classifier was therefore blind
//    for the entire window it was meant to judge and scored ten overlaps as
//    "silent". Detection is now AUDIO-based; text is recorded for the log but
//    never gates the verdict.
//
// A full-duplex model makes noises while the caller speaks BY DESIGN, so a
// short run is a backchannel and only a sustained one is a cut-in. Scoring any
// overlap as a cut-in would fail GPT-Live for doing what it was built to do.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { outputText, outputSpeechRuns } from "./lib/gptlive.js";
import { FRONTEND_INSTRUCTIONS } from "./lib/livePrompt.js";
import { runSession } from "./lib/liveRun.js";
import { summary } from "./lib/spendLive.js";

const FIXTURES = ["no_terminal_punct", "trailing_lead_in"];
const N = 5;

/** Pre-registered in verdicts-gptlive.json. */
const BACKCHANNEL_MAX_MS = 800;
const CUT_IN_MIN_MS = 1500;

async function take(fx, i) {
  const { state, marks, priced } = await runSession({
    label: `g3-${fx}-${i}`,
    probe: "G3",
    fixtures: [fx],
    instructions: FRONTEND_INSTRUCTIONS,
    greetFirst: true,
    tailMs: 5000,
    maxSeconds: 45,
  });

  const f0 = marks.fixtures[0];
  const callerStartAt = f0?.startAt;
  const speechEndAt = f0?.speechEndAt;

  // SPEECH -- by energy, not by delta arrival. The output stream is continuous
  // and carries silence; counting deltas counts silence. See outputSpeechRuns.
  const { runs, rmsPercentiles } = outputSpeechRuns(state);
  const overlapping = runs.filter((r) => r.endAt > callerStartAt && r.startAt < speechEndAt);
  const overlapMs = overlapping.reduce(
    (a, r) => a + (Math.min(r.endAt, speechEndAt) - Math.max(r.startAt, callerStartAt)), 0);
  // The run's FULL length, not just the overlapping slice: a model that starts
  // a 3-second sentence 200ms before the caller stops has taken the floor.
  const longestOverlapRun = overlapping.length ? Math.max(...overlapping.map((r) => r.ms)) : 0;

  let classification;
  if (!overlapping.length) classification = "waited";
  else if (longestOverlapRun >= CUT_IN_MIN_MS) classification = "cut_in";
  else if (longestOverlapRun <= BACKCHANNEL_MAX_MS) classification = "backchannel";
  else classification = "ambiguous";

  const row = {
    fixture: fx, take: i,
    greeting: (marks.greetingText || "").trim(),
    greeting_runs_ms: marks.greetingSpeechRuns ?? null,
    speech_overlap_ms: Math.round(overlapMs),
    longest_overlapping_run_ms: longestOverlapRun,
    ms_into_caller_speech: overlapping.length ? Math.max(0, overlapping[0].startAt - callerStartAt) : null,
    total_speech_runs: runs.length,
    rms_percentiles: rmsPercentiles,
    classification,
    reply_after: outputText(state).replace((marks.greetingText || "").trim(), "").trim(),
    in_frags: state.inputTranscript.length,
    usd: Number(priced.usd.toFixed(5)),
  };

  console.log(
    `  ${fx.padEnd(18)} take ${i}  ${classification.padEnd(12)} ` +
    `${row.speech_overlap_ms ? `${row.speech_overlap_ms}ms speech overlap, run ${row.longest_overlapping_run_ms}ms` : "silent while caller spoke"}` +
    `  $${row.usd.toFixed(4)}`
  );
  return row;
}

async function main() {
  console.log("G3 -- trail-off, with the greeting waited out and audio-based detection.\n");
  const rows = [];
  for (const fx of FIXTURES) {
    for (let i = 1; i <= N; i++) rows.push(await take(fx, i));
  }

  const byFixture = {};
  for (const fx of FIXTURES) {
    const rs = rows.filter((r) => r.fixture === fx);
    const cutIns = rs.filter((r) => r.classification === "cut_in").length;
    byFixture[fx] = {
      cut_ins: cutIns,
      backchannels: rs.filter((r) => r.classification === "backchannel").length,
      waited: rs.filter((r) => r.classification === "waited").length,
      ambiguous: rs.filter((r) => r.classification === "ambiguous").length,
      of: rs.length,
      pass: cutIns < 2,
      prediction_held: cutIns === 0,
      gemini: "5/5 cut in at default, 3/5 at END_SENSITIVITY_LOW+1200ms",
    };
  }

  const pass = Object.values(byFixture).every((b) => b.pass);
  const predicted = Object.values(byFixture).every((b) => b.prediction_held);

  const out = {
    at: new Date().toISOString(),
    prediction: "0 of 5 cut-ins on each fixture; backchannels expected and not scored against it",
    fails_if: "2 or more of 5 cut in on either fixture",
    detection: `audio-based. backchannel <=${BACKCHANNEL_MAX_MS}ms, cut-in >=${CUT_IN_MIN_MS}ms of the overlapping run`,
    instrument_defects_fixed: [
      "greeting collided with caller audio at t=0; runSession now waits for the greeting",
      "output transcript lags output audio by 2.6-3.0s, so text-based detection was blind",
    ],
    byFixture, rows, pass, prediction_held: predicted,
    spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-g3.json", JSON.stringify(out, null, 2) + "\n");

  console.log("");
  for (const [fx, b] of Object.entries(byFixture)) {
    console.log(`${fx}: ${b.cut_ins} cut-in, ${b.backchannels} backchannel, ${b.waited} waited, ${b.ambiguous} ambiguous (of ${b.of})`);
  }
  console.log(`\npredicted 0 cut-ins -> ${predicted ? "HELD" : "MISSED"}`);
  console.log(`G3 ${pass ? "PASSED" : "FAILED"}`);
  console.log(`spend so far: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main();
