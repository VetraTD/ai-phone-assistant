#!/usr/bin/env node
/**
 * Compare two eval runs scenario by scenario, and sweep both for leaked intent
 * markers.
 *
 *   node scripts/eval-compare.js eval/results/<baseline>.json eval/results/<candidate>.json
 *
 * Why this exists: the 2026-08-04 attempt to reduce set_call_intent traffic
 * kept every hard assertion green and still had to be reverted, because it
 * regressed three scenarios on the advisory judge. The judge sets `judgePass`
 * but never the exit code (eval/judge.js), so a regression there is invisible
 * to `npm run eval` alone and has to be diffed deliberately.
 *
 * Exit code is 1 if the candidate lost a hard assertion, lost a judge verdict,
 * or leaked a marker into any spoken reply.
 */

import fs from "node:fs";
import path from "node:path";

// Anything marker-shaped that reached a reply. Deliberately broader than the
// parser in lib/intentMarker.js: this is asking "did anything resembling a
// marker survive", not "is this a valid marker".
const LEAK_RE = /<<|intent\s*:/i;

function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const byName = new Map();
  for (const r of raw.results || []) byName.set(r.name, r);
  return { file: path.basename(file), model: raw.model, ranAt: raw.ranAt, byName };
}

/** Every assistant utterance in a run, with enough context to find it again. */
function* replies(run) {
  for (const [name, scenario] of run.byName) {
    for (const [i, turn] of (scenario.turns || []).entries()) {
      if (typeof turn.reply === "string") yield { scenario: name, turn: i, reply: turn.reply };
    }
  }
}

function sweepLeaks(run) {
  const hits = [];
  for (const r of replies(run)) {
    if (LEAK_RE.test(r.reply)) hits.push(r);
  }
  return hits;
}

/** pass/fail counts for one scenario's judge rubric. */
function judgeTally(scenario) {
  const verdicts = (scenario?.judgeResults || []).map((j) => j.verdict);
  return {
    pass: verdicts.filter((v) => v === "pass").length,
    fail: verdicts.filter((v) => v === "fail").length,
    error: verdicts.filter((v) => v === "error").length,
    total: verdicts.length,
  };
}

function main() {
  const [baseFile, candFile] = process.argv.slice(2);
  if (!baseFile || !candFile) {
    console.error("usage: node scripts/eval-compare.js <baseline.json> <candidate.json>");
    process.exit(2);
  }

  const base = load(baseFile);
  const cand = load(candFile);

  // Model pins have to match for the comparison to mean anything — a judge
  // verdict that moved because the model moved is not a result.
  const fmtModel = (m) => (typeof m === "string" ? m : JSON.stringify(m));
  console.log(`baseline : ${base.file}  (${fmtModel(base.model)}, ${base.ranAt})`);
  console.log(`candidate: ${cand.file}  (${fmtModel(cand.model)}, ${cand.ranAt})`);
  if (fmtModel(base.model) !== fmtModel(cand.model)) {
    console.log("  WARNING: model pins differ between the runs — verdict deltas are not attributable.");
  }
  console.log("");

  const names = [...new Set([...base.byName.keys(), ...cand.byName.keys()])].sort();

  const rows = [];
  let hardRegressions = 0;
  let judgeRegressions = 0;
  let judgeImprovements = 0;

  for (const name of names) {
    const b = base.byName.get(name);
    const c = cand.byName.get(name);
    if (!b || !c) {
      rows.push(`  ${name.padEnd(28)} MISSING from ${b ? "candidate" : "baseline"}`);
      hardRegressions++;
      continue;
    }

    const bj = judgeTally(b);
    const cj = judgeTally(c);
    const hardDelta = (b.hardPass ? 1 : 0) - (c.hardPass ? 1 : 0);
    const judgeDelta = cj.pass - bj.pass;

    if (hardDelta > 0) hardRegressions++;
    if (judgeDelta < 0) judgeRegressions++;
    if (judgeDelta > 0) judgeImprovements++;

    const flag = hardDelta > 0 ? "HARD REGRESSION" : judgeDelta < 0 ? "judge -" : judgeDelta > 0 ? "judge +" : "";
    rows.push(
      `  ${name.padEnd(28)} hard ${b.hardPass ? "P" : "F"}->${c.hardPass ? "P" : "F"}   ` +
        `judge ${bj.pass}/${bj.total} -> ${cj.pass}/${cj.total}   ${flag}`
    );

    // Name the questions that actually moved — a count alone does not say
    // which behaviour changed.
    for (const [i, q] of (c.judgeResults || []).entries()) {
      const before = b.judgeResults?.[i];
      if (before && before.verdict !== q.verdict) {
        rows.push(`      ${before.verdict} -> ${q.verdict}: ${q.question}`);
        rows.push(`      reason: ${q.reason}`);
      }
    }
  }

  console.log(rows.join("\n"));

  const baseLeaks = sweepLeaks(base);
  const candLeaks = sweepLeaks(cand);

  console.log("\n--- marker leak sweep (every assistant reply in both runs) ---");
  for (const [label, hits] of [["baseline", baseLeaks], ["candidate", candLeaks]]) {
    if (hits.length === 0) {
      console.log(`  ${label}: clean`);
    } else {
      console.log(`  ${label}: ${hits.length} LEAK(S)`);
      for (const h of hits) console.log(`    ${h.scenario} turn ${h.turn}: ${JSON.stringify(h.reply)}`);
    }
  }

  console.log("\n--- verdict ---");
  console.log(`  hard regressions : ${hardRegressions}`);
  console.log(`  judge regressions: ${judgeRegressions}`);
  console.log(`  judge improvements: ${judgeImprovements}`);
  console.log(`  net judge        : ${judgeImprovements - judgeRegressions >= 0 ? "+" : ""}${judgeImprovements - judgeRegressions}`);

  const fail = hardRegressions > 0 || candLeaks.length > 0 || judgeImprovements - judgeRegressions < 0;
  console.log(`\n  ${fail ? "DOES NOT MEET THE MERGE GATE" : "meets the merge gate"}`);
  process.exit(fail ? 1 : 0);
}

main();
