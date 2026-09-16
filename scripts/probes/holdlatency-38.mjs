// ---------------------------------------------------------------------------
// What does LIVE_TURN_END=hold COST on a normal turn?
//
// manualvad-38.mjs settled that the hold arm fixes the trail-off: with the
// vendor's VAD off, both 3.8 and 3.1 stayed silent 5/5 through a 3,000 ms hold.
// It did not ask the other half of the question. Manual endpointing pays a
// latency tax on EVERY turn to fix a defect that fires on SOME turns, and the
// tax is what decides whether the trade is worth making.
//
// ---------------------------------------------------------------------------
// TWO CORRECTIONS THIS PROBE IS BUILT ON, both found by reading the code
// ---------------------------------------------------------------------------
//
// 1. THE 1,200 ms HANGOVER IS NOT THIS ARM'S. The plan, the memory and the
//    spike all quote the manual arm's felt gap at 2,246 ms against the vendor's
//    1,325 ms, "almost all of it DEFAULT_HANGOVER_MS = 1200". That is arm B,
//    turnEnd/flatHangover.js. Arm C -- classifyHold, the arm LIVE_TURN_END=hold
//    actually selects -- does not import DEFAULT_HANGOVER_MS at all. It closes
//    at max(DEFAULT_MIN_SILENCE_MS = 300, classifyHold's holdMs). So the
//    expected cost on a complete turn is the 300 ms silence floor, not 1,200 ms,
//    and the number everyone has been quoting describes a different arm.
//
// 2. GEMINI PUNCTUATES, WHICH IS THE WHOLE BALLGAME. classifyHold.js:22-33
//    records that its terminal-punctuation branch was written against Deepgram
//    with smart_format, and that nobody had checked whether Gemini's
//    inputAudioTranscription punctuates. A census of every caller transcript
//    already saved in this directory says it does: of 45 gemini-3.8-live
//    transcripts, 40 end in [.!?] -- and all five that do not are the trail-off
//    fixture, which is the one caller who genuinely has not finished. That is
//    exactly the split the arm was designed around.
//
// So the PREDICTION, pre-registered here before the first socket: a complete
// phrase closes at roughly the 300 ms floor and hold costs well under the
// ~500 ms bar the plan set, while the trail-off pays its full 2,000 ms and is
// not cut into. If that is wrong, this file is the record that it was wrong.
//
// ---------------------------------------------------------------------------
// WHY THIS DRIVES THE REAL STRATEGY
// ---------------------------------------------------------------------------
//
// It imports createClassifyHoldStrategy from lib/ and feeds it real frame ticks
// and the real transcript Gemini returns, rather than hard-coding a hold length
// per fixture. A probe that hard-codes 300 ms for the complete phrase is not
// measuring classifyHold, it is measuring the number the author already
// believed -- and it would have missed that "It's for a" is charged 2,000 ms by
// the trailing_CONJUNCTION branch rather than the trailing_lead_in one the
// fixture is named after. An assertion on the rule NAME would have failed and
// read as a broken fix. This asserts on the hold DURATION instead.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import { openSession, sendAudio, armTurn, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { commit, priceGeminiByMinutes, summary, reserve } from "./lib/spendLive.js";
import { classifyHold } from "../../lib/transcriptUtils.js";
import { createClassifyHoldStrategy } from "../../lib/voice/live/turnEnd/classifyHold.js";

const MODELS = (process.env.MV_MODELS || "gemini-3.8-live,gemini-3.1-flash-live-preview").split(",");
const N = Number(process.env.MV_N || 5);

/**
 * `rep_confirm` is the cost case: a complete phrase, the shape of nearly every
 * turn a caller speaks. `trailing_lead_in` is the defect case. The arm is only
 * worth shipping if it is cheap on the first and patient on the second.
 */
const CASES = [
  { fixture: "rep_confirm", kind: "complete" },
  { fixture: "trailing_lead_in", kind: "trailoff" },
];

/** Hard ceiling on the silence we will stream before giving up on the strategy. */
const MAX_HOLD_MS = 5_000;

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

/**
 * The instrument test, run BEFORE any paid session.
 *
 * An instrument that cannot fail is not evidence. If classifyHold does not
 * charge a real hold for the trail-off transcript Gemini actually produces,
 * this probe measures nothing and must not be allowed to print a number.
 */
function validateDetector() {
  const checks = [
    // The transcript gemini returned for this fixture on 5/5 manualvad takes.
    { text: "It's for a", wantAtLeast: 2_000, why: "trail-off, as Gemini transcribes it" },
    // A complete phrase, punctuated, which is what 40 of 45 saved 3.8
    // transcripts look like.
    { text: "Tuesday at ten works for me.", wantAtMost: 0, why: "complete phrase, punctuated" },
  ];
  let ok = true;
  console.log("instrument check (no sessions, no spend):");
  for (const c of checks) {
    const v = classifyHold(c.text, c.text);
    const pass = c.wantAtLeast != null ? v.holdMs >= c.wantAtLeast : v.holdMs <= c.wantAtMost;
    if (!pass) ok = false;
    console.log(
      `  ${pass ? "ok  " : "FAIL"} ${String(v.holdMs).padStart(5)}ms ${v.rule.padEnd(24)} ${JSON.stringify(c.text)}  <- ${c.why}`
    );
  }
  return ok;
}

async function trial(model, c, i) {
  reserve(`HL/${model}-${c.fixture}-${i}`, 60, 0.02);
  const row = { model, fixture: c.fixture, kind: c.kind, take: i };
  let ctx = null;
  const t0 = Date.now();

  try {
    ctx = await openSession({
      surface: "aistudio",
      model,
      answerTools: true,
      // The arm under test. Vendor endpointing off; classifyHold decides.
      automaticActivityDetection: { disabled: true },
    });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;
    armTurn(st);
    st.inputTranscript = "";

    // The real production strategy, at its real defaults.
    const strategy = createClassifyHoldStrategy();
    strategy.reset();

    ctx.session.sendRealtimeInput({ activityStart: {} });

    // --- the caller speaks -------------------------------------------------
    const speech = pcmFrames(c.fixture);
    await paceFrames(speech, (f) => {
      sendAudio(ctx.session, f);
      strategy.onFrame({ voiced: true, isActive: true, atMs: Date.now() });
    });
    const speechEndAt = Date.now();

    // --- the caller has stopped. Twilio keeps sending silence; we decide -----
    let closed = null;
    let seenTranscript = "";
    let transcriptAt = null;

    const silence = silenceFrames("pcm16k", MAX_HOLD_MS);
    await paceFrames(
      silence,
      (f) => {
        sendAudio(ctx.session, f);
        const atMs = Date.now();

        // Feed the strategy the transcript the moment it arrives, exactly as
        // lib/voice/live/index.js does on inputTranscription.
        if (st.inputTranscript && st.inputTranscript !== seenTranscript) {
          seenTranscript = st.inputTranscript;
          transcriptAt = transcriptAt ?? atMs;
          strategy.onTranscript({ text: seenTranscript, atMs });
        }

        const verdict = strategy.onFrame({ voiced: false, isActive: false, atMs });
        if (verdict?.close && !closed) closed = { at: atMs, rule: verdict.rule, shape: verdict.shape };
      },
      { stop: () => closed !== null }
    );

    row.transcript = (seenTranscript || "").trim();
    row.transcript_at_ms = transcriptAt ? transcriptAt - speechEndAt : null;
    row.has_terminal_punct = /[.!?]\s*$/.test(row.transcript);
    row.classify_rule = closed?.rule ?? null;
    row.classify_shape = closed?.shape ?? null;
    row.closed_by_strategy = closed !== null;

    // Did the model jump into the pause before our own code decided the turn
    // had ended? That is the defect, measured on the arm that is meant to fix it.
    row.spoke_during_hold = st.firstAudioAt !== null && (!closed || st.firstAudioAt < closed.at);
    row.spoke_at_ms = st.firstAudioAt !== null ? st.firstAudioAt - speechEndAt : null;

    const closeAt = closed ? closed.at : Date.now();
    // THE COST. How long our own endpointing made the caller wait after they
    // stopped speaking, before we even told the vendor the turn was over.
    row.hold_paid_ms = closeAt - speechEndAt;

    ctx.session.sendRealtimeInput({ activityEnd: {} });
    const answered = await waitFor(() => st.firstAudioAt !== null, 15_000);
    row.answered = answered;
    row.reply_after_end_ms = answered && !row.spoke_during_hold ? st.firstAudioAt - closeAt : null;
    // THE NUMBER THIS PROBE EXISTS FOR: what the caller actually feels, from the
    // end of their own speech to the start of ours, our hold included.
    row.felt_gap_ms = answered ? st.firstAudioAt - speechEndAt : null;
    await sleep(300);
  } catch (e) {
    row.error = (e.message || String(e)).slice(0, 140);
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const priced = priceGeminiByMinutes({
    inSeconds: (Date.now() - t0) / 1000,
    outSeconds: (ctx?.state?.audioBytes || 0) / (24000 * 2),
  });
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "HOLDLATENCY", arm: `${model}/${c.fixture}`, label: `hl-${model}-${c.fixture}-${i}`, model, usd: priced.usd, estimated: true });

  console.log(
    `  ${model.padEnd(31)} ${c.fixture.padEnd(17)} t${i}  ` +
    `hold ${String(row.hold_paid_ms ?? "-").padStart(5)}ms ${(row.classify_rule || "NO-CLOSE").padEnd(23)} ` +
    `${row.has_terminal_punct ? "punct" : "  -  "} ` +
    `felt ${String(row.felt_gap_ms ?? "-").padStart(5)}ms  ` +
    `${row.spoke_during_hold ? "*** CUT IN ***" : "held"}${row.error ? "  ERR " + row.error : ""}`
  );
  if (row.transcript) console.log(`      heard: ${JSON.stringify(row.transcript.slice(0, 70))}`);
  return row;
}

const median = (v) => {
  const s = v.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function main() {
  console.log("hold-arm latency -- what manual endpointing costs on a NORMAL turn\n");
  if (!validateDetector()) {
    console.error("\nThe instrument failed its own check. No sessions opened, nothing spent.");
    process.exit(1);
  }
  console.log(`\nbudget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const out = { at: new Date().toISOString(), n: N, cases: CASES, max_hold_ms: MAX_HOLD_MS, rows: [] };
  for (const m of MODELS) {
    for (const c of CASES) {
      for (let i = 1; i <= N; i++) out.rows.push(await trial(m.trim(), c, i));
    }
  }

  out.tally = {};
  for (const m of MODELS) {
    for (const c of CASES) {
      const rs = out.rows.filter((r) => r.model === m.trim() && r.fixture === c.fixture && !r.error);
      out.tally[`${m.trim()} / ${c.fixture}`] = {
        of: rs.length,
        cut_in: rs.filter((r) => r.spoke_during_hold).length,
        punctuated: `${rs.filter((r) => r.has_terminal_punct).length}/${rs.length}`,
        rules: rs.reduce((a, r) => { a[r.classify_rule || "NO-CLOSE"] = (a[r.classify_rule || "NO-CLOSE"] || 0) + 1; return a; }, {}),
        p50_hold_paid_ms: median(rs.map((r) => r.hold_paid_ms)),
        p50_transcript_at_ms: median(rs.map((r) => r.transcript_at_ms)),
        p50_reply_after_end_ms: median(rs.map((r) => r.reply_after_end_ms)),
        p50_felt_gap_ms: median(rs.map((r) => r.felt_gap_ms)),
      };
    }
  }

  fs.writeFileSync("scripts/probes/results-holdlatency.json", JSON.stringify(out, null, 2) + "\n");

  console.log("\n--- hold-arm latency ---");
  console.log(JSON.stringify(out.tally, null, 2));
  console.log("\nAlready measured with the VENDOR's detector, N=10, for comparison:");
  console.log("  3.8 complete 2,347ms   3.8 trailing 1,179ms");
  console.log("  3.1 complete 1,726ms   3.1 trailing 1,721ms");
  console.log("\nThe bar the plan set: if hold adds more than ~500ms on a COMPLETE");
  console.log("phrase, that is a cost on every turn to fix a defect on some turns.");
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
