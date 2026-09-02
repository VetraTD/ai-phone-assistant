// ---------------------------------------------------------------------------
// Round 2 report. Pure derivation from raw/ — no API calls, no spend.
//
//   node scripts/probes/report-r2.mjs
//
// Round 2 exists because round 1 was asymmetric and, in one place, wrong. It
// scored a binary "did the vendor respond inside classifyHold's window?" and
// called a "no" a win. The hold-time diagnostic here shows what those "no"s
// actually were, and one of them is a 9.7-second dead-air hang that round 1
// recorded as V4's passing cell.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRaw } from "./lib/stats.js";
import { load as loadSpend, totalFor, CAP_USD } from "./lib/spend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2 = JSON.parse(fs.readFileSync(path.join(HERE, "verdicts-r2.json"), "utf8"));

const G = readRaw("r2-gemini") || {};
const HOLD = readRaw("r2-holdtime") || {};
const OA_MINI = readRaw("r2-openai-gpt-realtime-2.1-mini") || {};
const OA_FULL = readRaw("r2-openai-gpt-realtime-2.1") || {};
const DISC = readRaw("r2-discover") || {};
const L1 = readRaw("l1-gemini") || {};
const L2 = readRaw("l2-openai-mini") || {};
const L3 = readRaw("l3-openai-full") || {};

const med = (a) => { const s = [...a].filter((n) => typeof n === "number" && n > 0).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const money = (n) => `$${(n ?? 0).toFixed(4)}`;
const legsOf = (rows) => (rows || []).flatMap((c) => (c.turns || []).map((t) => t.model_leg_ms)).filter((n) => n > 0);

// --- hold-time table ---------------------------------------------------------
const holdCell = (vendor, arm, label) => {
  const c = (HOLD.rows || []).filter((r) => r.vendor === vendor && r.arm === arm && r.label === label && !r.error);
  return { n: c.length, responded: c.filter((r) => r.responded).length, p50: med(c.map((r) => r.hold_ms)) };
};
const FIX = ["no_terminal_punct", "trailing_lead_in", "partial_digits"];
const HOLD_ARMS = [
  ["gemini", "default", "Gemini · default VAD"],
  ["gemini", "patient", "Gemini · END_SENSITIVITY_LOW, 1200 ms"],
  ["openai", "server:500", "OpenAI · server_vad 500 ms"],
  ["openai", "semantic:low", "OpenAI · semantic_vad low"],
];

// --- endpointing grid --------------------------------------------------------
const gGrid = (arm, label) => {
  const c = (G.endpointing || []).filter((r) => r.arm === arm && r.label === label && !r.error);
  return { n: c.length, cut: c.filter((r) => r.cut_in).length };
};
const oGrid = (e, label) => {
  const c = ((L2.vad) || []).filter((r) => r.eagerness === e && r.label === label && !r.error);
  return { n: c.length, cut: c.filter((r) => r.cut_in).length };
};

// --- latency -----------------------------------------------------------------
const gLegs = legsOf(G.conversations);
const gGen = (G.split || []).map((r) => r.generation_ms).filter((n) => n > 0);
const silenceCells = [200, 300, 500].map((ms) => {
  const rows = (OA_MINI.silence || []).filter((r) => r.silence_ms === ms);
  const legs = legsOf(rows);
  const commits = rows.flatMap((r) => (r.turns || []).map((t) => t.commit_ms)).filter((n) => n > 0);
  const miss = rows.flatMap((r) => (r.turns || []).map((t) => t.model_leg_ms)).filter((n) => n == null).length;
  return { ms, leg: med(legs), endpoint: med(commits), n: legs.length, miss };
});
const fullLegs = legsOf(OA_FULL.conversations || L3.conversations);

/**
 * Per-turn-index medians. The single most decision-relevant view in round 2:
 * a p50 over a whole conversation hides whether a vendor is flat or sloping,
 * and a receptionist call is 10-15 turns, so the number that matters is the one
 * at the END of the call rather than the middle.
 */
const byTurn = (rows) => Array.from({ length: 5 }, (_, i) =>
  med((rows || []).map((c) => (c.turns || [])[i]?.model_leg_ms)));
const gByTurn = byTurn(G.conversations);
const mByTurn = byTurn((OA_MINI.silence || []).filter((r) => r.silence_ms === 200));
const fByTurn = byTurn(OA_FULL.conversations || L3.conversations);
const slope = (a) => (a[0] && a[4] ? a[4] - a[0] : null);
const fullMiss = (OA_FULL.conversations || L3.conversations || []).flatMap((c) => (c.turns || []).map((t) => t.model_leg_ms)).filter((n) => n == null).length;

// --- barge -------------------------------------------------------------------
const gBarge = (G.longbarge || []).filter((r) => r.barged);
const oBarge = (OA_MINI.longbarge || []).filter((r) => r.barged);
const tailRows = (rows, key) => rows.filter((r) => r.audio_after_interrupt);

// --- cost --------------------------------------------------------------------
const perTurn = (rows) => {
  const c = (rows || []).filter((r) => r.usd && r.turns?.length);
  return c.length ? mean(c.map((r) => r.usd)) / 5 : 0;
};
const gPerTurn = perTurn(G.conversations);
const oPerTurn = perTurn(L2.conversations);
const fPerTurn = perTurn(OA_FULL.conversations || L3.conversations);

const spend = loadSpend();

// --- verdict scoring ---------------------------------------------------------
const w1 = ["no_terminal_punct", "trailing_lead_in"].every((l) => gGrid("patient", l).n - gGrid("patient", l).cut >= 4);
const w2 = gGrid("default", "trailing_lead_in").cut >= 3;
const w3 = med(gGen) < 700;
const w4 = (silenceCells.find((c) => c.ms === 200)?.leg ?? 1e9) < 1500;
const gTail = tailRows(gBarge).length, oTail = tailRows(oBarge).length;
const w5 = Math.max(gTail, oTail) >= 3;
const w6 = med(fullLegs) < 1600 && fullMiss === 0;
const w7 = gPerTurn < 0.00481;

const results = [
  { id: "W1", pred: "Gemini at its most patient VAD holds no_terminal_punct AND trailing_lead_in >=4/5",
    res: `patient held ${5 - gGrid("patient", "no_terminal_punct").cut}/5 and ${5 - gGrid("patient", "trailing_lead_in").cut}/5`, pass: w1,
    note: `True as a binary — but the hold-time diagnostic shows "held" here means ${holdCell("gemini", "patient", "no_terminal_punct").p50} ms and ${holdCell("gemini", "patient", "trailing_lead_in").p50} ms of silence. Patience and dead air are the same measurement until you time them.` },
  { id: "W2", pred: "Gemini's DEFAULT VAD cuts into trailing_lead_in >=3/5", res: `cut in ${gGrid("default", "trailing_lead_in").cut}/5`, pass: w2,
    note: `Wrong in the useful direction: the default holds trailing_lead_in for ${holdCell("gemini", "default", "trailing_lead_in").p50} ms, past the 2,000 ms our own classifyHold charges. It cut into no_terminal_punct instead (${gGrid("default", "no_terminal_punct").cut}/5).` },
  { id: "W3", pred: "Gemini pure generation (manual activityEnd) p50 < 700 ms", res: `${med(gGen)} ms (n=${gGen.length})`, pass: w3,
    note: `Like-for-like on a fresh single turn, Gemini generates SLOWER than OpenAI's ~790 ms, so Gemini's total-leg lead is endpointing (~${Math.max(0, med(gLegs) - med(gGen))} ms) and not the model. But single-turn is OpenAI's best case only: in a real conversation the mini's generation grows to ~1,480 ms by turn 5 while Gemini's stays flat. Neither number generalises without the slope table above.` },
  { id: "W4", pred: "OpenAI mini at silence_duration_ms=200 gets leg p50 < 1,500 ms", res: silenceCells.map((c) => `${c.ms}ms->${c.leg}ms`).join(", "), pass: w4,
    note: `Endpointing tracks the setting exactly (${silenceCells.map((c) => c.endpoint + "ms@" + c.ms).join(", ")}), so the knob works. The leg still misses 1,500 ms because the mini's GENERATION grows through the call — turn 1 is ${mByTurn[0]} ms, turn 5 is ${mByTurn[4]} ms. Round 1 blamed the vendor for a number this harness set; round 2 shows the setting was only part of it.` },
  { id: "W5", pred: "Against a LONG reply, audio keeps arriving after the interrupt signal in >=3/5 on at least one vendor",
    res: `Gemini ${gTail}/${gBarge.length}, OpenAI ${oTail}/${oBarge.length}`, pass: w5,
    note: `Both vendors mostly stop cleanly. But Gemini's worst trial delivered ${Math.max(0, ...gBarge.map((r) => r.ms_of_audio_after_interrupt || 0))} ms of audio AFTER announcing the interrupt — a tail a playout queue must still absorb.` },
  { id: "W6", pred: "OpenAI full at N=5 holds leg p50 < 1,600 ms with 0 dropped turns", res: `${med(fullLegs)} ms p50 (n=${fullLegs.length}), ${fullMiss} dropped`, pass: w6,
    note: `Latency clause held (${med(fullLegs)} ms < 1,600); the reliability clause did not — ${fullMiss} turns produced no audio. Round 1's N=1 gave 1,375 ms and zero drops, which PLAN.md correctly said was "compared to nothing". Unlike the mini, the full model gets FASTER through a call (${slope(fByTurn)} ms).` },
  { id: "W7", pred: `Gemini 2.5 on Vertex costs less per turn than OpenAI mini (${money(0.00481)})`, res: `${money(gPerTurn)} vs ${money(oPerTurn)}`, pass: w7,
    note: `Round 1's ${money(0.00444)} was an artefact of L5's shorter 4-turn script. On the identical 5-turn script the two vendors are within 2% — cost is a tie, not an argument.` },
];

// --- write -------------------------------------------------------------------
const md = `# Speech-to-speech probes — round 2

Closes the gaps round 1 left, on both vendors. Predictions pre-registered in
\`verdicts-r2.json\` (${V2.written_at}) before any round-2 measurement except
phase-A discovery, which is enumeration and is recorded as finding F1.

**Round 2 spend ${money(totalFor("R2"))}. Cumulative ${money(spend.spent_usd)} against the ${money(CAP_USD)} cap.**

**${results.filter((r) => r.pass).length} of ${results.length} round-2 predictions held.**

---

## The three things that changed the answer

### 1. There is only one deployable Gemini, and it is not the one round 1 measured

${DISC.grid ? `Phase-A discovery connected ${Object.keys(DISC.grid).length} model/region cells. Three reachable:` : ""}

- \`gemini-live-2.5-flash-native-audio\` — Vertex **europe-west1** (Belgium) and us-central1
- \`gemini-3.1-flash-live-preview\` — **AI Studio only** (consumer API key)

**\`europe-west2\` (London) serves no Live model at all.** Every candidate fails
the WebSocket upgrade with an HTTP 400 from the Google frontend; the bidi path is
not routed in that region. So a "your data stays in the UK" promise cannot be met
by Gemini Live — the closest is Belgium.

And round 1's headline Gemini numbers (1,043 ms, \$0.0067/turn) came from the
3.1 preview on AI Studio: **not a residency path, not a BAA path, and a preview
model.** Everything in round 2 runs on the surface that could actually ship.

### 2. Gemini does not generate faster than OpenAI. It endpoints faster.

With automatic VAD disabled and an explicit \`activityEnd\`, Gemini's pure
generation time is **${med(gGen)} ms** — *slower* than OpenAI's ~790 ms.

| | Gemini 2.5 (Vertex) | OpenAI mini |
|---|---|---|
| pure generation | **${med(gGen)} ms** | ~790 ms |
| endpointing, complete utterance | ~${Math.max(0, med(gLegs) - med(gGen))} ms | ${silenceCells.map((c) => `${c.endpoint} ms @${c.ms}`).join(" · ")} |
| total model leg | ${med(gLegs)} ms | ${silenceCells.map((c) => `${c.leg} @${c.ms}ms`).join(" · ")} |

Round 1 reported OpenAI as ~940 ms slower and I attributed it to the model. It
was \`silence_duration_ms: 500\`, a value this harness chose for OpenAI while
leaving Gemini's VAD at its default. Sweeping it${w4 ? " closes most of the gap" : " does not close the gap"}.

### 3. round 1's V4 "pass" was a 9.7-second hang

Both round-1 and the first round-2 endpointing arm scored a binary: did the
vendor answer inside the window \`classifyHold\` charges? A "no" was scored as
"correctly waited". A "no" also covers "the caller got silence and nothing
happened", and those are opposite outcomes.

Timing the holds instead of counting them:

| configuration | ${FIX.map((f) => "`" + f + "`").join(" | ")} |
|---|${FIX.map(() => "---").join("|")}|
${HOLD_ARMS.map(([v, a, name]) => `| ${name} | ${FIX.map((f) => { const c = holdCell(v, a, f); return c.p50 ? `${c.p50} ms` : "—"; }).join(" | ")} |`).join("\n")}

Every cell responded — nothing was inert, so no earlier result was measuring a
dead session. But **OpenAI's \`semantic_vad\` at \`low\` holds for ${holdCell("openai", "semantic:low", "no_terminal_punct").p50} ms and
${holdCell("openai", "semantic:low", "partial_digits").p50} ms.** On a phone call that is not patience, it is a caller
saying "Next Tuesday afternoon works" and hearing nine seconds of nothing.
Round 1 scored that cell as V4 passing.

On sane settings the two vendors converge: Gemini's default and OpenAI's
\`server_vad\` at 500 ms both hold between ~1.3 s and ~2.6 s — which is roughly
what our own \`classifyHold\` already charges. **Neither vendor solves
endpointing; both approximately reproduce what we do today.**

---

## The slope, not the median

A p50 across a conversation hides the shape. Per-turn-index medians:

| turn | 1 | 2 | 3 | 4 | 5 | drift |
|---|---|---|---|---|---|---|
| **Gemini 2.5 · Vertex** | ${gByTurn.map((n) => n ?? "—").join(" | ")} | **${slope(gByTurn) > 0 ? "+" : ""}${slope(gByTurn)} ms** |
| **OpenAI mini · 200 ms** | ${mByTurn.map((n) => n ?? "—").join(" | ")} | **${slope(mByTurn) > 0 ? "+" : ""}${slope(mByTurn)} ms** |
| **OpenAI full · 500 ms** | ${fByTurn.map((n) => n ?? "—").join(" | ")} | **${slope(fByTurn) > 0 ? "+" : ""}${slope(fByTurn)} ms** |

**Gemini is flat. The mini degrades badly. The full model improves.**

At turn 1 the mini is the fastest thing measured (${mByTurn[0]} ms, faster than
Gemini's ${gByTurn[0]} ms). By turn 5 it is ${mByTurn[4]} ms — roughly triple —
while its endpointing stayed pinned at ~170 ms, so the drift is generation, not
VAD. A real receptionist call is 10-15 turns, which is past the right-hand edge
of this table and going the wrong way.

The full model does the opposite, most likely as its prefix cache warms. So
"OpenAI is slow" is not a fact about OpenAI: **the mini degrades, the full model
does not.** Round 1 asserted a vendor-level latency ranking from one
configuration at one point in a conversation, and that was wrong twice over.

---

## Round-2 verdicts

| ID | Prediction (locked ${V2.written_at.slice(0, 10)}) | Result | Verdict |
|---|---|---|---|
${results.map((r) => `| **${r.id}** | ${r.pred} | ${r.res} | ${r.pass ? "**PASS**" : "**FAIL**"} |`).join("\n")}

${results.map((r) => `- **${r.id}** — ${r.note}`).join("\n")}

---

## Endpointing, both vendors, same question

Cut-in counts inside \`classifyHold\`'s own window. Read them WITH the hold
times above — a low cut-in count is only good if the hold that produced it was
short enough to be a pause rather than a hang.

| fixture | Gemini patient | Gemini default | Gemini eager | OpenAI low | OpenAI medium | OpenAI high |
|---|---|---|---|---|---|---|
${FIX.map((f) => `| \`${f}\` | ${gGrid("patient", f).cut}/5 | ${gGrid("default", f).cut}/5 | ${gGrid("eager", f).cut}/5 | ${oGrid("low", f).cut}/5 | ${oGrid("medium", f).cut}/5 | ${oGrid("high", f).cut}/5 |`).join("\n")}

---

## Barge-in against a long reply

Round 1 interrupted 2–3 s replies that had usually finished streaming. Here the
model is forced into a long answer first, so there is guaranteed audio in flight.

| | Gemini 2.5 | OpenAI mini |
|---|---|---|
| trials with audio genuinely in flight | ${gBarge.filter((r) => r.audio_in_flight_at_barge).length}/${gBarge.length} | ${oBarge.filter((r) => r.audio_in_flight_at_barge).length}/${oBarge.length} |
| interrupt signalled | ${gBarge.filter((r) => r.interrupted).length}/${gBarge.length} | ${oBarge.filter((r) => r.interrupted).length}/${oBarge.length} |
| signal latency p50 | ${med(gBarge.map((r) => r.barge_to_interrupted_ms))} ms | ${med(oBarge.map((r) => r.barge_to_signal_ms))} ms |
| audio still arriving after the signal | ${gTail}/${gBarge.length} | ${oTail}/${oBarge.length} |
| worst tail | ${Math.max(0, ...gBarge.map((r) => r.ms_of_audio_after_interrupt || 0))} ms | ${Math.max(0, ...oBarge.map((r) => r.ms_of_audio_after_interrupt || 0))} ms |

Both vendors stop cleanly most of the time. Neither stops cleanly *every* time,
and a single trial delivering seconds of audio after the interrupt is exactly the
case a playout queue exists for. **\`turnManager\`'s queue half survives on both
vendors**; its VAD/endpoint-decision half is genuinely replaceable on both.

*Two caveats.* The long reply was produced by instructing the model to monologue —
a real caller cannot do that, so this measures the mechanism, not a natural call.
And the instruction did not land equally: Gemini had audio genuinely in flight in
${gBarge.filter((r) => r.audio_in_flight_at_barge).length}/${gBarge.length} trials
against OpenAI's ${oBarge.filter((r) => r.audio_in_flight_at_barge).length}/${oBarge.length},
because OpenAI kept obeying the prompt's "1-2 short sentences" rule. **OpenAI's
clean 0/${oBarge.length} tail is therefore a weaker result than it looks** — it
was interrupted mid-reply far less often than Gemini was.

---

## Cost, on the identical script

| | \$/turn | 12-turn call, 1,000 calls/mo |
|---|---|---|
| Gemini 2.5 native · Vertex europe-west1 | ${money(gPerTurn)} | \$${(gPerTurn * 12000).toFixed(2)} |
| OpenAI \`gpt-realtime-2.1-mini\` | ${money(oPerTurn)} | \$${(oPerTurn * 12000).toFixed(2)} |
| OpenAI \`gpt-realtime-2.1\` (full) | ${money(fPerTurn)} | \$${(fPerTurn * 12000).toFixed(2)} |

Round 1 reported Gemini on Vertex at ${money(0.00444)}/turn and called it the
cheapest thing measured. That came from L5's 4-turn script, which omits the
\`end_call\` turn. On the identical 5-turn script the two are within 2%.

**Cost has now moved three times across two rounds** — Gemini expensive, then
OpenAI cheaper, then Gemini cheapest, now a tie. That is the strongest available
argument for not deciding on cost.

---

## Spend

| Probe | Cost |
|---|---|
${["L0", "L1", "L2", "L3", "L4", "L5", "R2"].map((p) => `| ${p} | ${money(totalFor(p))} |`).join("\n")}
| **Total** | **${money(spend.spent_usd)}** |
| Cap | ${money(CAP_USD)} |
| Headroom | ${money(CAP_USD - spend.spent_usd)} |
`;

fs.writeFileSync(path.join(HERE, "report-r2.md"), md);
fs.writeFileSync(path.join(HERE, "results-r2.json"), JSON.stringify({
  at: new Date().toISOString(),
  discovery: DISC.grid, hold_times: HOLD.rows, verdicts: results,
  latency: { gemini_leg_p50: med(gLegs), gemini_generation_p50: med(gGen), openai_silence_sweep: silenceCells, openai_full_p50: med(fullLegs) },
  cost_per_turn: { gemini_vertex_2_5: gPerTurn, openai_mini: oPerTurn, openai_full: fPerTurn },
  barge_long: { gemini: gBarge, openai: oBarge },
  spend: { total: spend.spent_usd, cap: CAP_USD, r2: totalFor("R2") },
}, null, 2) + "\n");

console.log(`report-r2.md ${md.length} chars`);
console.log(`verdicts ${results.filter((r) => r.pass).length}/${results.length} — ${results.map((r) => r.id + (r.pass ? "+" : "-")).join(" ")}`);
console.log(`spend ${money(spend.spent_usd)} / ${money(CAP_USD)}`);
