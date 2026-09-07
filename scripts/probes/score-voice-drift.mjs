#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Score the LVX81 blind rating against the withheld mapping.
//
// THROWAWAY. Reads ratings.json (the rater's 40 labels) and the mapping written
// by voice-drift.mjs, joins them, and applies verdicts-voice.json AS WRITTEN.
//
// The rules are not re-derived here and must not be. They were pre-registered
// before the first session opened, and the whole value of pre-registering them
// is that neither the rater nor the reader gets to move them after seeing which
// arm is which.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || join(process.cwd(), "voice-drift");
const ratings = JSON.parse(readFileSync(process.argv[3] || join(OUT, "ratings.json"), "utf8"));
const mapping = JSON.parse(readFileSync(join(OUT, "_mapping", "mapping.json"), "utf8"));
const verdicts = JSON.parse(readFileSync(join(process.cwd(), "scripts/probes/verdicts-voice.json"), "utf8"));

const INCUMBENT = verdicts.arms.incumbent;

const byVoice = new Map();
let unrated = 0;
for (const row of mapping) {
  if (!row.hash) continue;
  const label = ratings[row.label];
  if (!label) {
    unrated += 1;
    continue;
  }
  if (!byVoice.has(row.voice)) byVoice.set(row.voice, []);
  byVoice.get(row.voice).push({ take: row.label, label });
}

console.log("\n  LVX81 — blind rating scored against the pre-registered verdicts");
console.log("  ================================================================\n");

// ---------------------------------------------------------------------------
// The rating instrument checks itself first.
//
// A rater who marks nearly everything the same has not necessarily heard
// nearly-identical audio -- they may simply not be discriminating. That
// possibility has to be reported BEFORE any verdict is read off the numbers,
// because every verdict below assumes the labels carry information.
// ---------------------------------------------------------------------------
const all = Object.values(ratings);
const spread = new Map();
for (const v of all) spread.set(v, (spread.get(v) || 0) + 1);
const dominant = [...spread.entries()].sort((a, b) => b[1] - a[1])[0];
const share = dominant[1] / all.length;

console.log("  RATING SPREAD");
for (const [k, n] of [...spread.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(k).padEnd(16)} ${String(n).padStart(3)}  ${"#".repeat(n)}`);
}
if (share >= 0.9) {
  console.log(`\n    ${(share * 100).toFixed(0)}% of takes carry one label. Two readings fit that and`);
  console.log("    this data cannot separate them: the audio really was that uniform,");
  console.log("    or the rating did not discriminate. Weigh every verdict below");
  console.log("    against that, and note the rig did NOT reproduce the reported");
  console.log("    defect -- which is itself the most important thing here.");
}
if (unrated) console.log(`\n    ${unrated} rendered takes carry no rating.`);

// ---------------------------------------------------------------------------
console.log("\n  PER VOICE");
const summary = [];
for (const [voice, takes] of [...byVoice.entries()].sort()) {
  const counts = new Map();
  for (const t of takes) counts.set(t.label, (counts.get(t.label) || 0) + 1);
  const distinct = counts.size;
  const detail = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  const allBritish = counts.get("british") === takes.length;
  summary.push({ voice, takes: takes.length, distinct, allBritish, counts });
  const flag = distinct > 1 ? "SCATTERED" : allBritish ? "all british" : `all ${[...counts.keys()][0]}`;
  console.log(
    `    ${voice.padEnd(9)} ${String(takes.length).padStart(2)} takes  ${flag.padEnd(12)}  ${detail}`
  );
}

const inc = summary.find((s) => s.voice === INCUMBENT);

// ---------------------------------------------------------------------------
console.log("\n  VERDICTS, applied as written\n");

// V1
const v1Confirmed = inc && inc.distinct > 1;
console.log(`  V1  is session-level drift the mechanism?`);
console.log(`      ${INCUMBENT}'s ${inc ? inc.takes : 0} takes fall in ${inc ? inc.distinct : 0} categor${inc && inc.distinct === 1 ? "y" : "ies"}.`);
if (v1Confirmed) {
  console.log("      CONFIRMED. The same pinned voice reads differently between sessions.");
} else {
  console.log("      REFUTED, by the rule written before the run:");
  console.log(`      "${verdicts.verdicts.V1_is_session_drift_the_mechanism.if_refuted}"`);
}

// V2
console.log(`\n  V2  does any candidate beat ${INCUMBENT}?`);
const incClean = inc && inc.allBritish;
const winners = summary.filter((s) => s.voice !== INCUMBENT && s.allBritish);
if (incClean) {
  console.log(`      No. The rule requires a candidate to be five-of-five british AND`);
  console.log(`      ${INCUMBENT} not to be. ${INCUMBENT} is. No candidate can win on this data.`);
  console.log("      The incumbent stays, and no preference is written down as a decision.");
} else if (winners.length) {
  console.log(`      Candidates clean where ${INCUMBENT} is not: ${winners.map((w) => w.voice).join(", ")}`);
} else {
  console.log("      No candidate is five-of-five. Nothing wins.");
}

// V3
const anyClean = summary.some((s) => s.distinct === 1);
console.log(`\n  V3  does Live have a fix at all?`);
if (!anyClean) {
  console.log("      CONFIRMED — no voice is five-of-five in one category.");
  console.log(`      "${verdicts.verdicts.V3_does_live_have_a_fix_at_all.means}"`);
} else {
  const clean = summary.filter((s) => s.distinct === 1).map((s) => s.voice);
  console.log(`      Not confirmed. Voices consistent across all takes: ${clean.join(", ")}`);
}

console.log("\n  ----------------------------------------------------------------");
console.log("  What this round CANNOT say, from verdicts-voice.json:");
for (const line of verdicts.what_this_cannot_answer) console.log(`    - ${line}`);
console.log("");
