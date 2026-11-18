// ---------------------------------------------------------------------------
// Re-score T6 (WER) and T7 (exact sentence) from saved rows. No new sessions.
//
// TWO SCORING DEFECTS, both found by reading the rows rather than the summary.
//
// T6 -- WER WAS PUNISHING NUMBER FORMATTING, NOT MISHEARING.
//
//   truth  "It's five five five, one two three four."
//   heard  "It's 5551234."                              -> WER 0.875
//
//   truth  "Tuesday at ten works for me."
//   heard  "Tuesday at 10:00 works for me."             -> WER 0.333
//
// Those are the SAME CONTENT. gemini-3.8-live normalises spoken numbers into
// digits -- which is the "alphanumeric precision for codes and numbers" Google
// advertises, and which is a FEATURE for a receptionist taking a phone number.
// GPT-Live scored 0.000 on the same fixtures because it happened to write the
// words out. Scoring raw strings makes the better behaviour look worse.
//
// Three of the five non-zero WERs are this. So WER is reported twice: raw, and
// with numbers normalised on both sides. The second is the transcription
// number; the first is kept because the raw strings are what a downstream
// regex would actually see.
//
// T7 -- "DELIVERED" COUNTED ANY SPEECH AT ALL.
//
// Two read-back takes were scored "delivered, paraphrased, facts lost". What
// the model actually said was "Are you a new or existing patient?" -- it
// ignored the pushed sentence completely and asked its own question. That is a
// DELIVERY FAILURE, not a paraphrase, and counting it as delivered produced
// `usable_for_a_disclosure: true` off a rate that was not real.
//
// Delivery now requires the pushed content to actually appear.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { wer } from "./lib/score.js";

const ONES = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12",
};

/**
 * Collapse both representations of a number to the same token stream, so
 * "five five five one two three four" and "5551234" compare equal, and
 * "ten" and "10:00" compare equal.
 */
function normNumbers(s) {
  let t = String(s || "").toLowerCase();
  t = t.replace(/[.,!?;:'"]/g, " ");
  // number words -> digits
  t = t.replace(/\b([a-z]+)\b/g, (w) => (ONES[w] !== undefined ? ONES[w] : w));
  // "10 00" / "10:00" -> "10"; a trailing :00 carries no information here
  t = t.replace(/\b(\d{1,2})[: ]0 ?0\b/g, "$1");
  t = t.replace(/\b(\d{1,2}):00\b/g, "$1");
  // run digits together so 5 5 5 1 2 3 4 == 5551234
  t = t.replace(/(?<=\d)\s+(?=\d)/g, "");
  return t.replace(/\s+/g, " ").trim();
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9: ]/g, "").replace(/\s+/g, " ").trim();

function rescoreT6() {
  const p = "scripts/probes/results-t6-wer.json";
  if (!fs.existsSync(p)) return null;
  const r = JSON.parse(fs.readFileSync(p, "utf8"));
  const rows = r.rows.filter((x) => !x.error && x.truth);
  for (const x of rows) {
    x.wer_raw = x.wer;
    x.wer_numeric_normalised = Number(wer(normNumbers(x.truth), normNumbers(x.heard)).toFixed(3));
    x.differs_only_by_number_format = x.wer_raw > 0 && x.wer_numeric_normalised === 0;
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const out = {
    n: rows.length,
    median_wer_raw: med(rows.map((x) => x.wer_raw)),
    median_wer_numeric_normalised: med(rows.map((x) => x.wer_numeric_normalised)),
    perfect_raw: rows.filter((x) => x.wer_raw === 0).length,
    perfect_normalised: rows.filter((x) => x.wer_numeric_normalised === 0).length,
    number_format_only: rows.filter((x) => x.differs_only_by_number_format).map((x) => x.fixture),
    real_errors: rows.filter((x) => x.wer_numeric_normalised > 0).map((x) => ({
      fixture: x.fixture, wer: x.wer_numeric_normalised, truth: x.truth, heard: x.heard,
    })),
    rows,
  };
  fs.writeFileSync("scripts/probes/results-t6-scored.json", JSON.stringify(out, null, 2) + "\n");
  return out;
}

function rescoreT7() {
  const p = "scripts/probes/results-t7.json";
  if (!fs.existsSync(p)) return null;
  const r = JSON.parse(fs.readFileSync(p, "utf8"));
  const rows = r.rows.filter((x) => !x.error);
  for (const x of rows) {
    const spoken = norm(x.spoken);
    const line = norm(x.line);
    x.verbatim_strict = spoken.includes(line);
    // Delivery means the pushed content actually reached the caller. A model
    // that says something else entirely has NOT delivered it.
    const lineWords = line.split(" ").filter((w) => w.length > 3);
    const overlap = lineWords.filter((w) => spoken.includes(w)).length / Math.max(1, lineWords.length);
    x.content_overlap = Number(overlap.toFixed(2));
    x.delivered_strict = x.verbatim_strict || overlap >= 0.6;
    x.spoke_something_else = !x.delivered_strict && spoken.length > 0;
  }
  const byCase = {};
  for (const c of [...new Set(rows.map((x) => x.case))]) {
    const rs = rows.filter((x) => x.case === c);
    byCase[c] = {
      of: rs.length,
      delivered_strict: rs.filter((x) => x.delivered_strict).length,
      verbatim: rs.filter((x) => x.verbatim_strict).length,
      spoke_something_else: rs.filter((x) => x.spoke_something_else).length,
      silent: rs.filter((x) => !x.spoken || !norm(x.spoken)).length,
      rate: Number((rs.filter((x) => x.delivered_strict).length / rs.length).toFixed(2)),
    };
  }
  const delivered = rows.filter((x) => x.delivered_strict).length;
  const out = {
    n: rows.length,
    by_case: byCase,
    delivered_strict: delivered,
    verbatim: rows.filter((x) => x.verbatim_strict).length,
    rate: Number((delivered / rows.length).toFixed(2)),
    // The bar from the GPT-Live round: a disclosure must be delivered every
    // time, and 0.95 is the floor for calling a mechanism usable.
    usable_for_a_disclosure: delivered / rows.length >= 0.95,
    note_on_n:
      "N=4 per case cannot demonstrate 0.95 even at 4 of 4. The disclosure result is strong and " +
      "under-powered; it is a reason to test further, not a reason to trust the channel with a legal string.",
    gptlive_comparison: "best mechanism 5 of 8 delivered, 12 of 24 pushes acknowledged and never spoken",
    rows,
  };
  fs.writeFileSync("scripts/probes/results-t7-scored.json", JSON.stringify(out, null, 2) + "\n");
  return out;
}

const t6 = rescoreT6();
const t7 = rescoreT7();

if (t6) {
  console.log("T6 WER, re-scored\n");
  console.log(`  median raw                 ${t6.median_wer_raw}`);
  console.log(`  median numbers normalised  ${t6.median_wer_numeric_normalised}   <- the transcription number`);
  console.log(`  perfect  raw ${t6.perfect_raw}/${t6.n}   normalised ${t6.perfect_normalised}/${t6.n}`);
  console.log(`  differ ONLY by number format: ${t6.number_format_only.join(", ") || "none"}`);
  console.log(`  real errors:`);
  for (const e of t6.real_errors) {
    console.log(`    ${e.fixture.padEnd(18)} ${e.wer}`);
    console.log(`      truth ${JSON.stringify(e.truth)}`);
    console.log(`      heard ${JSON.stringify(e.heard)}`);
  }
}

if (t7) {
  console.log("\nT7 exact sentence, re-scored\n");
  for (const [c, v] of Object.entries(t7.by_case)) {
    console.log(`  ${c.padEnd(11)} delivered ${v.delivered_strict}/${v.of}   verbatim ${v.verbatim}   spoke something else ${v.spoke_something_else}   silent ${v.silent}`);
  }
  console.log(`\n  overall ${t7.delivered_strict}/${t7.n} delivered (${t7.rate}), ${t7.verbatim} verbatim`);
  console.log(`  usable for a disclosure: ${t7.usable_for_a_disclosure}`);
  console.log(`  ${t7.note_on_n}`);
}
