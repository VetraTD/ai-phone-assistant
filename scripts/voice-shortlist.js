#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS } from "../lib/tts/providers.js";
import { mulawToWav } from "../lib/audio/wav.js";
import { VOICE_CATALOG } from "../config/voices.js";

// ---------------------------------------------------------------------------
// Voice shortlist — NOT blind, and deliberately so.
//
// voice-ab-blind.js answers "which ENGINE sounds best", one voice per vendor,
// identities hidden. This answers the question that comes after it: having
// narrowed to the two engines that are viable in realtime (ElevenLabs and
// Cartesia — the other two are batch APIs at 1.8s and 5.8s to first audio),
// WHICH VOICE do you actually want on the phone.
//
// Clips are grouped by SENTENCE, not by voice, so each group compares the same
// words across every candidate. Same 8kHz mu-law output as the blind pack, so
// the two runs are directly comparable.
//
//   node scripts/voice-shortlist.js
//   node scripts/voice-shortlist.js --lines greeting,digits
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

const byId = (id) => VOICE_CATALOG.find((v) => v.elevenVoiceId === id);

/**
 * The shortlist. ElevenLabs entries come from config/voices.js so they carry
 * the per-voice stability the live path would actually use — anything else
 * would compare a tuned voice against an untuned one.
 *
 * Cartesia names are its own labels; the descriptors ("Welcome Agent",
 * "Composed Concierge") are why these four were picked out of 417 English
 * voices — they are the ones the vendor shapes for front-desk work.
 */
const PRESETS = {
  us: [
    { label: "ElevenLabs / Bella (US)", provider: "elevenlabs", voice: byId("hpp4J3VqNfWAUOO0d1Us") },
    { label: "ElevenLabs / Sarah (US)", provider: "elevenlabs", voice: byId("EXAVITQu4vr4xnSDxMaL") },
    { label: "ElevenLabs / Matilda (US)", provider: "elevenlabs", voice: byId("XrExE9yKIg1WjnnlVkGX") },
    { label: "ElevenLabs / Alice (GB)", provider: "elevenlabs", voice: byId("Xb7hH8MSUJpSbSDYk0k2") },
    { label: "Cartesia / Ellen (Welcome Agent)", provider: "cartesia", voice: { id: "a151affa-feaa-439e-8df8-c1d3f91dc6b9" } },
    { label: "Cartesia / Whitney (Composed Concierge)", provider: "cartesia", voice: { id: "f3c7d5d2-c1e1-41a0-bd88-8b5512be5335" } },
    { label: "Cartesia / Clementine (Hospitable Host)", provider: "cartesia", voice: { id: "4111bc29-d7ff-4a15-90db-819f7b4f7706" } },
    { label: "Cartesia / Iris (Friendly Specialist)", provider: "cartesia", voice: { id: "c894559e-d529-4d70-a6fb-3330ecf7ef6b" } },
  ],

  // Cartesia exposes no accent field — these were found by searching the 417
  // English voices' free-text descriptions for accent markers, which turned up
  // 15 across British/Irish. Alice leads the list as the reference point: she
  // is the only British voice already in config/voices.js, so she is what
  // switching would be measured against.
  british: [
    { label: "ElevenLabs / Alice (GB) [incumbent option]", provider: "elevenlabs", voice: byId("Xb7hH8MSUJpSbSDYk0k2") },
    { label: "Cartesia / Victoria (Refined Coordinator, GB)", provider: "cartesia", voice: { id: "dc30854e-e398-4579-9dc8-16f6cb2c19b9" } },
    { label: "Cartesia / Lucy (Capable Coordinator, GB)", provider: "cartesia", voice: { id: "2f251ac3-89a9-4a77-a452-704b474ccd01" } },
    { label: "Cartesia / Evie (Engaging Expert, GB)", provider: "cartesia", voice: { id: "e5d4c33a-d8f6-46e8-a10f-b5afecc35648" } },
    { label: "Cartesia / Gemma (Decisive Agent, GB)", provider: "cartesia", voice: { id: "62ae83ad-4f6a-430b-af41-a9bede9286ca" } },
    { label: "Cartesia / Siobhan (Warm Welcomer, IE)", provider: "cartesia", voice: { id: "d79d2b77-9192-4e10-9407-5d43ca034803" } },
  ],
};

const SHORTLIST = PRESETS[opt("--preset", "us")] || PRESETS.us;

// The two sentences that decide it. Greeting is the identity moment every
// caller hears; digits is where 8kHz TTS most often falls apart and what a
// receptionist reads back constantly.
const ALL_LINES = {
  greeting: "Thanks for calling Brightwork Dental, this is Ava. How can I help?",
  digits: "And the best number for you is five five five, two three four, five six seven eight?",
  spelling: "Let me read that back — N as in November, I, T, H, I, N. Nithin.",
};

const wanted = opt("--lines", "greeting,digits").split(",").map((s) => s.trim());
const LINES = wanted.filter((l) => ALL_LINES[l]).map((l) => [l, ALL_LINES[l]]);

const runId = opt("--run", `voices-${new Date().toISOString().slice(0, 10)}`);
const outDir = path.resolve("voice-previews", runId);
fs.mkdirSync(outDir, { recursive: true });

const manifest = [];
let n = 0;

for (const [lineName, text] of LINES) {
  for (const entry of SHORTLIST) {
    n += 1;
    const file = `${String(n).padStart(2, "0")}-sample.wav`;
    process.stdout.write(`  ${String(n).padStart(2, "0")} ${lineName.padEnd(9)} ${entry.label.padEnd(42)}`);
    try {
      const { mulaw, ttfaMs } = await PROVIDERS[entry.provider].synthesize({
        text,
        previousText: "",
        voice: entry.voice,
      });
      fs.writeFileSync(path.join(outDir, file), mulawToWav(mulaw));
      manifest.push({ file, line: lineName, label: entry.label, ttfaMs });
      console.log(` ${(mulaw.length / 8000).toFixed(2)}s, TTFA ${ttfaMs}ms`);
    } catch (err) {
      // One voice failing must not cost the pack — the rest are still worth
      // hearing, and the gap is reported rather than hidden.
      console.log(` FAILED: ${err.message.slice(0, 70)}`);
      manifest.push({ file: null, line: lineName, label: entry.label, error: err.message });
    }
  }
}

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

let md = `# Voice shortlist — ${runId}\n\n`;
md += `Not blind: this picks a VOICE, having already picked the engine.\n`;
md += `Grouped by sentence — compare within each group.\n\n`;
md += `| clip | sentence | voice | TTFA |\n|---|---|---|---|\n`;
for (const m of manifest) {
  md += `| ${m.file ?? "—"} | ${m.line} | ${m.label} | ${m.error ? "FAILED" : m.ttfaMs + "ms"} |\n`;
}
fs.writeFileSync(path.join(outDir, "SHORTLIST.md"), md);

console.log(`\n  ${manifest.filter((m) => m.file).length} clips -> ${outDir}`);
console.log(`  Map: ${path.join(outDir, "SHORTLIST.md")}`);
console.log(`  Play: node scripts/voice-ab-call.js --run ${runId} --to <your number> --base <tunnel>\n`);
