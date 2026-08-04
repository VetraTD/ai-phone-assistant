#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, providerNames } from "../lib/tts/providers.js";
import { buildBlindPack } from "../lib/tts/blindPack.js";
import { mulawToWav } from "../lib/audio/wav.js";
import { VOICE_CATALOG } from "../config/voices.js";

// ---------------------------------------------------------------------------
// Test 2 — TTS blind A/B.
//
// Synthesizes the same receptionist script through every candidate, converts
// everything to the format a phone call actually carries (8kHz mu-law),
// strips vendor identity, and writes a shuffled listening pack plus a sealed
// answer key.
//
// Usage:
//   node scripts/voice-ab-blind.js --smoke                 # one short line per vendor
//   node scripts/voice-ab-blind.js                         # full pack
//   node scripts/voice-ab-blind.js --providers cartesia,gemini
//   node scripts/voice-ab-blind.js --seed 7
//
// Then judge over a handset (scripts/voice-ab-call.js), not through monitors.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

// What a receptionist actually says. Chosen because these are the things that
// break at 8kHz: a spelled name, a phone number, a time, a price, and one long
// sentence where prosody has room to drift.
const SCRIPT = [
  { line: "greeting", text: "Thanks for calling Brightwork Dental, this is Ava. How can I help?" },
  { line: "spelling", text: "Let me read that back — N as in November, I, T, H, I, N. Nithin." },
  { line: "digits", text: "And the best number for you is five five five, two three four, five six seven eight?" },
  { line: "datetime", text: "I can do Tuesday the fourteenth at ten fifteen, or Wednesday at half past two." },
  { line: "price", text: "A new patient exam and clean is one hundred and eighty dollars." },
  {
    line: "long",
    text:
      "Just so you know, we ask everyone to arrive about ten minutes early for their first visit " +
      "so we can get your paperwork sorted, and if you need to change the appointment please give " +
      "us a ring at least a day ahead and there is no charge at all.",
  },
];

const SMOKE_SCRIPT = [{ line: "smoke", text: "Thanks for calling, how can I help?" }];

const seed = Number.parseInt(opt("--seed", "1"), 10);
const smoke = has("--smoke");
const script = smoke ? SMOKE_SCRIPT : SCRIPT;

const requested = opt("--providers", "all");
const selected =
  requested === "all" ? providerNames() : requested.split(",").map((s) => s.trim()).filter(Boolean);
for (const name of selected) {
  if (!PROVIDERS[name]) {
    console.error(`\n  Unknown provider "${name}". Known: ${providerNames().join(", ")}\n`);
    process.exit(1);
  }
}

// Default voices per vendor. Deliberately each vendor's own flagship rather
// than an attempt to match timbre — the question is which vendor sounds best
// at its best, not which can imitate the incumbent.
const VOICES = {
  elevenlabs: VOICE_CATALOG[0],
  cartesia: { id: process.env.CARTESIA_VOICE_ID || "a0e99841-438c-4a64-b679-ae501e7d6091" },
  inworld: { id: process.env.INWORLD_VOICE_ID || "Ashley" },
  gemini: { id: process.env.GEMINI_TTS_VOICE || "Kore" },
};

async function main() {
  const runId = smoke ? "smoke" : `blind-${new Date().toISOString().slice(0, 10)}-s${seed}`;
  const outDir = path.resolve("voice-previews", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const items = [];
  const stats = [];

  for (const provider of selected) {
    const impl = PROVIDERS[provider];
    // previous_text continuity, where the vendor supports it: prosody across a
    // multi-sentence turn is part of what is being judged, and synthesizing
    // each line cold would flatten exactly that difference. Mirrors production
    // exactly — one turn back, not the whole transcript.
    let previousText = "";
    let chars = 0;
    const ttfas = [];

    for (const { line, text } of script) {
      process.stdout.write(`  ${impl.label} / ${line}... `);
      try {
        const { mulaw, ttfaMs } = await impl.synthesize({
          text,
          previousText,
          voice: VOICES[provider],
        });
        items.push({ provider, line, mulaw, ttfaMs });
        ttfas.push(ttfaMs);
        chars += text.length;
        // REPLACE, don't accumulate — production threads only the previous
        // turn's spoken text (lib/voice/session.js's lastSpokenText is an
        // assignment, not an append). Accumulating made the pack model a
        // pipeline that does not exist.
        previousText = text;
        console.log(`${(mulaw.length / 8000).toFixed(2)}s, TTFA ${ttfaMs}ms`);
      } catch (err) {
        // One vendor failing must not cost the whole pack — the others are
        // still worth listening to, and the gap is reported explicitly.
        console.log(`FAILED: ${err.message}`);
      }
    }

    if (ttfas.length) {
      stats.push({
        provider,
        label: impl.label,
        native: Boolean(impl.native8kMulaw),
        ttfaP50: ttfas.slice().sort((a, b) => a - b)[Math.floor(ttfas.length / 2)],
        ttfaMin: Math.min(...ttfas),
        ttfaMax: Math.max(...ttfas),
        costPer1kChars: impl.costPer1kChars,
        estCostThisScript: Number(((chars / 1000) * impl.costPer1kChars).toFixed(4)),
        lines: ttfas.length,
      });
    }
  }

  if (!items.length) {
    console.error("\n  No audio was produced — check API keys.\n");
    process.exit(1);
  }

  const pack = buildBlindPack({ items, seed });
  for (const entry of pack.entries) {
    fs.writeFileSync(path.join(outDir, entry.filename), mulawToWav(entry.mulaw));
  }

  fs.writeFileSync(
    path.join(outDir, "answer-key.json"),
    JSON.stringify({ seed, key: pack.answerKey }, null, 2)
  );
  fs.writeFileSync(path.join(outDir, "SCORECARD.md"), pack.scorecard);

  // The objective half, kept OUT of the scorecard so it can't bias the ears.
  // Read it only after scoring.
  const objective =
    `# Objective measures (read AFTER scoring)\n\n` +
    `| vendor | native 8k mulaw | TTFA p50 | TTFA min-max | $/1k chars | est. cost for this script |\n` +
    `|---|---|---|---|---|---|\n` +
    stats
      .map(
        (s) =>
          `| ${s.label} | ${s.native ? "yes" : "no (resampled)"} | ${s.ttfaP50}ms | ` +
          `${s.ttfaMin}-${s.ttfaMax}ms | $${s.costPer1kChars} | $${s.estCostThisScript} |`
      )
      .join("\n") +
    `\n\nTTFA for batch APIs (Inworld, Gemini) is whole-utterance latency, not a\n` +
    `streaming first-byte — that difference is real and is what a caller waits.\n`;
  fs.writeFileSync(path.join(outDir, "OBJECTIVE.md"), objective);

  console.log(`\n  ${pack.entries.length} clips written to ${outDir}`);
  console.log(`  Scorecard: ${path.join(outDir, "SCORECARD.md")}`);
  console.log(`  Judge over a handset:  node scripts/voice-ab-call.js --run ${runId}\n`);
  console.log(objective);
}

main().catch((err) => {
  console.error(`\n  ${err.stack || err.message}\n`);
  process.exit(1);
});
