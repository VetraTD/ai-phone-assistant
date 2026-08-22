#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PROVIDERS } from "../lib/tts/providers.js";
import { VOICE_CATALOG } from "../config/voices.js";
import { READBACK_LINES } from "../lib/tts/readbackScript.js";
import { toSpeakable } from "../lib/voice/speakableText.js";
import { createSttStream } from "../lib/voice/sttStream.js";
import { wordErrorRate } from "../lib/sttEval/wer.js";
import { mulawToWav } from "../lib/audio/wav.js";

// ---------------------------------------------------------------------------
// Does the TTS READ THINGS PROPERLY, and what does each one cost in latency?
//
// Not the blind A/B. That asks which voice is nicer; this asks whether the
// appointment time the caller writes down is the one we said. A mispronounced
// vowel is a preference. "Two thirty" read as "two point three zero" is a
// wrong appointment, and no amount of pleasant timbre fixes it.
//
//   node scripts/tts-readback.js                       # google vs elevenlabs
//   node scripts/tts-readback.js --providers google
//   node scripts/tts-readback.js --stt google          # instrument choice
//
// HOW THE CORRECTNESS HALF WORKS, and its limits.
//
// Each line is synthesized, converted to the 8kHz mu-law a phone call actually
// carries, and read BACK through speech-to-text. The transcript is compared to
// what a correct reading should sound like. A disagreement is a FLAG, not a
// verdict: STT makes its own mistakes, and this cannot tell them apart from the
// synthesizer's.
//
// What makes it useful anyway is that every provider is read by the SAME STT on
// the SAME sentences, so a difference BETWEEN providers is the synthesizer.
// And the point is not to score — it is to turn "listen to thirty clips" into
// "listen to the four that came back wrong". The audio is written out for
// exactly that.
//
// The instrument is Deepgram by default, because C5b measured it at 0.091 WER
// against Google STT v2's on the same audio, and an instrument should be the
// more accurate one. It is a dev harness on a workstation, not a deployment —
// the credential boundary that forbids Deepgram in a covered PROJECT does not
// apply to measuring on a laptop.
//
// THE TEXT IS WHAT PRODUCTION SENDS. Every line goes through toSpeakable()
// first, the same transform session.js applies before TTS. Skipping it would
// measure a string no vendor ever receives.
// ---------------------------------------------------------------------------

const FRAME_BYTES = 160; // 20ms of 8kHz mu-law
const FRAME_MS = 20;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff);
const MAX_SILENCE_MS = 6000;
const UTTERANCE_QUIET_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each adapter wants its own idea of a voice, and passing undefined is not the
// same as passing a default: ElevenLabs reads `voice.elevenVoiceId` off it and
// dies on undefined. Same map scripts/voice-ab-blind.js uses, so the two
// harnesses compare the same voices.
const VOICES = {
  google: { id: process.env.GOOGLE_TTS_VOICE || "en-US-Chirp3-HD-Aoede" },
  elevenlabs: VOICE_CATALOG[0],
  cartesia: { id: process.env.CARTESIA_VOICE_ID || "a0e99841-438c-4a64-b679-ae501e7d6091" },
  inworld: { id: process.env.INWORLD_VOICE_ID || "Ashley" },
  gemini: { id: process.env.GEMINI_TTS_VOICE || "Kore" },
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
  };
  return {
    providers: opt("--providers", "google,elevenlabs").split(",").map((s) => s.trim()).filter(Boolean),
    stt: opt("--stt", "standard") === "google" ? "hipaa" : "standard",
    outDir: opt("--out", path.join("eval", "results", "tts-readback")),
    only: opt("--only", null),
  };
}

/** Read synthesized audio back through STT, paced like a real call. */
async function readBack(mulaw, tier, label) {
  const finals = [];
  let lastFinalAt = null;
  let speechDoneAt = null;
  let failure = null;

  const stt = await createSttStream({
    tier,
    language: "en-US",
    callSid: `READBACK-${label}`,
    onFinal: (text) => {
      lastFinalAt = performance.now();
      finals.push(text);
    },
    onInterim: () => {},
    onUtteranceEnd: () => {},
    onError: (err) => {
      failure = err?.message || String(err);
    },
  });

  try {
    for (let i = 0; i < mulaw.length; i += FRAME_BYTES) {
      stt.sendAudio(mulaw.subarray(i, i + FRAME_BYTES));
      await sleep(FRAME_MS);
    }
    speechDoneAt = performance.now();

    // Then silence. Google STT v2 endpoints on RECEIVED silence rather than on
    // wall-clock idle — a stream that simply stops writing gets no final at
    // all. Same reason scripts/stt-ab.js does this.
    const deadline = performance.now() + MAX_SILENCE_MS;
    while (failure === null && performance.now() < deadline) {
      const settledSince = Math.max(lastFinalAt ?? -Infinity, speechDoneAt);
      if (lastFinalAt !== null && performance.now() - settledSince >= UTTERANCE_QUIET_MS) break;
      stt.sendAudio(SILENCE_FRAME);
      await sleep(FRAME_MS);
    }
  } finally {
    try {
      stt.close();
    } catch {
      /* already gone */
    }
  }

  return { text: finals.join(" ").replace(/\s+/g, " ").trim(), error: failure };
}

async function main() {
  const opts = parseArgs(process.argv);
  const lines = opts.only ? READBACK_LINES.filter((l) => l.label === opts.only) : READBACK_LINES;
  if (!lines.length) throw new Error(`no line matches --only ${opts.only}`);

  for (const name of opts.providers) {
    if (!PROVIDERS[name]) throw new Error(`unknown provider ${name}; have ${Object.keys(PROVIDERS).join(", ")}`);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const rows = [];

  for (const providerName of opts.providers) {
    const provider = PROVIDERS[providerName];
    console.log(`\n=== ${providerName} — ${provider.label} ===`);

    for (const line of lines) {
      // What production actually hands to TTS.
      const spoken = toSpeakable(line.text);

      let mulaw;
      let ttfaMs = null;
      try {
        const out = await provider.synthesize({ text: spoken, voice: VOICES[providerName] });
        mulaw = out.mulaw;
        ttfaMs = out.ttfaMs;
      } catch (err) {
        console.log(`  ${line.label.padEnd(20)} SYNTH FAILED: ${err?.message}`);
        rows.push({ provider: providerName, label: line.label, category: line.category, error: String(err?.message) });
        continue;
      }

      const wavPath = path.join(opts.outDir, `${providerName}-${line.label}.wav`);
      fs.writeFileSync(wavPath, mulawToWav(mulaw));

      const back = await readBack(mulaw, opts.stt, `${providerName}-${line.label}`);
      // An object, not a number — and the breakdown matters here. Substitutions
      // are a MISREADING ("two point three zero" for "two thirty"); deletions
      // are words that never arrived, which is more often the STT giving up
      // than the synthesizer skipping them.
      const scored = back.text
        ? wordErrorRate(line.reference, back.text)
        : { wer: 1, substitutions: 0, deletions: 0, insertions: 0 };
      const wer = scored.wer;

      rows.push({
        provider: providerName,
        label: line.label,
        category: line.category,
        why: line.why,
        sent: spoken,
        reference: line.reference,
        heard: back.text,
        wer: Number(wer.toFixed(3)),
        substitutions: scored.substitutions,
        deletions: scored.deletions,
        insertions: scored.insertions,
        synthMs: ttfaMs,
        audioSec: Number((mulaw.length / 8000).toFixed(2)),
        wav: wavPath,
        ...(back.error ? { sttError: back.error } : {}),
      });

      const flag = wer > 0 ? "  <-- LISTEN" : "";
      console.log(
        `  ${line.label.padEnd(20)} wer ${String(wer.toFixed(2)).padStart(5)}   synth ${String(ttfaMs).padStart(5)}ms   audio ${String((mulaw.length / 8000).toFixed(1)).padStart(4)}s${flag}`
      );
    }
  }

  // ----- summary -------------------------------------------------------
  console.log("\n=== latency, per provider ===");
  for (const p of opts.providers) {
    const mine = rows.filter((r) => r.provider === p && r.synthMs != null);
    if (!mine.length) continue;
    const ms = mine.map((r) => r.synthMs).sort((a, b) => a - b);
    const chars = mine.reduce((n, r) => n + r.sent.length, 0);
    const total = mine.reduce((n, r) => n + r.synthMs, 0);
    console.log(
      `  ${p.padEnd(12)} median ${String(ms[Math.floor(ms.length / 2)]).padStart(5)}ms   worst ${String(ms[ms.length - 1]).padStart(5)}ms   ${(total / chars).toFixed(1)} ms/char`
    );
  }

  // ----- the shortlist ---------------------------------------------------
  //
  // Ranked by PROVIDER DISAGREEMENT first, and that ordering was learned by
  // running it. Scoring a readback against a hand-written "what it should sound
  // like" produced false flags immediately: lib/sttEval/wer.js canonicalises
  // number words to digits for an STT-vs-STT comparison, so "two thirty PM" and
  // "2:30 PM" — the SAME reading — scored 0.33. A flag list full of artefacts is
  // worse than no flag list.
  //
  // Every provider is read by the SAME recogniser on the SAME sentence, so when
  // two of them come back different, the recogniser is not what changed. That
  // needs no reference and no normalisation guesswork.
  const byLine = new Map();
  for (const r of rows) {
    if (!byLine.has(r.label)) byLine.set(r.label, []);
    byLine.get(r.label).push(r);
  }

  const shortlist = [];
  for (const [label, group] of byLine) {
    const usable = group.filter((r) => r.heard);
    let disagreement = 0;
    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        disagreement = Math.max(disagreement, wordErrorRate(usable[i].heard, usable[j].heard).wer);
      }
    }
    const worstVsRef = Math.max(0, ...group.map((r) => r.wer ?? 0));
    if (disagreement > 0 || worstVsRef > 0) shortlist.push({ label, group, disagreement, worstVsRef });
  }
  shortlist.sort((a, b) => b.disagreement - a.disagreement || b.worstVsRef - a.worstVsRef);

  console.log("\n=== what to LISTEN to ===");
  if (!shortlist.length) console.log("  nothing flagged");
  for (const item of shortlist) {
    const one = item.group[0];
    const tag =
      item.disagreement > 0
        ? `PROVIDERS DISAGREE (${item.disagreement.toFixed(2)}) — one of them is misreading`
        : "differs from the expected reading only — may be a scoring artefact";
    console.log(`\n  ${item.label}  (${one.category})  ${tag}`);
    console.log(`    looking for : ${one.why}`);
    console.log(`    sent to TTS : ${one.sent}`);
    for (const r of item.group) {
      console.log(`    ${r.provider.padEnd(11)} heard : ${r.heard || "(nothing)"}`);
      console.log(`    ${"".padEnd(11)} listen: ${r.wav}`);
    }
  }

  if (opts.providers.length < 2) {
    console.log(
      "\nOnly one provider ran, so there is NO disagreement signal — everything\n" +
        "above is scored against a hand-written expectation and includes\n" +
        "normalisation artefacts. Run two providers for the comparison that works."
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(opts.outDir, `readback-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ stt: opts.stt, rows }, null, 2));
  console.log(`\nreport: ${reportPath}`);
  console.log(
    "A flag is not a verdict — the recogniser makes its own mistakes, and the\n" +
      "reference score in particular carries normalisation artefacts. What isolates\n" +
      "the synthesizer is providers DISAGREEING on the same line. Listen to those."
  );
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
