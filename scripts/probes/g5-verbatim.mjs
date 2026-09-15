// ---------------------------------------------------------------------------
// G5 -- will it say what we tell it to say?
//
// session.commentary.append content is documented as spoken "in the model's own
// words", and LiveKit's plugin raises an error on session.say() because the
// model will not read a script. Two of our strings are not paraphrasable:
//
//   1. the recording disclosure -- a legal obligation, word for word
//   2. an appointment read-back  -- the thing a booking hangs on
//
// FAIL CONDITION, pre-registered: the time is altered even once. A reworded
// legal sentence is a design problem; a wrong hour spoken to a caller is a
// wrong appointment.
//
// Scored on the text AND saved to WAV, because a paraphrase that preserves the
// facts is a different thing from one that does not, and the owner should be
// able to hear which happened.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { FRONTEND_INSTRUCTIONS, CLIENT_DELEGATION } from "./lib/livePrompt.js";
import { runSession } from "./lib/liveRun.js";
import { normWords } from "./lib/score.js";
import { summary } from "./lib/spendLive.js";

const N = Number(process.env.G5_N || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  {
    id: "disclosure",
    push: "This call is being recorded for quality and training purposes.",
    // Every content word must survive for the sentence to be legally the same.
    mustContain: ["recorded", "quality", "training"],
    critical: false,
  },
  {
    id: "readback",
    push: "Your appointment is Thursday the 18th of September at 2:15 pm.",
    // These are the facts. Losing or changing one is a wrong appointment.
    mustContain: ["thursday", "18th", "september", "2", "15"],
    critical: true,
  },
];

async function take(testCase, i) {
  const label = `g5-${testCase.id}-${i}`;
  let pushedAt = null;

  const { state, marks, priced } = await runSession({
    label,
    probe: "G5",
    fixtures: ["clean_open"],
    instructions: FRONTEND_INSTRUCTIONS,
    delegation: CLIENT_DELEGATION,
    greetFirst: false,
    tailMs: 10000,
    maxSeconds: 60,
    afterAudio: async ({ session, state: st }) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !st.delegations.length) await sleep(50);
      const deleg = st.delegations[0];
      pushedAt = st.outputTranscript.length
        ? Math.max(...st.outputTranscript.map((t) => t.end_ms))
        : 0;
      session.commentary(testCase.push, deleg?.id ?? null, `g5_${i}`);
      await sleep(8000);
    },
  });

  // Everything spoken after the push went in.
  const after = state.outputTranscript.filter((t) => t.start_ms >= (pushedAt ?? 0));
  const spoken = after.map((t) => t.delta).join("").trim();
  const spokenWords = normWords(spoken);

  const missing = testCase.mustContain.filter((tok) => !spokenWords.includes(tok.toLowerCase()));
  const verbatim = spoken.toLowerCase().includes(testCase.push.toLowerCase().replace(/\.$/, ""));
  const factsIntact = missing.length === 0;

  const row = {
    case: testCase.id, take: i,
    pushed: testCase.push,
    spoken,
    verbatim,
    facts_intact: factsIntact,
    missing_tokens: missing,
    critical: testCase.critical,
    usd: Number(priced.usd.toFixed(5)),
    error: marks.error ?? null,
  };

  console.log(
    `  ${testCase.id.padEnd(11)} take ${i}  ` +
    `${verbatim ? "VERBATIM" : "paraphrased"}  ${factsIntact ? "facts intact" : `LOST: ${missing.join(",")}`}  $${row.usd.toFixed(4)}`
  );
  console.log(`      spoke: ${JSON.stringify(spoken).slice(0, 160)}`);
  return row;
}

async function main() {
  console.log(`G5 -- verbatim. commentary.append is documented as spoken "in its own words".\n`);
  const rows = [];
  for (const c of CASES) {
    for (let i = 1; i <= N; i++) rows.push(await take(c, i));
  }

  const byCase = {};
  for (const c of CASES) {
    const rs = rows.filter((r) => r.case === c.id);
    byCase[c.id] = {
      of: rs.length,
      verbatim: rs.filter((r) => r.verbatim).length,
      paraphrased: rs.filter((r) => !r.verbatim).length,
      facts_intact: rs.filter((r) => r.facts_intact).length,
      facts_lost: rs.filter((r) => !r.facts_intact).length,
      critical: c.critical,
    };
  }

  // Pre-registered: fails if the TIME is altered even once.
  const readback = byCase.readback;
  const pass = readback.facts_lost === 0;
  const predictedDisclosure = byCase.disclosure.paraphrased >= 3;
  const predictedReadback = readback.facts_intact >= 4;

  const out = {
    at: new Date().toISOString(),
    prediction: "disclosure paraphrased in >=3 of 5; appointment time intact in >=4 of 5",
    fails_if: "the time is altered even once",
    byCase, rows, pass,
    prediction_held: { disclosure: predictedDisclosure, readback: predictedReadback },
    note: "Every take is saved to scripts/probes/audio/g5-*.wav so a paraphrase can be judged by ear.",
    spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-g5.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\ndisclosure: ${byCase.disclosure.verbatim}/${byCase.disclosure.of} verbatim, ${byCase.disclosure.facts_intact} kept every content word`);
  console.log(`readback:   ${readback.verbatim}/${readback.of} verbatim, ${readback.facts_intact} kept every fact, ${readback.facts_lost} LOST A FACT`);
  console.log(`\npredicted disclosure paraphrased >=3 -> ${predictedDisclosure ? "HELD" : "MISSED"}`);
  console.log(`predicted readback intact >=4 -> ${predictedReadback ? "HELD" : "MISSED"}`);
  console.log(`G5 ${pass ? "PASSED" : "FAILED -- a spoken appointment time was altered"}`);
  console.log(`spend so far: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main();
