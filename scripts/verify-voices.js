/**
 * Verifies every voice ID in config/voices.js against the live ElevenLabs
 * account, and optionally synthesizes a preview WAV for each so you can hear
 * them before choosing defaults.
 *
 * Usage:
 *   node --env-file=.env scripts/verify-voices.js
 *   node --env-file=.env scripts/verify-voices.js --preview
 *
 * --preview writes previews to ./voice-previews/<id>.mp3 (playable on any
 * device; the phone pipeline uses 8kHz mulaw, so these will sound better than
 * the real call).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { VOICE_CATALOG } from "../config/voices.js";

const API_KEY = process.env.ELEVENLABS_API_KEY;
const WANT_PREVIEW = process.argv.includes("--preview");
const PREVIEW_DIR = path.resolve("voice-previews");

if (!API_KEY) {
  console.error("ELEVENLABS_API_KEY is not set.");
  console.error("Run with: node --env-file=.env scripts/verify-voices.js");
  process.exit(1);
}

async function fetchAccountVoices() {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": API_KEY },
  });
  if (!res.ok) {
    throw new Error(
      `GET /v1/voices failed: ${res.status} ${res.statusText}. ` +
        (res.status === 401 ? "Check that ELEVENLABS_API_KEY is valid." : "")
    );
  }
  const body = await res.json();
  return new Map((body.voices || []).map((v) => [v.voice_id, v]));
}

async function writePreview(entry) {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${entry.elevenVoiceId}` +
    `?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: entry.previewText,
      model_id: "eleven_flash_v2_5",
      voice_settings: entry.voiceSettings,
    }),
  });
  if (!res.ok) return `preview failed (${res.status})`;
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const file = path.join(PREVIEW_DIR, `${entry.id}.mp3`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const accountVoices = await fetchAccountVoices();
console.log(`Account has ${accountVoices.size} voices available.\n`);

let ok = 0;
const problems = [];

for (const entry of VOICE_CATALOG) {
  const live = accountVoices.get(entry.elevenVoiceId);
  if (!live) {
    problems.push(entry);
    console.log(`MISSING  ${entry.label.padEnd(12)} ${entry.elevenVoiceId}  (catalog id: ${entry.id})`);
    continue;
  }
  ok++;
  const nameNote =
    live.name.toLowerCase() === entry.label.toLowerCase()
      ? ""
      : `  [account calls it "${live.name}"]`;
  let previewNote = "";
  if (WANT_PREVIEW) previewNote = `  -> ${await writePreview(entry)}`;
  console.log(`OK       ${entry.label.padEnd(12)} ${entry.elevenVoiceId}${nameNote}${previewNote}`);
}

console.log(`\n${ok}/${VOICE_CATALOG.length} catalog voices exist on this account.`);

if (problems.length) {
  console.log("\nFix the missing ones in config/voices.js. Voices on your account:\n");
  for (const v of accountVoices.values()) {
    console.log(`  ${v.voice_id}  ${v.name}`);
  }
  process.exitCode = 1;
} else {
  console.log("All good — every catalog voice exists on this account.");
}
