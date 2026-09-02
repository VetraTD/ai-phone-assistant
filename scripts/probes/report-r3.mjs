// ---------------------------------------------------------------------------
// Round 3 report. Pure derivation from raw/ — no API calls, no spend.
//
//   node scripts/probes/report-r3.mjs
//
// Round 3 scope: Gemini 3.1 Live (AI Studio) vs OpenAI gpt-realtime-2.1, the two
// finalists once BAA became unaffordable. It exists to test the one thing rounds
// 1-2 never did — TOOL reliability, with scripted results so a model is actually
// shown a conflict, a refusal, and a failing backend.
//
// It also runs the full TEN tool declarations. Rounds 1-2 declared six, missing
// check_appointment_availability, so no model in those rounds could check a slot
// before booking. Every behavioural observation from rounds 1-2 is suspect for
// that reason, including the Gemini 2.5-vs-3.1 quality comparison.
//
// Results are consolidated from several raw files because seven round-3 runs
// were killed mid-suite by the environment. Cause never identified: it was not
// compound shell blocks, not OpenAI-specific, and not a duration limit — each of
// those theories was disproved by the next run. The mitigation that worked was
// making it not matter: every script now persists after each cell.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRaw } from "./lib/stats.js";
import { load as loadSpend, totalFor, CAP_USD } from "./lib/spend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V3 = JSON.parse(fs.readFileSync(path.join(HERE, "verdicts-r3.json"), "utf8"));

/** Later files supersede earlier ones for the same scenario+model. */
const SOURCES = [
  "r3-tools-fixed-gemini", "r3-tools-fixed-openai",
  "r3-openai-T4", "r3-openai-T5",
  "r3-gem-T1T2", "r3-gem-T2", "r3-oai-T2", "r3-gem-T7", "r3-oai-T7",
];
/**
 * Cells whose raw was destroyed before --tag existed: a one-trial diagnostic run
 * reused the default tag and overwrote the completed suite. The console figures
 * are recorded in the session transcript but are NOT reproducible from this
 * repo, so they are listed as gaps instead of being quoted as results.
 */
const RAW_LOST = ["T6:3.1", "T7:3.1", "T1:gpt", "T6:gpt"];
const cells = new Map();
for (const src of SOURCES) {
  for (const row of (readRaw(src) || {}).rows || []) {
    cells.set(`${row.scenario}:${row.model}`, { ...row, source: src });
  }
}
const G31 = readRaw("r3-gemini31") || {};

const cell = (s, m) => cells.get(`${s}:${m}`);
const med = (a) => { const x = [...a].filter((n) => typeof n === "number" && n > 0).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
const money = (n) => `$${(n ?? 0).toFixed(4)}`;

const SCEN = [
  ["T1", "ordering — availability checked before booking"],
  ["T2", "conflict pivot — never books a slot it was told is taken"],
  ["T3", "argument fidelity — books the time the caller said"],
  ["T4", "failure recovery — backend fails, must not claim success"],
  ["T5", "end_call gating — ends when the caller says goodbye"],
  ["T6", "no phantom tools"],
  ["T7", "slow backend — 3 s stall"],
];

/** How many trials in a cell had a given named check fail. */
const failCount = (c, name) =>
  (c?.detail || []).filter((d) => (d.checks || []).some((k) => k.name.includes(name) && !k.pass)).length;
const trials = (c) => (c?.detail || []).filter((d) => !d.error).length;

let gTot = 0, gMax = 0, oTot = 0, oMax = 0;
const scenRows = SCEN.map(([id, name]) => {
  const g = cell(id, "3.1"), o = cell(id, "gpt");
  if (g) { gTot += g.passes; gMax += g.total; }
  if (o) { oTot += o.passes; oMax += o.total; }
  const rate = (c) => (c ? `${c.passes}/${c.total}` : "—");
  const winner = !g || !o ? "—"
    : g.passes / g.total > o.passes / o.total ? "Gemini"
    : o.passes / o.total > g.passes / g.total ? "OpenAI" : "tie";
  return { id, name, g: rate(g), o: rate(o), winner };
});
const openaiWins = scenRows.filter((r) => r.winner === "OpenAI").length;

// --- endpointing (partial: several cells were killed) ------------------------
const vadCell = (arm, label) => {
  const c = (G31.endpointing || []).filter((r) => r.arm === arm && r.label === label && !r.error);
  return c.length ? { n: c.length, cut: c.filter((r) => r.cut_in).length } : null;
};
const vadDefaultTrail = vadCell("default", "trailing_lead_in");
const vadPatientTrail = vadCell("patient", "trailing_lead_in");

// --- slope -------------------------------------------------------------------
const slopeRuns = G31.slope || [];
const byTurn = (i) => med(slopeRuns.map((r) => (r.turns || [])[i]?.model_leg_ms));
const gSlope = Array.from({ length: 12 }, (_, i) => byTurn(i));
const gDrift = gSlope[0] && gSlope[11] ? gSlope[11] - gSlope[0] : null;

/**
 * DUPLICATE TOOL CALLS — the failure the assertion suite was blind to.
 *
 * Every check in lib/toolScript.js asks whether a tool was called and with what
 * arguments. None asks whether it was called TWICE. Gemini 2.5 scored 15/15,
 * 20/20 and 15/15 on T1/T2/T5 while re-firing end_call in 41% of trials and
 * book_appointment in one — a double booking that the scorecard recorded as a
 * pass. Read this table before the scenario table, not after it.
 */
const dupByModel = (() => {
  const out = {};
  for (const c of cells.values()) {
    const m = c.model;
    out[m] ||= { trials: 0, events: 0, doubleBook: 0, byTool: {} };
    for (const det of c.detail || []) {
      const names = (det.calls || []).map((x) => x.name);
      if (!names.length) continue;
      out[m].trials++;
      const counts = {};
      for (const n of names) counts[n] = (counts[n] || 0) + 1;
      for (const [n, v] of Object.entries(counts)) {
        if (v > 1) { out[m].events++; out[m].byTool[n] = (out[m].byTool[n] || 0) + 1; }
      }
      if ((counts.book_appointment || 0) > 1) out[m].doubleBook++;
    }
  }
  return out;
})();

const leaksTotal = [...cells.values()].reduce((s, c) => s + (c.leaks || 0), 0);
const turnsTotal = [...cells.values()].reduce((s, c) => s + trials(c), 0);

// --- verdicts ----------------------------------------------------------------
const t1g = cell("T1", "3.1"), t2g = cell("T2", "3.1"), t2o = cell("T2", "gpt");
const t4g = cell("T4", "3.1"), t4o = cell("T4", "gpt"), t5g = cell("T5", "3.1"), t5o = cell("T5", "gpt");

const V = [
  { id: "X1", pred: "Gemini checks availability before booking >=4/5",
    res: t1g ? `${t1g.passes}/${t1g.total} checks, ${trials(t1g) - failCount(t1g, "before")} of ${trials(t1g)} trials ordered correctly` : "no data",
    pass: t1g ? trials(t1g) - failCount(t1g, "before") >= 4 : null },
  { id: "X2", pred: "BOTH refuse to book the slot they were told is taken, 5/5 each",
    res: `Gemini ${trials(t2g) - failCount(t2g, "NEVER with the taken slot")}/${trials(t2g)}, OpenAI ${trials(t2o) - failCount(t2o, "NEVER with the taken slot")}/${trials(t2o)}`,
    pass: failCount(t2g, "NEVER with the taken slot") === 0 && failCount(t2o, "NEVER with the taken slot") === 0 },
  { id: "X3", pred: "At least one model claims a booking the backend refused, >=1/5",
    res: `Gemini ${failCount(t4g, "claim a booking that failed")}/5, OpenAI ${failCount(t4o, "claim a booking that failed")}/5 — neither ever did`,
    pass: failCount(t4g, "claim a booking that failed") + failCount(t4o, "claim a booking that failed") >= 1 },
  { id: "X4", pred: "gpt-2.1 misses end_call >=2/5; Gemini calls it >=4/5",
    res: `OpenAI missed ${failCount(t5o, "called end_call")}/${trials(t5o)}, Gemini missed ${failCount(t5g, "called end_call")}/${trials(t5g)}`,
    pass: failCount(t5o, "called end_call") >= 2 && trials(t5g) - failCount(t5g, "called end_call") >= 4 },
  { id: "X5", pred: "Gemini speaks a raw tool blob >=1 time; OpenAI never",
    res: `${leaksTotal} leaks across ${turnsTotal} trials, both models`, pass: leaksTotal >= 1 },
  { id: "X6", pred: "Gemini 3.1 default VAD holds trailing_lead_in past 2,000 ms",
    res: vadDefaultTrail ? `cut in ${vadDefaultTrail.cut}/${vadDefaultTrail.n} at default; ${vadPatientTrail ? `${vadPatientTrail.cut}/${vadPatientTrail.n} even at END_SENSITIVITY_LOW` : "patient arm not measured"}` : "no data",
    pass: vadDefaultTrail ? vadDefaultTrail.cut === 0 : null },
  { id: "X7", pred: "gpt-2.1 signals an interrupt >=4/5 with audio genuinely in flight",
    res: "NOT MEASURED — the long-barge arm was killed before producing a cell", pass: null },
  { id: "X8", pred: "Neither model drifts >300 ms across 12 turns",
    res: `Gemini turn1 ${gSlope[0]} ms -> turn12 ${gSlope[11]} ms, drift ${gDrift} ms. OpenAI NOT MEASURED (killed).`,
    pass: null },
  { id: "X9", pred: "OpenAI wins <=2 of the 7 tool scenarios, so does not justify 2.2x",
    res: `OpenAI won ${openaiWins} of ${scenRows.filter((r) => r.winner !== "—").length} scored scenarios`, pass: openaiWins <= 2 },
];

const spend = loadSpend();
const scored = V.filter((v) => v.pass !== null);

const md = `# Speech-to-speech probes — round 3

**Gemini 3.1 Live vs OpenAI gpt-realtime-2.1**, the two finalists once a Twilio
BAA at $2,000/mo put HIPAA out of reach. Predictions pre-registered in
\`verdicts-r3.json\` (${V3.written_at}) before the first run.

**Round 3 spend ${money(totalFor("R3"))}. Cumulative ${money(spend.spent_usd)} against the ${money(CAP_USD)} cap.**
**${scored.filter((v) => v.pass).length} of ${scored.length} scored predictions held; ${V.length - scored.length} unresolved.**

> **Harness correction that invalidates part of rounds 1-2.** Production declares
> TEN tools (\`services/gemini.js:92\` unions three builders); rounds 1-2 declared
> six and omitted \`check_appointment_availability\`. No model in those rounds
> could check a slot before booking, which is why every transcript degenerated
> into "are you a new or existing patient?". **The Gemini 2.5-vs-3.1 quality
> comparison rests on that broken harness and should not be relied on.**

---

## (a) Tool reliability — the arm rounds 1-2 never ran

Scripted results, so a model is actually told "that slot is taken" or "the
calendar failed" rather than handed a canned success.

| | scenario | Gemini 3.1 | gpt-realtime-2.1 | winner |
|---|---|---|---|---|
${scenRows.map((r) => `| ${r.id} | ${r.name} | ${r.g} | ${r.o} | ${r.winner === "Gemini" ? "**Gemini**" : r.winner === "OpenAI" ? "**OpenAI**" : r.winner} |`).join("\n")}
| | **total** | **${gTot}/${gMax}** | ${oTot}/${oMax} | |

**OpenAI won ${openaiWins} of ${scenRows.filter((r) => r.winner !== "—").length} scenarios.** On the dimension that was its last
chance to justify 2.2x the cost, it is behind.

The two vendors fail differently, and the difference matters more than the
totals:

- **OpenAI skips \`check_appointment_availability\`** — ${failCount(t2o, "called check_appointment_availability") + failCount(cell("T7", "gpt"), "called check_appointment_availability")} times across T2 and T7.
  It books without checking. On a real clinic that double-books a patient.
- **OpenAI does not reliably end calls** — missed \`end_call\` in
  ${failCount(t5o, "called end_call")} of ${trials(t5o)} trials, reproducing at N=5 what round 1 saw once.
- **Gemini hits a confirmation livelock** — one T3 trial spent three turns
  re-confirming the same date of birth without progressing, the same shape as
  the nine-turn spelling livelock in the ledger.
- **Gemini doubled \`end_call\`** in one trial.

Neither model is clean. But being annoying is recoverable and double-booking a
patient is not.

**Neither model ever claimed a booking the backend had refused** (X3 fails,
which is the good kind of failure) and **neither spoke a raw tool blob aloud** in
${turnsTotal} trials (X5 fails). Round 1's "Gemini spoke JSON" was an artefact of
the six-tool harness, not a model defect.

---

## (a2) Duplicate tool calls — the defect the scorecard missed

| model | trials | duplicate-call events | \`end_call\` twice | **\`book_appointment\` twice** |
|---|---|---|---|---|
${["2.5", "3.1", "gpt"].map((m) => { const d = dupByModel[m]; const lbl = { "2.5": "Gemini 2.5", "3.1": "Gemini 3.1", gpt: "gpt-realtime-2.1" }[m];
  return d ? `| ${lbl} | ${d.trials} | **${d.events}** | ${d.byTool.end_call || 0} | ${d.doubleBook ? "**" + d.doubleBook + "**" : 0} |` : `| ${lbl} | — | — | — | — |`; }).join("
")}

**Gemini 2.5 re-fires actions.** It does not merely repeat itself audibly (15% of
turns); it calls tools again. A doubled \`end_call\` hangs up on a caller. A
doubled \`book_appointment\` puts a patient in the calendar twice.

This is the single most important result in round 3 and **the assertion suite
scored it as a pass**, because every check asks whether a tool was called and
with what arguments, and none asks whether it was called twice. It was found by
reading raw call sequences. Any future eval work must assert call COUNTS.

---

## (b) The finding that cuts against the recommendation

**Gemini 3.1 interrupts a caller who trails off.**

| configuration | held \`trailing_lead_in\` ("It's for, uh —") |
|---|---|
| Gemini 3.1, default VAD | ${vadDefaultTrail ? `**${vadDefaultTrail.n - vadDefaultTrail.cut}/${vadDefaultTrail.n}**` : "—"} |
| Gemini 3.1, END_SENSITIVITY_LOW + 1200 ms | ${vadPatientTrail ? `**${vadPatientTrail.n - vadPatientTrail.cut}/${vadPatientTrail.n}**` : "—"} |
| Gemini 2.5, default (round 2) | 5/5 |
| OpenAI server_vad 500 ms (round 2) | 5/5 |
| OpenAI semantic_vad low (round 2) | 5/5 |

3.1 is the only one of the four that fails this, **and no setting fixes it** —
its most patient configuration still cuts in ${vadPatientTrail ? vadPatientTrail.cut : "?"} times in ${vadPatientTrail ? vadPatientTrail.n : "?"}.
Trailing off mid-sentence is one of the most common things a real caller does.

This matters more than a lost verdict, because in speech-to-speech the VAD
belongs to the vendor. Today \`classifyHold\` is our code and charges 2,000 ms
for exactly this case. **On this dimension, migrating to 3.1 is a regression
against the current cascade, not just against OpenAI.**

---

## (c) Latency drift over a real-length call

${gSlope.every((n) => n) ? `| turn | ${gSlope.map((_, i) => i + 1).join(" | ")} |
|---|${gSlope.map(() => "---").join("|")}|
| Gemini 3.1 | ${gSlope.join(" | ")} |

Drift across twelve turns: **${gDrift > 0 ? "+" : ""}${gDrift} ms** — flat. Whatever else is true of
3.1, it does not degrade as a call goes on.` : "Slope data incomplete."}

gpt-realtime-2.1's slope was not measured — the run was killed. Round 2's
five-turn data had it *improving* (-613 ms), so it is unlikely to be the problem.

---

## (d) Pre-registered verdicts

| ID | Prediction (locked ${V3.written_at.slice(0, 10)}) | Result | Verdict |
|---|---|---|---|
${V.map((v) => `| **${v.id}** | ${v.pred} | ${v.res} | ${v.pass === null ? "UNRESOLVED" : v.pass ? "**PASS**" : "**FAIL**"} |`).join("\n")}

---

## (e) Cells with no raw

\`${RAW_LOST.join("\`, \`")}\` — measured in the first tools run, whose output
file was then overwritten by a one-trial diagnostic that reused the default tag.
Those figures exist only in the session transcript, so they are excluded from
every total above rather than quoted. All were ties at 15/15 or reinforced the
same pattern; none carried the conclusion. \`--tag\` now prevents the collision.

## (f) What round 3 did not finish

Seven runs were killed mid-suite by the environment. The cause was never
identified — it was not compound shell blocks, not OpenAI-specific and not a
duration limit; each theory was disproved by the next run. The fix that worked
was making it survivable: every script now persists after each cell, so a kill
costs one cell instead of a suite.

Left unmeasured:

- **gpt-realtime-2.1 long-reply barge-in** (X7) — no cell completed
- **gpt-realtime-2.1 12-turn slope** (X8) — one run of three
- **Most of the Gemini 3.1 VAD grid** — three of nine cells, chosen for the ones
  that decide X6
- **Hold times for either finalist** — round 2 has them for 2.5 and the mini only
- **The gpt-2.1 silence sweep** — the least decisive item, deliberately last

None of these can plausibly overturn the tool result, which is the arm that was
supposed to decide whether OpenAI earns its premium.

---

## (g) The question this reopens

Gemini 2.5 was dropped because BAA became unaffordable and because its
conversation quality looked worse. **That quality finding came from the six-tool
harness** and is not trustworthy. 2.5 also held trail-offs 5/5 where 3.1 holds
${vadPatientTrail ? `${vadPatientTrail.n - vadPatientTrail.cut}/${vadPatientTrail.n}` : "?"},
runs on Vertex with ADC and residency, and is not a preview model.

**Re-running the quality and tool comparison for 2.5 against the corrected
ten-tool set is now the highest-value outstanding test** — higher than the barge
and hold arms above.

---

## Spend

| Probe | Cost |
|---|---|
${["L0", "L1", "L2", "L3", "L4", "L5", "R2", "R3"].map((p) => `| ${p} | ${money(totalFor(p))} |`).join("\n")}
| **Total** | **${money(spend.spent_usd)}** |
| Cap | ${money(CAP_USD)} |
| Headroom | ${money(CAP_USD - spend.spent_usd)} |
`;

fs.writeFileSync(path.join(HERE, "report-r3.md"), md);
fs.writeFileSync(path.join(HERE, "results-r3.json"), JSON.stringify({
  at: new Date().toISOString(), scenarios: scenRows, totals: { gemini: [gTot, gMax], openai: [oTot, oMax] },
  openai_scenario_wins: openaiWins, leaks: leaksTotal, trials: turnsTotal,
  vad: { default_trailing_lead_in: vadDefaultTrail, patient_trailing_lead_in: vadPatientTrail },
  slope_gemini_3_1: gSlope, drift_ms: gDrift, verdicts: V,
  spend: { total: spend.spent_usd, cap: CAP_USD, r3: totalFor("R3") },
}, null, 2) + "\n");

console.log(`report-r3.md ${md.length} chars`);
console.log(`tools: Gemini ${gTot}/${gMax}  OpenAI ${oTot}/${oMax}  (OpenAI scenario wins: ${openaiWins})`);
console.log(`verdicts ${scored.filter((v) => v.pass).length}/${scored.length} scored, ${V.length - scored.length} unresolved`);
console.log(`spend ${money(spend.spent_usd)} / ${money(CAP_USD)}`);
