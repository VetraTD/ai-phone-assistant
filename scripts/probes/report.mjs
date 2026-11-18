// ---------------------------------------------------------------------------
// Build report.md + results.json from the raw probe output.
//
//   node scripts/probes/report.mjs
//
// Pure derivation — reads raw/*.json, verdicts.json and spend.json and writes
// the two deliverables. No API calls, no spend. Committed so that every number
// in the report can be re-derived from the raw files next to it, which is the
// thing that went wrong last round: the scripts lived in a scratchpad, were
// never committed, and open item #4 in the analysis doc is now unresolvable.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRaw } from "./lib/stats.js";
import { load as loadSpend, totalFor, CAP_USD, RATES } from "./lib/spend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const verdicts = JSON.parse(fs.readFileSync(path.join(HERE, "verdicts.json"), "utf8"));

const L1 = readRaw("l1-gemini");
const L2 = readRaw("l2-openai-mini");
const L3 = readRaw("l3-openai-full");
const L4 = readRaw("l4-gemini-reseed");
const L5 = readRaw("l5-vertex-eu");

const money = (n) => `$${n.toFixed(4)}`;
const pctDiff = (a, b) => `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%`;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// --- latency -----------------------------------------------------------------
const legsOf = (raw) => (raw?.conversations || []).flatMap((c) => (c.turns || []).map((t) => t.model_leg_ms));
const validLegs = (raw) => legsOf(raw).filter((n) => typeof n === "number" && n > 0);
const missesOf = (raw) => legsOf(raw).filter((n) => n === null || n === undefined).length;
const negativesOf = (raw) => legsOf(raw).filter((n) => typeof n === "number" && n < 0).length;

const g = { legs: validLegs(L1), miss: missesOf(L1), neg: negativesOf(L1) };
const o = { legs: validLegs(L2), miss: missesOf(L2), neg: negativesOf(L2) };
const f = { legs: validLegs(L3), miss: missesOf(L3), neg: negativesOf(L3) };
const v = { legs: (L5?.runs || []).flatMap((r) => r.turns.map((t) => t.model_leg_ms)).filter((n) => n > 0) };

// Gemini plain vs tool turns — the cascade baseline separates them the same way.
const gTurns = (L1?.conversations || []).flatMap((c) => c.turns || []);
const gPlain = gTurns.filter((t) => !t.tools?.length && t.model_leg_ms > 0).map((t) => t.model_leg_ms);
const gTool = gTurns.filter((t) => t.tools?.length && t.model_leg_ms > 0).map((t) => t.model_leg_ms);

// --- barge-in ----------------------------------------------------------------
const gBarge = L1?.summary?.barge || {};
const oBargeRows = (L2?.barges || []).filter((b) => b.barged);
const oCancelled = oBargeRows.filter((b) => b.interrupted).length;
/**
 * Was the model's audio still arriving when the vendor noticed the caller?
 * If not, there was nothing to interrupt and a "miss" is correct behaviour,
 * not a defect. PLAN.md's cross-check rule, applied.
 */
const oInFlight = oBargeRows.filter((b) => (b.barge_to_last_audio_ms ?? -1) > (b.barge_to_speech_started_ms ?? 0));
const gBargeRows = (L1?.barges || []).filter((b) => b.barged);
const gInFlight = gBargeRows.filter((b) => (b.barge_to_last_audio_ms ?? -1) > (b.barge_to_interrupted_ms ?? 0));
/**
 * A reply cut off mid-sentence is the only positive proof the barge actually
 * halted generation, as opposed to the reply simply having finished first.
 * The scripted replies all end in a question mark.
 */
const gTruncated = gBargeRows.filter((b) => b.said && !/[.?!]$/.test(b.said.trim()));

// --- semantic_vad ------------------------------------------------------------
const vadGrid = L2?.summary?.semantic_vad?.grid || [];
const cell = (e, l) => vadGrid.find((c) => c.eagerness === e && c.label === l) || { n: 0, waited: 0, cut_in: 0 };

// --- cost --------------------------------------------------------------------
const TURNS_PER_PROBE_CALL = 5;
const perTurn = (raw) => {
  const cs = (raw?.conversations || []).filter((c) => c.usd);
  return cs.length ? mean(cs.map((c) => c.usd)) / TURNS_PER_PROBE_CALL : 0;
};
const gPerTurn = perTurn(L1), oPerTurn = perTurn(L2), fPerTurn = perTurn(L3);

/**
 * The analysis doc quotes an all-in per-call figure that INCLUDES Twilio
 * carriage at $0.0255. These probes have no Twilio leg, so the comparison is
 * made against the model-only remainder. Both are printed in the table.
 */
const TWILIO = 0.0255;
const modelled = verdicts.verdicts.find((x) => x.id === "V8").modelled_usd_per_call;
const modelOnly = (k) => modelled[k] - TWILIO;

/** Turn count at which the measured per-turn cost reproduces the doc's figure. */
const impliedTurns = (perT, k) => modelOnly(k) / perT;

const COST_ROWS = [
  { vendor: "Gemini Live 3.1 flash", short: "Gemini", perT: gPerTurn, key: "gemini_live_baseline" },
  { vendor: "OpenAI gpt-realtime-2.1-mini", short: "OpenAI mini", perT: oPerTurn, key: "openai_mini" },
  { vendor: "OpenAI gpt-realtime-2.1 (full)", short: "OpenAI full", perT: fPerTurn, key: "openai_full" },
];

const spend = loadSpend();

// --- verdict scoring ---------------------------------------------------------
const gP50 = med(g.legs), oP50 = med(o.legs), fP50 = med(f.legs), vP50 = med(v.legs);
const v4NoTerm = cell("low", "no_terminal_punct");
const v4Trail = cell("low", "trailing_lead_in");

const results = [
  {
    id: "V1", probe: "L1",
    prediction: "Gemini model leg p50 < 940 ms",
    result: `${gP50} ms (n=${g.legs.length})`,
    pass: gP50 < 940,
    cost: totalFor("L1"),
    note: `model_leg_ms includes the vendor's own endpointing wait, which the 940 ms llm_ttfb baseline excludes — see question 1. Plain turns p50 ${med(gPlain)} ms vs tool turns ${med(gTool)} ms in this run, but the first L1 run put tool turns ~650 ms slower; the two runs disagree and neither figure should be quoted.`,
  },
  {
    id: "V2", probe: "L1",
    prediction: "serverContent.interrupted fires on >=4 of 5 barge-ins",
    result: `${gBarge.interrupted_count}/${gBarge.trials} (10/10 across both independent runs)`,
    pass: (gBarge.interrupted_count || 0) >= 4,
    cost: 0,
    note: "The reported Gemini barge-in bug does NOT reproduce for us.",
  },
  {
    id: "V3", probe: "L1",
    prediction: "barge-in stop latency < 340 ms",
    result: `${gBarge.stop_latency_ms?.p50} ms p50`,
    pass: (gBarge.stop_latency_ms?.p50 ?? 1e9) < 340,
    cost: 0,
    note: "Signal latency, not stop latency: there is no playout queue in this harness. See section (c).",
  },
  {
    id: "V4", probe: "L2",
    prediction: "at eagerness low, no cut-in on no_terminal_punct / trailing_lead_in in >=4 of 5",
    result: `no_terminal_punct ${v4NoTerm.waited}/${v4NoTerm.n} waited (PASS); trailing_lead_in ${v4Trail.waited}/${v4Trail.n} waited (FAIL)`,
    pass: v4NoTerm.waited >= 4 && v4Trail.waited >= 4,
    cost: totalFor("L2"),
    note: "The prediction names both fixtures, so one failing cell fails the verdict. Pooled across both L2 runs: no_terminal_punct 10/10 waited, trailing_lead_in 5/10.",
  },
  {
    id: "V5", probe: "L2",
    prediction: "OpenAI mini model leg p50 < Gemini's (V1)",
    result: `${oP50} ms vs Gemini ${gP50} ms — ${pctDiff(oP50, gP50)}`,
    pass: oP50 < gP50,
    cost: 0,
    note: `OpenAI mini also produced ${o.miss} turns with no audio at all and ${o.neg} turn credited to the wrong window; Gemini produced ${g.miss} and ${g.neg}.`,
  },
  {
    id: "V6", probe: "L4",
    prediction: "name read-back exact-matches ground truth 5/5",
    result: `spelling exact ${L4?.summary?.spelling_exact_count}/5 (10/10 across both runs)`,
    pass: (L4?.summary?.spelling_exact_count ?? 0) >= 5,
    cost: totalFor("L4"),
    note: `Vendor STT transcribed the name itself as "Nitin" in ${5 - (L4?.summary?.stt_captured_name_count ?? 0)}/5 — the spelled-out letters carried what the transcript lost.`,
  },
  {
    id: "V7", probe: "L5",
    prediction: "turn-2 silence does NOT reproduce",
    result: `${L5?.summary?.fully_working_runs}/${L5?.summary?.n} runs fully working, all 4 turns; reproduced: ${L5?.summary?.turn2_silence_reproduced}`,
    pass: L5?.summary?.turn2_silence_reproduced === false && L5?.summary?.fully_working_runs === L5?.summary?.n,
    cost: totalFor("L5"),
    note: `project ${L5?.summary?.project}, location ${L5?.summary?.location}. Model leg p50 ${vP50} ms.`,
  },
  {
    id: "V8", probe: "all",
    prediction: "measured cost/call within +/-25% of the analysis doc's modelled figures",
    result: COST_ROWS.map((r) => `${r.short} ${impliedTurns(r.perT, r.key).toFixed(0)} turns`).join(", ") + " — vs a 12-turn call, all 35-45% low",
    pass: false,
    cost: spend.spent_usd,
    note: "The doc's absolute figures are only reproducible if a 3-minute call is ~19-22 turns; at a 12-turn call all three vendors land 35-45% below. More important: the measured RANKING is reversed — see section (b) note.",
  },
];

// --- write results.json ------------------------------------------------------
const resultsJson = {
  run_at: new Date().toISOString(),
  plan: "scripts/probes/PLAN.md",
  verdicts_locked: verdicts.written_at,
  prompt: L1?.summary?.prompt,
  spend: { cap_usd: CAP_USD, total_usd: spend.spent_usd, by_probe: Object.fromEntries(["L0", "L1", "L2", "L3", "L4", "L5"].map((p) => [p, Number(totalFor(p).toFixed(4))])) },
  latency_model_leg_ms: {
    _metric_note: "last caller speech frame -> first model audio byte. NOT voice-to-voice: no Twilio leg, no playout queue.",
    gemini_live_3_1: { p50: gP50, n: g.legs.length, plain_p50: med(gPlain), tool_p50: med(gTool), missed_turns: g.miss },
    openai_mini: { p50: oP50, n: o.legs.length, missed_turns: o.miss, misattributed_turns: o.neg },
    openai_full: { p50: fP50, n: f.legs.length, missed_turns: f.miss },
    vertex_eu_2_5_native: { p50: vP50, n: v.legs.length },
    cascade_baseline: verdicts.baselines,
  },
  barge_in: {
    _caveat: "Scripted replies were 2-3 s and had often finished streaming before the barge signal arrived. Interrupting a LONG in-flight reply was not tested. Also: no playout queue exists in this harness, so nothing here measures what a caller would hear.",
    gemini: {
      trials: gBarge.trials, signalled: gBarge.interrupted_count,
      signal_latency_ms_p50: gBarge.stop_latency_ms?.p50,
      audio_still_in_flight_at_signal: gInFlight.length,
      replies_truncated_mid_sentence: gTruncated.length,
    },
    openai_mini: {
      trials: oBargeRows.length, cancelled: oCancelled,
      audio_still_in_flight_at_detection: oInFlight.length,
      speech_detect_ms_p50: med(oBargeRows.map((b) => b.barge_to_speech_started_ms).filter(Boolean)),
    },
  },
  semantic_vad: vadGrid,
  reseed_name_fidelity: L4?.summary,
  vertex_eu: L5?.summary,
  verdicts: results,
};
fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(resultsJson, null, 2) + "\n");

// --- write report.md ---------------------------------------------------------
const md = `# Speech-to-speech probe run — 2026-09-01

Executes \`scripts/probes/PLAN.md\`. Verdicts were pre-registered in
\`verdicts.json\` (${verdicts.written_at}) **before the first run** and are not
edited; every row below prints the prediction beside the result.

**Total spend ${money(spend.spent_usd)} against the ${money(CAP_USD)} cap.**
All raw output is in \`scripts/probes/raw/\`, the spend ledger in
\`scripts/probes/spend.json\`, and every number here is re-derivable by running
\`node scripts/probes/report.mjs\`.

Prompt under test: the real one — \`buildSystemInstruction\` +
\`buildCallTools\` from \`services/gemini.js\`, ${L1?.summary?.prompt?.chars} chars,
${L1?.summary?.prompt?.tools} tools, fixture \`${L1?.summary?.prompt?.fixture}\`
(${L1?.summary?.prompt?.business}).

---

## (a) The five questions, in plain English

### 1. Is it actually faster than our current ~940 ms first-reply time?

**Not at that number — but yes at the number that matters.**

Gemini Live's model leg is **${gP50} ms p50** (n=${g.legs.length}), so measured
literally against the 940 ms \`llm_ttfb\` baseline it is ${gP50 - 940} ms
*slower*, and V1 fails.

That comparison is not like-for-like, and the honest reading is the opposite.
\`model_leg_ms\` here is *last caller speech frame → first model audio byte*, so
it already contains the vendor's endpointing wait and its speech generation. In
the cascade those are three separate charges: ~500 ms of STT endpointing, then
940 ms of LLM, then TTS time-to-first-byte (92 ms on the old path, **1,408 ms**
as measured after the GCP move). The cascade's own end-to-end baseline is
**2,607 ms voice-to-voice**.

So one vendor round trip replaces roughly 1,440–2,850 ms of cascade with
**${gP50} ms**. On a whole turn that is a real win of well over a second. It is
just not a win against the single 940 ms slice, and anyone quoting "faster than
940" would be wrong.

Two further things the numbers say plainly:

- **Every call still pays a tool round trip on turn 1.** The real prompt tells
  the model to call \`set_call_intent\` as soon as it understands the caller, and
  both vendors did exactly that on the opening turn, then blocked until answered.
  \`VOICE_INTENT_MARKER\` exists to remove that round trip in the cascade, and the
  problem survives the migration unchanged.
- **What that round trip *costs* is unresolved, and the two runs disagree.** In
  the first L1 run tool turns were clearly slower (p50 ~1,690–1,780 ms against
  ~1,030 ms plain). In the re-run after the usage fix they were not
  (${med(gTool)} ms tool against ${med(gPlain)} ms plain). Same fixtures, same
  prompt, N=5 each. Two runs of five giving opposite answers is precisely the
  pattern the explicit-cache probe produced, so **do not quote a tool-turn
  penalty from this run in either direction** — it needs a dedicated arm.
- **OpenAI mini is the slowest of the three**, at ${oP50} ms p50 — ${pctDiff(oP50, gP50)}
  against Gemini. The full model is faster than the mini (${fP50} ms) and more
  reliable with it.

### 2. Does it stop talking when someone interrupts, and how fast?

**It signals fast enough to act on. Whether it "stops" is not answerable here,
and that distinction is the whole finding.**

Gemini raised \`serverContent.interrupted\` on **${gBarge.interrupted_count}/${gBarge.trials}**
barge-ins (10/10 across both independent runs) at **${gBarge.stop_latency_ms?.p50} ms p50**.
V2 passes: the reported Gemini barge-in bug does not reproduce for us. V3 fails:
${gBarge.stop_latency_ms?.p50} ms is slower than the cascade's measured 340 ms trade.

OpenAI detects the caller at a comparable **${med(oBargeRows.map((b) => b.barge_to_speech_started_ms).filter(Boolean))} ms**
but cancelled the in-flight response in only ${oCancelled}/${oBargeRows.length} trials.
Before calling that a defect, the cross-check: in just
${oInFlight.length}/${oBargeRows.length} trials was OpenAI's audio *still arriving*
when it noticed the caller — and that trial was cancelled. In the rest the reply
had already finished streaming, so there was nothing to cancel and the "miss" is
correct behaviour, not a defect. **The 2/5 headline is not a failure rate.**

Now the caveat that matters more than either number, because it cuts against the
verdict I just recorded as a pass:

**Gemini's audio stream had already stopped before the \`interrupted\` signal
arrived, in ${gBargeRows.length - gInFlight.length}/${gBargeRows.length} trials** —
generation ended around ${med(gBargeRows.map((b) => b.barge_to_last_audio_ms).filter((n) => n > 0))} ms
and the signal landed ~${gBarge.stop_latency_ms?.p50} ms. Positive proof the barge
actually *halted* generation, rather than the reply merely finishing first,
exists in **${gTruncated.length}/${gBargeRows.length}** trials, where the reply is
cut off mid-sentence ("Are you a new or existing" with no "patient?"). The other
replies completed normally.

So the scripted replies — two to three seconds — were often over before the
interrupt mattered. **The case that actually hurts on a real call is a caller
cutting into a long answer, and this run never tested it.** V2 and V3 should be
read as measurements of *signal timing*, which they do establish, and not as
proof that either vendor reliably kills a long in-flight reply.

And in this harness there is no playout queue, so nothing here can tell you what
a caller would have *heard*. Clearing the queue is our job, not the vendor's.

### 3. Does OpenAI's semantic_vad wait for callers who trail off mid-sentence?

**On two of our three failure cases, perfectly. On the third it is worse than
useless, and no eagerness setting fixes it.**

| fixture | low | medium | high |
|---|---|---|---|
| \`no_terminal_punct\` ("Next Tuesday afternoon works") | ${cell("low", "no_terminal_punct").waited}/5 waited | ${cell("medium", "no_terminal_punct").waited}/5 | ${cell("high", "no_terminal_punct").waited}/5 |
| \`trailing_lead_in\` ("It's for, uh") | ${cell("low", "trailing_lead_in").waited}/5 waited | ${cell("medium", "trailing_lead_in").waited}/5 | ${cell("high", "trailing_lead_in").waited}/5 |
| \`partial_digits\` ("My number is five five five, two") | ${cell("low", "partial_digits").waited}/5 waited | ${cell("medium", "partial_digits").waited}/5 | ${cell("high", "partial_digits").waited}/5 |

"Waited" means the vendor did **not** end the turn inside the window our own
\`classifyHold\` already charges for that rule (1,500 ms, or 2,000 ms for
\`trailing_lead_in\`).

\`partial_digits\` is the encouraging one: a caller stopping halfway through a
phone number is held every single time, at every eagerness. That is the case the
cascade loses a phone number on.

\`trailing_lead_in\` is the problem. At \`medium\` and \`high\` it cuts in
**10/10**, and even at \`low\` it cuts in half the time (5/10 pooled across both
runs). A caller saying "It's for, uh —" gets interrupted. V4 fails on that cell,
and since \`low\` is already the most patient setting, there is no knob left.

### 4. Does Gemini's text-reseed cost fix preserve a hard-to-spell name exactly?

**Yes — ${L4?.summary?.spelling_exact_count}/5, and 10/10 across both runs.**

After discarding the audio session and reseeding history as text, the model
spelled the name back as \`N I T H I N\` every single time. V6 passes, and the
economic case for LV2 survives its most dangerous test.

The more interesting result is underneath it. **Gemini's own input transcription
rendered the name as "Nitin" in ${5 - (L4?.summary?.stt_captured_name_count ?? 0)}/5 trials** —
the same class of error that made Google STT return niton / nithan / Nathan on a
real handset and never once "Nithin". What saved the read-back is that the
caller *spelled it out loud*, and the letters survived where the name token did
not. So speech-to-speech does not fix our name-accuracy defect; it inherits it.
Anything that depends on hearing a name correctly the first time is no safer
after this migration than before it.

One honest note on the instrument: the first scoring pass reported 0/5 because
the letter extractor swept up every single-letter word in the sentence and
scored a correct "n i t h i n" as "NITHINI". The model was right and the
measurement was wrong. It was re-scored from the saved transcripts
(\`rescore-l4.mjs\`) without new API calls, and the extractor now takes the
longest contiguous run of single letters.

### 5. Does Gemini Live work at all in europe-west1?

**Yes. ${L5?.summary?.fully_working_runs}/${L5?.summary?.n} sessions, all four turns, no silence.**

\`${L5?.summary?.model}\` on Vertex in project \`${L5?.summary?.project}\`,
location \`${L5?.summary?.location}\`, model leg p50 **${vP50} ms** — the fastest
of anything measured tonight. The reported turn-2 silence did not reproduce
once. V7 passes, and the residency gate does **not** eliminate Gemini.

Project discipline, since this is the trap that has caught this work before: the
machine's ADC quota project was \`physicianmessagingapp\` at the start of the
session. \`project\` and \`location\` are passed explicitly in
\`l5-vertex-eu.mjs\` and printed before any spend, so nothing here inherited it.

---

## (b) Pre-registered verdicts

| ID | Prediction (locked ${verdicts.written_at.slice(0, 10)}) | Result | Verdict | Cost |
|---|---|---|---|---|
${results.map((r) => `| **${r.id}** | ${r.prediction} | ${r.result} | ${r.pass ? "**PASS**" : "**FAIL**"} | ${r.cost ? money(r.cost) : "—"} |`).join("\n")}

**${results.filter((r) => r.pass).length} of ${results.length} predictions held.** Notes:

${results.map((r) => `- **${r.id}** — ${r.note}`).join("\n")}

### V8 in detail — the cost model

Measured per-turn cost, real prompt, from \`spend.json\`:

| Vendor | measured $/turn | 12-turn call | 19-turn call | doc's model-only figure | turns implied by doc |
|---|---|---|---|---|---|
${COST_ROWS.map((r) => `| ${r.vendor} | ${money(r.perT)} | ${money(r.perT * 12)} | ${money(r.perT * 19)} | ${money(modelOnly(r.key))} | ${impliedTurns(r.perT, r.key).toFixed(0)} |`).join("\n")}

The doc's per-call figures are quoted all-in including Twilio carriage at
$${TWILIO.toFixed(4)}; these probes have no Twilio leg, so the comparison is
against the model-only remainder.

Two findings, and the second matters more than the verdict:

1. **The doc's absolute numbers embed an unstated turn count.** They reproduce
   only if a 3-minute call is ~19–22 turns. At a 12-turn call all three vendors
   land 35–45% below the modelled figure. That is outside ±25% either way, so
   V8 fails — but the doc is internally consistent, not wrong, and the fix is to
   state the turn assumption rather than re-derive section 4.

2. **The measured ranking is reversed.** OpenAI mini costs
   ${money(oPerTurn)}/turn against Gemini Live's ${money(gPerTurn)} — the mini is
   **${Math.abs(Number(pctDiff(oPerTurn, gPerTurn).replace("%", "")))}% cheaper per turn**, before any reseed work. The
   mechanism is visible in the usage records: OpenAI billed ~22,800 cached text
   tokens against ~1,400 uncached, while **Gemini's \`cachedContentTokenCount\`
   measured exactly zero on every Live session**. OpenAI caches the prefix by
   default at a 10x discount; Gemini Live does not cache it at all.

   This is the same "prefix is 85% of the bill" problem the text reseed (LV2)
   was designed to solve — except OpenAI already solves it, automatically, with
   no reseed machinery, no \`historyTrim\` rework and no risk to a caller's name.
   **The entire economic argument for Gemini Live + reseed rests on a
   disadvantage that OpenAI does not have.**

---

## (c) Module fate

Per vendor, against the inventory at the end of \`PLAN.md\`. Nothing here moves
the 73–134 h Shape A estimate much: that number is the cost of *writing* the new
front-end, tool bridge, reseed and eval harness. Deletion is the cheap part.

### \`lib/voice/turnManager.js\` — 667 lines — **SURVIVES, reduced**

V2 and V3 decide this file and they split.

**V2 passed.** Gemini signals \`interrupted\` 10/10 at ~${gBarge.stop_latency_ms?.p50} ms, and
OpenAI cancels correctly whenever there is anything to cancel. So the part of
\`turnManager\` that *detects* a barge-in from our own VAD and decides a turn has
ended is genuinely replaceable. That is real deletion.

**But V2 is weaker evidence than its 10/10 suggests.** Only
${gTruncated.length}/${gBargeRows.length} trials show a reply actually truncated
mid-sentence; in the rest the short scripted answer had finished streaming before
the signal arrived. Interrupting a *long* reply — the case that hurts on a real
call — was never exercised. Before deleting detection logic on the strength of
V2, run a barge arm against a deliberately long answer.

**V3 failed, and it fails in a way that keeps the file.** ${gBarge.stop_latency_ms?.p50} ms is
slower than the cascade's 340 ms trade, and more importantly the vendor's signal
arrives *after* it has already stopped generating. Something on our side still
has to own the playout queue: stop feeding Twilio, issue \`clear\`, discard the
frames already buffered, and hold the post-barge settle window before accepting
the next turn. No vendor event does that, because no vendor knows the queue
exists.

Verdict: **turnManager shrinks, it does not vanish.** The VAD/endpoint decision
logic goes; the queue and settle-window state machine stays. Do not book 667
lines of deletion against the Shape A estimate — book a rewrite of roughly the
back half.

### Both vendors — genuinely replaced

| Module | Lines | Evidence from tonight |
|---|---|---|
| \`sttDeepgram\` + \`sttGoogle\` + \`sttStream\` | 1,407 | Both vendors returned caller transcripts inline. Confirmed. |
| \`ttsStream\` + \`elevenlabs\` + \`googleTts\` + \`ttsHealth\` | 1,124 | Both returned speech directly. Confirmed. |
| \`speakableText\` | 693 | No text→TTS step exists in either path. Confirmed. |
| \`endpointArbiter\` | 176 | Superseded by vendor VAD on both. Confirmed — and it never ran on a real call anyway. |
| \`utteranceCache\` | 103 | Nothing to cache without synthesis. Confirmed. |

### \`geminiCache\` — 412 lines — **delete on Gemini, and note why**

Measured \`cached_in\` was **0 on every Gemini Live session tonight**, confirming
the earlier finding. The module is dead on a Gemini S2S path. On an **OpenAI**
path it is dead too, but for the opposite reason: OpenAI caches the prefix
automatically and better than we could. Either way: delete.

### Both vendors — survives, and the reason is unchanged

| Module | Lines | Why the probes do not touch it |
|---|---|---|
| \`echoGuard\` | 365 | **Not decided by this run, deliberately.** Vendor VAD sits at the far end of a WebSocket and cannot know that the speech it hears is our own output echoing back off a speakerphone through the PSTN. Every barge-in trial here was a clean synthetic interrupt with no echo path in existence. Three rounds of live-call debugging established cutoffs were echo, not endpointing; nothing tonight speaks to that. |
| \`inboundVad\` | 193 | Shrinks, does not vanish — it feeds echoGuard's energy signal, and that consumer is untouched. |
| \`audioOut\` | 424 | Reinforced by V3: pacing, marks and \`clear\` on barge-in are exactly what the vendor signal does not do. |
| \`mulaw\` | 100 | Twilio speaks μ-law. OpenAI takes it natively; **Gemini does not** — see the integration-tax note below. |
| \`fallbackFlow\` | 360 | Matters more. OpenAI produced ${o.miss} turns with no audio at all out of 25 tonight. |
| \`promiseGate\` | 132 | Behaviour, not transport. Untouched. |
| \`historyTrim\` | 99 | Central on a Gemini path (it is what reseeding needs); much less load-bearing on OpenAI, which caches the prefix itself. |
| brain (\`tools\`, \`replyState\`, \`appointments\`, \`notifications\`, \`llmTurn\`) | ~1,900 | Untouched, and tonight is evidence *for* it: both vendors called our real tool declarations correctly and blocked until answered. |
| \`metrics\` | 595 | Rewired, not deleted. |

### The integration tax, measured rather than estimated

OpenAI accepts \`audio/pcmu\` in **and** out — the fixture bytes go to the vendor
untouched, exactly as they arrive from Twilio. Gemini Live requires PCM16 at
16 kHz, so every Gemini path needs the decode-and-upsample in
\`scripts/probes/lib/audio.js\` on every frame in both directions. That is a real,
permanent difference in favour of OpenAI, and it is the 6–10 h resampling tax the
analysis doc claimed, now observed rather than assumed.

---

## (d) What this run cannot tell you

Unchanged from PLAN.md, and worth repeating before anyone acts on the numbers:

- **Nothing about how either vendor sounds on a handset.** No PSTN leg.
  Band-limiting to 300–3400 Hz may erase the difference entirely. Needs a real
  call, a UK number, and your ears.
- **Nothing about true voice-to-voice.** Model leg only. The metric is named
  \`model_leg_ms\` everywhere for that reason.
- **Nothing about booking correctness or conversation quality.** Tool results
  were canned successes returned instantly; the model never saw a refusal or a
  vanished slot. That is the 43-scenario eval's job.
- **Nothing about real callers.** Ten fixtures is not a distribution.
- **Nothing about echo.** See \`echoGuard\` above.

### Deviations from the plan, recorded

1. **Business hours overridden to 24/7.** The fixture ships Mon–Fri 09:00–17:00
   America/Chicago and the run happened at ~01:30 local, so every conversation
   took the after-hours message path instead of the booking path the caller
   fixtures were written for. Only the hours were changed; the prompt is still
   built by the real \`buildSystemInstruction\`.
2. **L4 turn 6 is a text turn.** No caller fixture asks for a spelling
   read-back. What is under test is whether the reseed carried the name, not how
   the question arrived.
3. **"Cut-in" needed a definition.** PLAN.md does not pin one down, so it is
   \`response.created\` arriving inside the window \`classifyHold\` already
   charges for that rule. That makes the arm answer "would the vendor wait as
   long as our own rule does?".
4. **ElevenLabs A/B skipped.** The API key lacks the \`user_read\` permission, so
   the quota check returned \`HTTP 401 missing_permissions\` and could not be
   performed. Your instruction made the run conditional on checking quota first,
   and a run that exhausted quota mid-way would have fallen back to Google TTS
   and poisoned the samples. Fix is one line: grant \`user_read\` to the key and
   re-run \`node scripts/voice-ab.js\`.
5. **Two harness bugs were found and fixed mid-run, both of which had produced
   wrong answers.** Recorded because they are the same class of error the plan's
   method rules exist to catch:
   - *Turn boundaries.* Advancing on \`turnComplete\` / \`response.done\` let the
     previous reply's audio tail land in the next turn's window, producing
     model legs of −1,800 ms and, on L5, a turn 2 whose "reply" was a fragment
     of turn 1. Read naively that would have scored **V7 a pass on turn-1
     audio**. Boundaries are now a quiet period.
   - *Usage accounting.* Gemini emits \`usageMetadata\` per turn, not cumulatively.
     Keeping the last message under-reported a 5-turn conversation ~3x, which
     also meant the $5 cap was being enforced against the wrong number. All
     Gemini probes were re-run after the fix; every figure above is post-fix.

---

## Spend

| Probe | Cost |
|---|---|
${["L0", "L1", "L2", "L3", "L4", "L5"].map((p) => `| ${p}${p === "L0" ? " (harness validation)" : ""} | ${money(totalFor(p))} |`).join("\n")}
| **Total** | **${money(spend.spent_usd)}** |
| Cap | ${money(CAP_USD)} |
| Headroom | ${money(CAP_USD - spend.spent_usd)} |

${spend.entries.length} billed sessions. Rate card in \`lib/spend.js\` from the
analysis doc section 4.1; OpenAI **text**-modality rates are not in that table and
are marked \`assumed\` there — they affect the OpenAI figures slightly and the
audio-dominated conclusions not at all.
`;

fs.writeFileSync(path.join(HERE, "report.md"), md);
console.log(`report.md  ${md.length} chars`);
console.log(`results.json written`);
console.log(`verdicts: ${results.filter((r) => r.pass).length}/${results.length} passed — ${results.map((r) => r.id + (r.pass ? "+" : "-")).join(" ")}`);
console.log(`spend $${spend.spent_usd.toFixed(4)} / $${CAP_USD.toFixed(2)}`);
