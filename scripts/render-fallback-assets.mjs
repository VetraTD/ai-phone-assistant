#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LVX174: render the two fixed lines the Twilio fallback Function can play
// (twilio/fallback/fallback.js: noAnswer, technical) as WAV files to upload as
// PUBLIC Assets in each Twilio account's fallback Service. Same render as the
// voice server's own clips (lib/voice/fixedLines.js lineClipSpec + Google TTS
// Chirp 3 HD), so a caller hears the same voice whether our server is up or not.
//
//   node scripts/render-fallback-assets.mjs --voice Kore --lang en-GB [--out <dir>]
//
// Writes <out>/<voice>-<lang>-noanswer.wav and -technical.wav (lowercase), the
// names fallback.js asks for with a=<voice>-<lang>, e.g. a=kore-en-gb.
// Paid (cents): two short Google TTS renders.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { lineClipSpec } from "../lib/voice/fixedLines.js";
import { synthesizeSsmlMulaw } from "../services/googleTts.js";
import { mulawToWav } from "../lib/audio/wav.js";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const voice = arg("voice", "Kore");
const lang = arg("lang", "en-GB");
const out = path.resolve(arg("out", "fallback-assets"));
if (!/^[A-Za-z]+$/.test(voice) || !/^[a-z]{2}-[A-Z]{2}$/.test(lang)) {
  console.error("Usage: --voice <LiveVoiceName> --lang <xx-YY>");
  process.exit(1);
}
const prefix = `${voice}-${lang}`.toLowerCase();
fs.mkdirSync(out, { recursive: true });
for (const key of ["noAnswer", "technical"]) {
  const spec = lineClipSpec(key, { languageCode: lang, liveVoice: voice });
  const audio = await synthesizeSsmlMulaw(spec.ssml, spec.ttsVoice);
  if (!audio?.length) throw new Error(`empty render for ${key}`);
  const file = path.join(out, `${prefix}-${key.toLowerCase()}.wav`);
  fs.writeFileSync(file, mulawToWav(audio));
  console.log(`${file}  ${(audio.length / 8000).toFixed(1)} s  (${spec.ttsVoice})`);
}
console.log(`\nUpload both as PUBLIC Assets in the fallback Service, then add &a=${prefix} to the number's fallback URL.`);
