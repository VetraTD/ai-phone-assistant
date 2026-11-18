// ---------------------------------------------------------------------------
// T6's WER pass -- the SAME ten fixtures GPT-Live's G2 used, one take each.
//
// WHY THIS EXISTS RATHER THAN REUSING T1's AUDIO. T1 plays only the two
// trail-off fixtures, and one of them is `trailing_lead_in` ("It's for, uh") --
// two words of a deliberately mumbled, trailing-off phrase chosen to test
// ENDPOINTING, not transcription. Scoring WER over that pair gave a median of
// 0.334 and a FAIL, which says almost nothing about the model: GPT-Live scored
// WER 1.000 on the very same fixture ("Is four a"), and 0.000 on eight others.
//
// A median over two fixtures, one of them adversarial, is a property of the
// fixture list. This plays the ten G2 used, so the number is comparable to the
// one GPT-Live already has instead of being a different measurement wearing the
// same name.
//
// Ten short sessions, roughly three cents.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import {
  openSession, sendAudio, armTurn, waitForQuiet, setupOk,
} from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames, GROUND_TRUTH } from "./lib/audio.js";
import { wer } from "./lib/score.js";
import { commit, priceTokens, priceGeminiByMinutes, summary, reserve } from "./lib/spendLive.js";

const MODEL = process.env.M38 || "gemini-3.8-live";
const SURFACE = "aistudio";

/** The exact G2 list, so the numbers sit beside GPT-Live's without adjustment. */
const FIXTURES = [
  "clean_open", "trailing_lead_in", "no_terminal_punct", "name_spelling",
  "rep_time_q", "rep_confirm", "rep_digits", "rep_close", "barge_in", "partial_digits",
];

/** GPT-Live's G2 result, for the side-by-side. */
const GPTLIVE_G2 = {
  clean_open: 0.0, trailing_lead_in: 1.0, no_terminal_punct: 0.0,
  name_spelling: null, rep_time_q: 0.0, rep_confirm: 0.0,
  rep_digits: 0.0, rep_close: 0.0, barge_in: 0.0, partial_digits: null,
};

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

async function take(fixture) {
  reserve(`T6W/${fixture}`, 60, 0.02);
  let ctx = null;
  const row = { fixture, truth: GROUND_TRUTH[fixture] ?? null };
  const t0 = Date.now();
  try {
    ctx = await openSession({ surface: SURFACE, model: MODEL, answerTools: true });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;
    armTurn(st);
    await paceFrames(pcmFrames(fixture), (f) => sendAudio(ctx.session, f));
    await paceFrames(silenceFrames("pcm16k", 2500), (f) => sendAudio(ctx.session, f));
    await waitForQuiet(st, { quietMs: 900, maxMs: 10000 });

    row.heard = (st.inputTranscript || "").trim();
    row.blank = row.heard.length === 0;
    row.wer = row.truth ? Number(wer(row.truth, row.heard).toFixed(3)) : null;
  } catch (e) {
    row.error = e.message;
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const u = ctx?.state?.usage || {};
  let priced = priceTokens(MODEL, {
    audio_in: u.audio_in || 0, audio_out: u.audio_out || 0,
    text_in: u.text_in || 0, text_out: u.text_out || 0,
  });
  if (!(priced.usd > 0)) {
    priced = priceGeminiByMinutes({
      inSeconds: (Date.now() - t0) / 1000,
      outSeconds: (ctx?.state?.audioBytes || 0) / (24000 * 2),
    });
    row.usd_estimated = true;
  }
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "T6W", arm: MODEL, label: `t6w-${fixture}`, model: MODEL, usd: priced.usd, estimated: !!row.usd_estimated, note: row.error });

  const g = GPTLIVE_G2[fixture];
  console.log(
    `  ${fixture.padEnd(18)} WER ${String(row.wer ?? "-").padEnd(6)} ` +
    `(gpt-live ${g === null ? "n/a" : g})   ` +
    `${row.blank ? "*** BLANK ***" : JSON.stringify(String(row.heard).slice(0, 62))}`
  );
  return row;
}

async function main() {
  console.log(`T6 WER pass -- ${FIXTURES.length} fixtures, the G2 list.  ${MODEL}`);
  console.log(`  budget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const out = { at: new Date().toISOString(), model: MODEL, fixtures: FIXTURES, rows: [] };
  for (const f of FIXTURES) out.rows.push(await take(f));

  const scored = out.rows.filter((r) => !r.error && r.wer != null);
  const vals = scored.map((r) => r.wer).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;

  out.tally = {
    n: scored.length,
    median_wer: med,
    mean_wer: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)) : null,
    perfect: scored.filter((r) => r.wer === 0).length,
    blank_transcripts: out.rows.filter((r) => r.blank).length,
    errored: out.rows.filter((r) => r.error).length,
  };
  out.verdict = {
    predicted: "median at or below 0.10",
    measured: med,
    fails: med != null && med > 0.25,
    gptlive_g2_median: 0.0,
    note: "trailing_lead_in is an ENDPOINTING fixture, two words of deliberate mumble. GPT-Live scored 1.000 on it. It is reported but it is not a transcription result.",
  };

  fs.writeFileSync("scripts/probes/results-t6-wer.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\n  median WER ${med}   perfect ${out.tally.perfect}/${out.tally.n}   blank ${out.tally.blank_transcripts}`);
  console.log(`  ${out.verdict.fails ? "*** FAILS ***" : "passes"}   (GPT-Live G2 median was 0.000)`);
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
