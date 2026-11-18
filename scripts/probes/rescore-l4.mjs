// ---------------------------------------------------------------------------
// Re-score L4 from the raw transcripts already on disk. No new API calls.
//
//   node scripts/probes/rescore-l4.mjs
//
// The first L4 run scored 0/5 because the letter extractor swept up every
// single-letter word in the sentence, so a correct "n i t h i n" came out as
// "NITHINI". The model was right and the instrument was wrong. Since
// `readback_said` was captured verbatim in the raw file, the fix is re-scoring
// the saved text, not re-running the probe and paying for it twice.
//
// verdicts.json is NOT touched. The prediction stands as written; this only
// corrects what the measurement says the result was.
// ---------------------------------------------------------------------------
import { readRaw, writeRaw } from "./lib/stats.js";

const GROUND_TRUTH_NAME = "Nithin";
const GROUND_TRUTH_LETTERS = "NITHIN";

/** Longest contiguous run of single-letter tokens. See l4-gemini-reseed.mjs. */
function spelledLetters(text) {
  const words = String(text).toUpperCase().match(/[A-Z]+/g) || [];
  let best = "", run = "";
  for (const w of words) {
    if (w.length === 1) { run += w; if (run.length > best.length) best = run; }
    else run = "";
  }
  return best;
}

const raw = readRaw("l4-gemini-reseed");
if (!raw) { console.error("no raw/l4-gemini-reseed.json — run the probe first"); process.exit(1); }

const trials = raw.trials.map((t) => {
  const said = t.readback_said || "";
  const letters = spelledLetters(said);
  return {
    ...t,
    readback_letters: letters,
    readback_letters_v1_buggy: t.readback_letters,
    name_exact: said.includes(GROUND_TRUTH_NAME),
    spelling_exact: letters === GROUND_TRUTH_LETTERS,
    // V6 asks whether the reseed preserved the name. The spelling IS that
    // answer: it is the part a lossy audio->text->audio round trip would
    // corrupt, and the part PLAN.md notes a human listener cannot check.
    // Whether the model also repeated the name as a word is phrasing, tracked
    // separately rather than folded in.
    pass: letters === GROUND_TRUTH_LETTERS,
  };
});

const summary = {
  ...raw.summary,
  rescored_at: new Date().toISOString(),
  rescore_reason:
    "letter extractor took every single-letter token instead of the longest contiguous run; " +
    "a correct 'n i t h i n' scored as NITHINI. Re-scored from saved transcripts, no new calls.",
  exact_match_count: trials.filter((t) => t.pass).length,
  spelling_exact_count: trials.filter((t) => t.spelling_exact).length,
  name_word_spoken_count: trials.filter((t) => t.name_exact).length,
  stt_captured_name_count: trials.filter((t) => t.stt_captured_name).length,
};

writeRaw("l4-gemini-reseed", { summary, trials });

console.log("L4 re-scored from saved transcripts (no API calls, no spend)\n");
for (const t of trials) {
  console.log(
    `  trial ${t.trial}: letters=${t.readback_letters} (was ${t.readback_letters_v1_buggy}) ` +
    `spelling_exact=${t.spelling_exact} name_word=${t.name_exact} -> ${t.pass ? "PASS" : "FAIL"}`
  );
}
console.log(
  `\n  spelling exact ${summary.spelling_exact_count}/${trials.length}` +
  `   name word spoken ${summary.name_word_spoken_count}/${trials.length}` +
  `   vendor STT captured name pre-reseed ${summary.stt_captured_name_count}/${trials.length}`
);
