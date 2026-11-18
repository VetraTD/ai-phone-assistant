// ---------------------------------------------------------------------------
// T6 -- caller transcript quality and repetition. FREE: no new sessions.
//
// Pre-registered as scored from audio the other gates already paid for, because
// a number that can be re-derived from saved data should never cost a second
// run. Two things it answers:
//
// WER. Google names "alphanumeric precision for codes and numbers" as a 3.8
// feature, and the defects it would touch are real ones: LVX42's spelling gate
// writing a misheard name, LVX123's invented surname, LVX77's name the caller
// never said. GPT-Live already scores median WER 0.000 on these fixtures, so
// the bar is high, not low. Scored against GROUND_TRUTH -- the text the audio
// was synthesized FROM, so there is no transcription of a transcription.
//
// REPETITION. This is the defect Gemini 2.5 has and GPT-Live does not: 2.5 hit
// max_repeat 7 on "are you a new patient or an existing one" in a single
// session, against GPT-Live's worst of 3. It is also LVX78, LVX67 and LVX25 in
// production. Counted over every scoreable T3 and T4 conversation.
//
// FAIL CONDITION: median WER above 0.25, or a max_repeat of 5 or more.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { wer, median } from "./lib/score.js";
import { GROUND_TRUTH } from "./lib/audio.js";
import { questionsIn } from "./lib/callerRun.js";

function read(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function repeatStats(text) {
  const qs = questionsIn(text);
  const seen = new Map();
  for (const q of qs) seen.set(q, (seen.get(q) || 0) + 1);
  const worst = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  return { questions: qs.length, most_repeated: worst ? worst[0] : null, repeat_count: worst ? worst[1] : 0 };
}

function main() {
  const t1 = read("scripts/probes/results-t1.json");
  const t3 = read("scripts/probes/results-t3.json");
  const t4 = read("scripts/probes/results-t4.json");

  const out = { at: new Date().toISOString(), sources: [], wer: {}, repetition: {} };

  // --- WER, from T1's per-fixture input transcripts ---
  const werRows = [];
  if (t1?.rows) {
    out.sources.push("results-t1.json");
    for (const r of t1.rows) {
      const truth = GROUND_TRUTH[r.fixture];
      if (!truth || r.error) continue;
      const heard = String(r.input_transcript || "");
      werRows.push({
        fixture: r.fixture, take: r.take,
        truth, heard: heard.slice(0, 160),
        wer: Number(wer(truth, heard).toFixed(3)),
        blank: heard.trim().length === 0,
      });
    }
  }
  const werValues = werRows.map((r) => r.wer);
  out.wer = {
    n: werRows.length,
    median: werValues.length ? Number(median(werValues).toFixed(3)) : null,
    blank_transcripts: werRows.filter((r) => r.blank).length,
    by_fixture: {},
    rows: werRows,
  };
  for (const f of [...new Set(werRows.map((r) => r.fixture))]) {
    const rs = werRows.filter((r) => r.fixture === f);
    out.wer.by_fixture[f] = {
      n: rs.length,
      median: Number(median(rs.map((r) => r.wer)).toFixed(3)),
      truth: GROUND_TRUTH[f],
      sample_heard: rs[0]?.heard,
    };
  }

  // --- repetition, from every scoreable T3 / T4 conversation ---
  const repRows = [];
  for (const [name, data] of [["T3", t3], ["T4", t4]]) {
    if (!data?.rows) continue;
    out.sources.push(name === "T3" ? "results-t3.json" : "results-t4.json");
    for (const r of data.rows) {
      if (r.error || r.scoreable === false) continue;
      const st = repeatStats(r.fullText || "");
      repRows.push({
        gate: name, vendor: r.vendor, scenario: r.scenario || "cancel_rebook", take: r.take,
        questions: st.questions, repeat_count: st.repeat_count, most_repeated: st.most_repeated,
      });
    }
  }
  for (const v of [...new Set(repRows.map((r) => r.vendor))]) {
    const rs = repRows.filter((r) => r.vendor === v);
    out.repetition[v] = {
      conversations: rs.length,
      max_repeat: Math.max(0, ...rs.map((r) => r.repeat_count)),
      median_repeat: rs.length ? Number(median(rs.map((r) => r.repeat_count)).toFixed(1)) : null,
      looped_3plus: rs.filter((r) => r.repeat_count >= 3).length,
      worst_example: rs.sort((a, b) => b.repeat_count - a.repeat_count)[0]?.most_repeated ?? null,
    };
  }
  out.repetition._rows = repRows;

  const worstRepeat = Math.max(0, ...Object.values(out.repetition).filter((v) => v && typeof v === "object" && "max_repeat" in v).map((v) => v.max_repeat));
  out.verdict = {
    predicted: "median WER at or below 0.10; repetition between 2.5's 7 and GPT-Live's 3, under 5",
    measured_wer: out.wer.median,
    measured_max_repeat: worstRepeat,
    fails: (out.wer.median != null && out.wer.median > 0.25) || worstRepeat >= 5,
    baselines: {
      "gpt-live-1": "median WER 0.000 on these fixtures; worst max_repeat 3",
      "gemini-live-2.5-flash-native-audio": "max_repeat 7 in one session; looped 3+ in 4 of 15",
      "gemini-3.1-flash-live-preview": "transcript lossy, 1,500ms of voiced speech logged as zero characters",
    },
  };

  fs.writeFileSync("scripts/probes/results-t6.json", JSON.stringify(out, null, 2) + "\n");

  console.log("T6 -- transcript quality and repetition (free, scored from saved runs)");
  console.log(`  sources: ${[...new Set(out.sources)].join(", ")}\n`);
  console.log(`  WER  n=${out.wer.n}  median ${out.wer.median}   blank transcripts ${out.wer.blank_transcripts}`);
  for (const [f, v] of Object.entries(out.wer.by_fixture)) {
    console.log(`    ${f.padEnd(18)} median ${String(v.median).padEnd(6)} truth ${JSON.stringify(v.truth)}`);
    console.log(`    ${"".padEnd(18)} heard  ${JSON.stringify(v.sample_heard)}`);
  }
  console.log(`\n  repetition`);
  for (const [v, s] of Object.entries(out.repetition)) {
    if (v.startsWith("_")) continue;
    console.log(`    ${v.padEnd(10)} ${s.conversations} conversations   max_repeat ${s.max_repeat}   looped3+ ${s.looped_3plus}`);
    if (s.worst_example) console.log(`    ${"".padEnd(10)} worst: ${JSON.stringify(s.worst_example.slice(0, 80))}`);
  }
  console.log(`\n  ${out.verdict.fails ? "*** T6 FAILS ***" : "T6 passes"}`);
}

main();
