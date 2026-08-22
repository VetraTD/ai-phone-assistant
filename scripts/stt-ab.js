#!/usr/bin/env node
// ---------------------------------------------------------------------------
// C5b — Deepgram vs Google Speech-to-Text v2, on the SAME recorded audio.
//
//   npm run stt:ab                    both providers, both scripts
//   npm run stt:ab -- --provider google
//   npm run stt:ab -- --script representative
//   npm run stt:ab -- --repeat 3      average over N passes
//
// WHY THIS EXISTS, AND WHY IT IS NOT `npm run eval`
//
// The ledger nominated `npm run eval` + `eval:compare` as the path. They
// cannot do this job: eval/run.js drives lib/harness/textSession.js, which has
// no audio in it at all — A0 says so explicitly ("no audio, no carrier, no
// TTS"). It measures the LLM. Nothing in this repo puts recorded audio through
// a speech recogniser, so this harness is new.
//
// It drives the REAL modules through the REAL seam — createSttStream with a
// tier, exactly as lib/voice/session.js calls it — rather than a bespoke
// client. A comparison of two purpose-built probes would measure the probes.
//
// WHAT IS MEASURED
//
//   stt_ms   time from the last frame of SPEECH audio to the LAST final that
//            completes the utterance. The same quantity A0 recorded as
//            stt_endpoint_ms, and it sits inside the turn loop: every
//            millisecond is silence the caller is listening to.
//
//            Measured to the LAST final, not the first, and that is not a
//            detail. Deepgram finalises mid-utterance when the caller pauses —
//            "My number is five five five, [pause] two" arrives as two finals —
//            so a harness that stopped at the first would report a fast, WRONG
//            transcript and score the provider well for it. The first version
//            of this script did exactly that and produced NEGATIVE latencies,
//            because the first final landed before the audio had finished.
//   WER      word error rate against lib/probe/script.js's ground truth, which
//            is the text the audio was synthesized FROM, so it is exact.
//
// METHODOLOGY, INCLUDING WHAT IT CANNOT TELL YOU
//
//  - Audio is paced at real time, 160-byte / 20ms frames, exactly as Twilio
//    delivers it. This is not politeness: Google endpoints on RECEIVED
//    SILENCE, not on wall-clock idle, so a harness that blasted the file at
//    full speed and stopped would measure an endpointing that never fires.
//    Both providers get identical pacing and identical trailing silence.
//  - The audio is SYNTHETIC (Google TTS, en-US-Chirp3-HD-Charon) and clean.
//    Absolute WER here is optimistic for both providers; a real handset adds
//    noise, accents and a codec. The COMPARISON is fair because the input is
//    byte-identical. The absolute number is not a field measurement.
//  - The audio was synthesized by GOOGLE TTS, which may flatter Google STT.
//    Read a Google win as "at least this good", never as a margin.
//  - Both providers format numbers by default, so WER is reported normalised
//    (spoken and written digits treated alike) AND raw. See lib/sttEval/wer.js.
// ---------------------------------------------------------------------------

import "dotenv/config";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { createSttStream } from "../lib/voice/sttStream.js";
import { SCRIPT_LINES, REPRESENTATIVE_LINES, audioPathFor } from "../lib/probe/script.js";
import { corpusWordErrorRate, wordErrorRate } from "../lib/sttEval/wer.js";

const FRAME_BYTES = 160; // 20ms of 8kHz mulaw
const FRAME_MS = 20;
/** mu-law digital silence. Twilio sends these continuously when nobody speaks. */
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff);
/** How long to keep streaming silence while waiting for the provider to endpoint. */
const MAX_SILENCE_MS = 8000;
/**
 * Quiet period after a final before the utterance is considered complete.
 *
 * Longer than Deepgram's utterance_end_ms (1000ms) on purpose: the gap between
 * two fragments of one paused utterance must not be mistaken for the end of
 * the whole thing, or the measurement rewards the provider that gives up
 * earliest.
 */
const UTTERANCE_QUIET_MS = 1500;

function parseArgs(argv) {
  const args = { providers: ["deepgram", "google"], scripts: ["diagnostic", "representative"], repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") args.providers = [argv[++i]];
    else if (a === "--script") args.scripts = [argv[++i]];
    else if (a === "--repeat") args.repeat = Math.max(1, parseInt(argv[++i], 10) || 1);
  }
  return args;
}

const SCRIPTS = { diagnostic: SCRIPT_LINES, representative: REPRESENTATIVE_LINES };

/** Providers are chosen by tier, exactly as a call does. */
const TIER_FOR = { deepgram: "standard", google: "hipaa" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Stream one recorded utterance through one provider and wait for its final.
 *
 * @param {string} provider
 * @param {{label: string, text: string}} line
 * @returns {Promise<{label:string, reference:string, hypothesis:string, sttMs:number|null, interims:number, error?:string}>}
 */
async function runOne(provider, line) {
  const file = audioPathFor(line.label);
  if (!fs.existsSync(file)) throw new Error(`missing audio: ${file} (run: node scripts/latency-probe.js --synth)`);
  const mulaw = fs.readFileSync(file);

  const finals = [];
  let firstFinalAt = null;
  let lastFinalAt = null;
  let speechDoneAt = null;
  let interims = 0;
  let utteranceEnds = 0;
  let failure = null;

  const stt = await createSttStream({
    tier: TIER_FOR[provider],
    language: "en-US",
    callSid: `C5B-${provider}-${line.label}`,
    onFinal: (text) => {
      const at = performance.now();
      if (firstFinalAt === null) firstFinalAt = at;
      lastFinalAt = at;
      finals.push(text);
    },
    onInterim: () => { interims++; },
    onUtteranceEnd: () => { utteranceEnds++; },
    onError: (err) => { failure = err?.message || String(err); },
  });

  try {
    // Speech, paced at real time.
    for (let i = 0; i < mulaw.length; i += FRAME_BYTES) {
      stt.sendAudio(mulaw.subarray(i, i + FRAME_BYTES));
      await sleep(FRAME_MS);
    }
    speechDoneAt = performance.now();

    // Then silence, which is what a caller who has stopped talking sounds
    // like. Both providers need it: this is where endpointing happens, and
    // Google will not endpoint at all without it.
    //
    // Keep going until the utterance has actually settled — a final, followed
    // by a quiet stretch with no further finals — rather than stopping at the
    // first one. A paused utterance arrives in pieces.
    const deadline = performance.now() + MAX_SILENCE_MS;
    while (failure === null && performance.now() < deadline) {
      if (lastFinalAt !== null && performance.now() - lastFinalAt >= UTTERANCE_QUIET_MS) break;
      stt.sendAudio(SILENCE_FRAME);
      await sleep(FRAME_MS);
    }
  } finally {
    try { stt.close(); } catch { /* already gone */ }
  }

  // A final that lands BEFORE the audio ends means the provider had the
  // transcript before the caller stopped talking — a zero wait, not a negative
  // one. Recorded as 0 and flagged, because silently clamping would hide the
  // fact that it happened.
  const rawMs = lastFinalAt !== null && speechDoneAt !== null ? lastFinalAt - speechDoneAt : null;

  return {
    label: line.label,
    reference: line.text,
    hypothesis: finals.join(" ").replace(/\s+/g, " ").trim(),
    sttMs: rawMs === null ? null : Math.max(0, Math.round(rawMs)),
    firstFinalMs:
      firstFinalAt !== null && speechDoneAt !== null
        ? Math.max(0, Math.round(firstFinalAt - speechDoneAt))
        : null,
    earlyFinal: rawMs !== null && rawMs < 0,
    finals: finals.length,
    interims,
    utteranceEnds,
    ...(failure ? { error: failure } : {}),
  };
}

async function runProvider(provider, scriptName, lines, repeat) {
  const rows = [];
  for (let pass = 0; pass < repeat; pass++) {
    for (const line of lines) {
      // Serial on purpose. Concurrent streams would contend for the same
      // account's rate limits and inflate exactly the number being measured.
      const row = await runOne(provider, line);
      rows.push({ ...row, provider, script: scriptName, pass });
      const wer = wordErrorRate(row.reference, row.hypothesis);
      process.stdout.write(
        `  ${provider.padEnd(8)} ${row.label.padEnd(20)} ` +
          `${row.sttMs === null ? "  NO FINAL" : String(row.sttMs).padStart(6) + "ms"} ` +
          `f=${row.finals} wer=${wer.wer.toFixed(3)}  "${row.hypothesis.slice(0, 60)}"` +
          `${row.earlyFinal ? " [final before speech ended]" : ""}${row.error ? ` ERROR: ${row.error}` : ""}\n`
      );
    }
  }
  return rows;
}

function summarise(rows) {
  const answered = rows.filter((r) => r.sttMs !== null);
  const latencies = answered.map((r) => r.sttMs);
  const pairs = rows.map((r) => ({ reference: r.reference, hypothesis: r.hypothesis }));
  return {
    utterances: rows.length,
    noFinal: rows.length - answered.length,
    sttMsP50: percentile(latencies, 50),
    sttMsP95: percentile(latencies, 95),
    sttMsMax: latencies.length ? Math.max(...latencies) : null,
    normalised: corpusWordErrorRate(pairs),
    raw: corpusWordErrorRate(pairs, { expandNumbers: false }),
  };
}

const args = parseArgs(process.argv.slice(2));
const all = [];

for (const scriptName of args.scripts) {
  const lines = SCRIPTS[scriptName];
  if (!lines) throw new Error(`unknown script "${scriptName}"`);
  for (const provider of args.providers) {
    console.log(`\n### ${provider} / ${scriptName} (${lines.length} utterances x${args.repeat})`);
    all.push(...(await runProvider(provider, scriptName, lines, args.repeat)));
  }
}

console.log("\n" + "=".repeat(78));
console.log("C5b — STT A/B on identical recorded audio");
console.log("=".repeat(78));

for (const scriptName of args.scripts) {
  console.log(`\nSCRIPT: ${scriptName}`);
  console.log(
    "  provider  utts  noFinal   stt_p50   stt_p95   stt_max   WER(norm)   WER(raw)"
  );
  for (const provider of args.providers) {
    const rows = all.filter((r) => r.provider === provider && r.script === scriptName);
    if (!rows.length) continue;
    const s = summarise(rows);
    console.log(
      `  ${provider.padEnd(9)} ${String(s.utterances).padStart(4)} ${String(s.noFinal).padStart(8)} ` +
        `${String(s.sttMsP50 ?? "-").padStart(9)} ${String(s.sttMsP95 ?? "-").padStart(9)} ` +
        `${String(s.sttMsMax ?? "-").padStart(9)} ${s.normalised.wer.toFixed(4).padStart(11)} ` +
        `${s.raw.wer.toFixed(4).padStart(10)}`
    );
  }
}

// Per-utterance latency, side by side. The aggregate hides the case that
// matters: A0 found ONE scripted line accounted for every timed-out turn.
console.log("\nPER-UTTERANCE stt_ms (the aggregate hides the case that matters):");
const labels = [...new Set(all.map((r) => r.label))];
console.log(`  ${"utterance".padEnd(22)}${args.providers.map((p) => p.padStart(12)).join("")}   delta`);
for (const label of labels) {
  const cells = args.providers.map((p) => {
    const rows = all.filter((r) => r.label === label && r.provider === p && r.sttMs !== null);
    return rows.length ? Math.round(rows.reduce((a, b) => a + b.sttMs, 0) / rows.length) : null;
  });
  const delta = cells.length === 2 && cells[0] !== null && cells[1] !== null ? cells[1] - cells[0] : null;
  console.log(
    `  ${label.padEnd(22)}${cells.map((c) => String(c ?? "NO FINAL").padStart(12)).join("")}` +
      `${delta === null ? "" : `   ${delta > 0 ? "+" : ""}${delta}ms`}`
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = "eval/results";
fs.mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}/stt-ab-${stamp}.json`;
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      caveats: [
        "Synthetic Google TTS audio (en-US-Chirp3-HD-Charon), clean. Absolute WER is optimistic for both.",
        "Audio synthesized by Google TTS may flatter Google STT. Read a Google win as a floor, not a margin.",
        "Real-time 20ms pacing plus trailing mu-law silence, identical for both providers.",
        "stt_ms is last speech frame -> first onFinal, the same quantity A0 called stt_endpoint_ms.",
      ],
      args,
      summaries: Object.fromEntries(
        args.scripts.flatMap((s) =>
          args.providers.map((p) => [
            `${s}/${p}`,
            summarise(all.filter((r) => r.script === s && r.provider === p)),
          ])
        )
      ),
      rows: all,
    },
    null,
    2
  )
);
console.log(`\nWritten: ${outFile}`);
