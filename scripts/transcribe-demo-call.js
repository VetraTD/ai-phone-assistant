#!/usr/bin/env node
// One-off: transcribe the marketing site's demo call with word timestamps and
// speaker labels, so the hero can highlight each word as the audio plays.
//
//   node scripts/transcribe-demo-call.js [--in <mp3>] [--out <json>]
//                                        [--vetra-speaker <0|1>] [--dry-run]
//
// Uses Deepgram nova-3 prerecorded (diarize + utterances). The output JSON is
// the artefact that ships; this script is kept only so it can be regenerated
// if the recording changes. Costs roughly a cent per run for a two-minute file.
//
// Speaker ids from diarization are arbitrary. By default the FIRST speaker is
// labelled "Vetra" because the receptionist greets first; pass --vetra-speaker
// to override after listening. Read the printed preview before trusting it.

import "dotenv/config";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DeepgramClient } from "@deepgram/sdk";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const IN = resolve(arg("in", "AI-phone-dashboard/frontend/public/vetra-demo-call.mp3"));
const OUT = resolve(
  arg("out", "AI-phone-dashboard/frontend/src/site/content/demo-call.transcript.json")
);
const VETRA_SPEAKER = arg("vetra-speaker", null);
const DRY_RUN = flag("dry-run");

if (!process.env.DEEPGRAM_API_KEY) {
  console.error("DEEPGRAM_API_KEY is not set (root .env)");
  process.exit(1);
}
if (!existsSync(IN)) {
  console.error(`input not found: ${IN}`);
  process.exit(1);
}

const r2 = (n) => Math.round(Number(n) * 100) / 100;

const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

console.error(`transcribing ${IN} …`);
const res = await client.listen.v1.media.transcribeFile(createReadStream(IN), {
  model: "nova-3",
  language: "en",
  smart_format: true,
  punctuate: true,
  diarize: true,
  utterances: true,
  mip_opt_out: true,
});

if (!res || !res.results) {
  console.error("response carried no results:");
  console.error(JSON.stringify(res).slice(0, 600));
  process.exit(1);
}

const alt = res.results.channels?.[0]?.alternatives?.[0];
const rawWords = alt?.words ?? [];
if (!rawWords.length) {
  console.error("no words in transcript");
  process.exit(1);
}

const words = rawWords.map((w) => ({
  w: w.punctuated_word ?? w.word,
  start: r2(w.start),
  end: r2(w.end),
  speaker: Number(w.speaker ?? 0),
}));

// Turns: prefer Deepgram's utterances (sentence-ish boundaries). Their word
// lists are the same words in order, so index ranges are cumulative. If the
// counts disagree, fall back to splitting on speaker change.
let turns = [];
const utterances = res.results.utterances ?? [];
let cursor = 0;
for (const u of utterances) {
  const n = (u.words ?? []).length;
  turns.push({
    speaker: Number(u.speaker ?? words[cursor]?.speaker ?? 0),
    start: r2(u.start),
    end: r2(u.end),
    from: cursor,
    to: cursor + n,
  });
  cursor += n;
}
if (cursor !== words.length) {
  console.error(
    `utterance word count (${cursor}) != word count (${words.length}); grouping by speaker instead`
  );
  turns = [];
  let from = 0;
  for (let i = 1; i <= words.length; i++) {
    if (i === words.length || words[i].speaker !== words[from].speaker) {
      turns.push({
        speaker: words[from].speaker,
        start: words[from].start,
        end: words[i - 1].end,
        from,
        to: i,
      });
      from = i;
    }
  }
}

const speakerIds = [...new Set(words.map((w) => w.speaker))].sort();
const vetraId = VETRA_SPEAKER !== null ? Number(VETRA_SPEAKER) : words[0].speaker;
const speakers = {};
for (const id of speakerIds) speakers[id] = id === vetraId ? "Vetra" : "Caller";

const duration = r2(res.metadata?.duration ?? words[words.length - 1].end);

const out = {
  version: 1,
  source: "/vetra-demo-call.mp3",
  duration,
  speakers,
  words,
  turns,
};

// Preview so the speaker mapping can be checked by eye before committing.
console.error(`\n${words.length} words, ${turns.length} turns, ${duration}s, speakers ${JSON.stringify(speakers)}\n`);
for (const t of turns.slice(0, 12)) {
  const text = words.slice(t.from, t.to).map((w) => w.w).join(" ");
  console.error(`[${speakers[t.speaker].padEnd(6)} ${String(t.start).padStart(6)}–${String(t.end).padEnd(6)}] ${text}`);
}
if (turns.length > 12) console.error(`… ${turns.length - 12} more turns`);

if (DRY_RUN) {
  console.error("\n--dry-run: nothing written");
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.error(`\nwrote ${OUT}`);
