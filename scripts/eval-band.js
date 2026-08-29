#!/usr/bin/env node
/**
 * Measure the eval suite's noise band, and compare N runs against N runs.
 *
 *   node scripts/eval-band.js --band eval/results/a.json eval/results/b.json ...
 *   node scripts/eval-band.js --baseline a.json,b.json,c.json \
 *                             --candidate d.json,e.json,f.json
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: `eval:compare` CANNOT ANSWER THE QUESTION C1 ASKS
 * ---------------------------------------------------------------------------
 *
 * scripts/eval-compare.js diffs ONE run against ONE run. That is the right tool
 * for "did this specific pair differ" and the wrong one for "did anything
 * regress", because the suite is not deterministic. Measured on 2026-08-23,
 * five full runs of IDENTICAL code at temperature 0.4:
 *
 *   hard pass: 37, 36, 35, 36, 36   — a three-point band, not a number
 *
 * Feeding those five runs to eval-compare as all twenty ordered pairs:
 *
 *   17 of 20 report "DOES NOT MEET THE MERGE GATE"
 *
 * An 85% false-alarm rate against a codebase that did not change. So C1 as
 * written — "eval x2 per mode, then eval:compare" — would have declared a
 * Vertex regression on the overwhelming majority of runs where Vertex was
 * perfect, and there is no way to tell that answer from a true one.
 *
 * ---------------------------------------------------------------------------
 * WHAT REPLACES IT
 * ---------------------------------------------------------------------------
 *
 * The aggregate is the wrong statistic. It is a sum over ~37 scenarios of which
 * most are perfectly deterministic and three are not, so it moves for reasons
 * that have nothing to do with the change under test. The per-SCENARIO pass
 * vector is the signal: a scenario that failed 0 times in five baseline runs
 * and 5 times in five candidate runs is a regression no aggregate can hide, and
 * one that flaked either way is noise no aggregate can rescue.
 *
 * So each scenario becomes a 2x2 table — baseline fails/passes against
 * candidate fails/passes — and gets a one-sided Fisher exact test. Fisher
 * because n is tiny by design (runs cost money and ~5 minutes each) and it is
 * exact rather than asymptotic at n=5, where a chi-square is simply wrong.
 *
 * WHAT THAT COSTS, and it is the honest limit: at n=5 per arm the smallest
 * achievable p-value is 0.004 (a clean 5-0 split), and a 4-1 split only reaches
 * p=0.024. A scenario that goes from never failing to failing HALF the time
 * cannot be called significant at this sample size — it can only be flagged for
 * a longer look. That is a property of the budget, not of this script, and it
 * is why the report prints the split alongside the p-value: the numbers are
 * meant to be read, not thresholded blindly.
 */

import fs from "node:fs";
import path from "node:path";

const ALPHA = 0.05;

// ---------------------------------------------------------------------------
// Fisher's exact test, one-sided (is the CANDIDATE worse?).
//
// Log-gamma rather than factorials: N stays small here, but a factorial-based
// implementation is the kind of thing that silently loses precision the first
// time somebody runs 30 runs an arm, and nothing would report that it had.
// ---------------------------------------------------------------------------
function logGamma(z) {
  // Lanczos approximation, g=7, n=9.
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = g[0];
  for (let i = 1; i < 9; i++) x += g[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

const logChoose = (n, k) =>
  n < 0 || k < 0 || k > n ? -Infinity : logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/**
 * One-sided p: the probability of seeing the candidate fail AT LEAST this
 * often, if both arms drew from the same underlying rate.
 */
function fisherOneSided(baseFail, basePass, candFail, candPass) {
  const nBase = baseFail + basePass;
  const nCand = candFail + candPass;
  const total = nBase + nCand;
  const totalFail = baseFail + candFail;
  const logDenom = logChoose(total, totalFail);

  let p = 0;
  for (let c = candFail; c <= Math.min(nCand, totalFail); c++) {
    const b = totalFail - c;
    if (b < 0 || b > nBase) continue;
    p += Math.exp(logChoose(nBase, b) + logChoose(nCand, c) - logDenom);
  }
  return Math.min(1, p);
}

// ---------------------------------------------------------------------------

function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const results = raw.results || [];
  if (results.length === 0) throw new Error(`${file}: no results array`);
  return {
    file: path.basename(file),
    ranAt: raw.ranAt,
    model: raw.model,
    byName: new Map(results.map((r) => [r.name, r])),
  };
}

/** Union of scenario names, so a suite that gained or lost one is visible. */
function scenarioNames(runs) {
  const names = new Set();
  for (const r of runs) for (const n of r.byName.keys()) names.add(n);
  return [...names].sort();
}

/**
 * Per scenario: how many of these runs it FAILED, on each of the two gates.
 * A scenario missing from a run counts as neither — and is reported, because
 * silently treating an absent scenario as a pass is how a suite shrinks
 * without anyone noticing.
 */
function tally(runs, names) {
  const out = new Map();
  for (const name of names) {
    let hardFail = 0;
    let judgeFail = 0;
    let present = 0;
    for (const run of runs) {
      const r = run.byName.get(name);
      if (!r) continue;
      present++;
      if (!r.hardPass) hardFail++;
      if (!r.judgePass) judgeFail++;
    }
    out.set(name, { hardFail, judgeFail, present, missing: runs.length - present });
  }
  return out;
}

function aggregate(runs, names) {
  return runs.map((run) => {
    let hard = 0;
    let judge = 0;
    for (const name of names) {
      const r = run.byName.get(name);
      if (!r) continue;
      if (r.hardPass) hard++;
      if (r.judgePass) judge++;
    }
    return { file: run.file, hard, judge, total: run.byName.size };
  });
}

function band(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    spread: sorted[sorted.length - 1] - sorted[0],
  };
}

function reportBand(runs) {
  const names = scenarioNames(runs);
  const rows = aggregate(runs, names);

  console.log(`\n=== NOISE BAND — ${runs.length} runs, ${names.length} scenarios ===\n`);
  for (const r of rows) {
    console.log(`  ${r.file.padEnd(32)} hard ${r.hard}/${names.length}   judge ${r.judge}/${names.length}`);
  }

  const h = band(rows.map((r) => r.hard));
  const j = band(rows.map((r) => r.judge));
  console.log(
    `\n  hard  : ${h.min}-${h.max} of ${names.length}   mean ${h.mean.toFixed(1)}   spread ${h.spread}`
  );
  console.log(
    `  judge : ${j.min}-${j.max} of ${names.length}   mean ${j.mean.toFixed(1)}   spread ${j.spread}`
  );

  const counts = tally(runs, names);
  const flaky = [...counts.entries()]
    .filter(([, c]) => c.hardFail > 0 && c.hardFail < c.present)
    .sort((a, b) => b[1].hardFail - a[1].hardFail);
  const alwaysHardFail = [...counts.entries()].filter(
    ([, c]) => c.present > 0 && c.hardFail === c.present
  );
  const alwaysJudgeFail = [...counts.entries()].filter(
    ([, c]) => c.present > 0 && c.judgeFail === c.present
  );

  console.log(`\n  FLAKY on the hard gate (failed some runs, not all):`);
  if (flaky.length === 0) console.log("    (none)");
  for (const [name, c] of flaky) {
    console.log(`    ${name.padEnd(38)} ${c.hardFail}/${c.present} failed`);
  }

  if (alwaysHardFail.length) {
    console.log(`\n  ALWAYS fails the hard gate — a standing failure, not noise:`);
    for (const [name] of alwaysHardFail) console.log(`    ${name}`);
  }

  if (alwaysJudgeFail.length) {
    console.log(
      `\n  ALWAYS fails the advisory judge — standing, and invisible to the exit code:`
    );
    for (const [name] of alwaysJudgeFail) console.log(`    ${name}`);
  }

  const missing = [...counts.entries()].filter(([, c]) => c.missing > 0);
  if (missing.length) {
    console.log(`\n  NOT PRESENT IN EVERY RUN (the suite is not the same suite):`);
    for (const [name, c] of missing) console.log(`    ${name} — missing from ${c.missing} run(s)`);
  }

  // The practical consequence, spelled out rather than left to the reader.
  console.log(`\n  What this means for a single run:`);
  console.log(
    `    A lone run can land anywhere in ${h.min}-${h.max}. Any gate set inside that band fires on`
  );
  console.log(`    noise; any gate set below it cannot detect a regression smaller than the band.`);
  console.log();
}

function reportCompare(baseline, candidate) {
  const names = scenarioNames([...baseline, ...candidate]);
  const b = tally(baseline, names);
  const c = tally(candidate, names);

  console.log(
    `\n=== ${baseline.length} baseline runs vs ${candidate.length} candidate runs, ${names.length} scenarios ===\n`
  );

  const findings = [];
  for (const name of names) {
    const bb = b.get(name);
    const cc = c.get(name);
    if (bb.present === 0 || cc.present === 0) {
      findings.push({ name, kind: "absent", bb, cc });
      continue;
    }
    const p = fisherOneSided(bb.hardFail, bb.present - bb.hardFail, cc.hardFail, cc.present - cc.hardFail);
    const worse = cc.hardFail / cc.present > bb.hardFail / bb.present;
    if (worse) findings.push({ name, kind: "hard", bb, cc, p });
  }

  const significant = findings.filter((f) => f.kind === "hard" && f.p < ALPHA);
  const watch = findings.filter((f) => f.kind === "hard" && f.p >= ALPHA);
  const absent = findings.filter((f) => f.kind === "absent");

  console.log("  SIGNIFICANT hard-gate regressions (p < 0.05, one-sided Fisher):");
  if (significant.length === 0) console.log("    (none)");
  for (const f of significant) {
    console.log(
      `    ${f.name.padEnd(38)} ${f.bb.hardFail}/${f.bb.present} -> ${f.cc.hardFail}/${f.cc.present} failed   p=${f.p.toFixed(4)}`
    );
  }

  console.log("\n  Worse but NOT significant at this sample size — look, do not act:");
  if (watch.length === 0) console.log("    (none)");
  for (const f of watch) {
    console.log(
      `    ${f.name.padEnd(38)} ${f.bb.hardFail}/${f.bb.present} -> ${f.cc.hardFail}/${f.cc.present} failed   p=${f.p.toFixed(4)}`
    );
  }

  if (absent.length) {
    console.log("\n  MISSING FROM ONE ARM ENTIRELY:");
    for (const f of absent) {
      console.log(`    ${f.name} — baseline ${f.bb.present} runs, candidate ${f.cc.present} runs`);
    }
  }

  console.log(
    `\n  verdict: ${significant.length === 0 ? "no significant hard-gate regression" : `${significant.length} significant regression(s)`}\n`
  );
  return significant.length === 0 && absent.length === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  const bandIdx = argv.indexOf("--band");
  if (bandIdx !== -1) {
    const files = argv.slice(bandIdx + 1).filter((a) => !a.startsWith("--"));
    if (files.length < 2) {
      console.error("--band needs at least 2 result files. Five is what measures a band.");
      process.exit(1);
    }
    reportBand(files.map(load));
    return 0;
  }

  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const baseline = get("--baseline");
  const candidate = get("--candidate");
  if (!baseline || !candidate) {
    console.error(
      "usage:\n" +
        "  node scripts/eval-band.js --band <result.json> <result.json> ...\n" +
        "  node scripts/eval-band.js --baseline a.json,b.json --candidate c.json,d.json"
    );
    process.exit(1);
  }
  return reportCompare(
    baseline.split(",").map((f) => load(f.trim())),
    candidate.split(",").map((f) => load(f.trim()))
  );
}

// Guarded so a test can import the pure statistics above without the CLI
// running — the same shape server.js and the dashboard use for their listeners.
// Without this, `import { fisherOneSided }` would exit the test runner.
if (process.env.NODE_ENV !== "test") {
  process.exit(main());
}

export { fisherOneSided, band, tally, scenarioNames };
