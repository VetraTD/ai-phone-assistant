#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Render one sentence in several Gemini Live voices, so an ear can choose.
//
// ---------------------------------------------------------------------------
// Why this exists as a script rather than as a set of phone calls
// ---------------------------------------------------------------------------
//
// The roadmap's phase 1 asks for "a British voice you are happy with", and says
// in as many words that it needs the owner's ears rather than a test. The
// obvious way to get those ears onto it is to ring the number once per
// candidate. That is roughly $0.15 a call, needs a UK handset free at the same
// moment as the rig, and -- worst of the three -- puts the candidates minutes
// apart, which is the least reliable way a human can compare two voices.
//
// This renders the SAME sentence, in the SAME language, to a file per voice.
// They can be played back to back, in any order, as many times as it takes.
//
// What it cannot answer: how any of them sounds after mu-law 8 kHz over the
// PSTN, which is what a caller actually hears. That is a real gap and the
// verification call closes it for the winner.
//
// ---------------------------------------------------------------------------
// THE TRAP THIS IS BUILT AROUND
// ---------------------------------------------------------------------------
//
// Nothing in this project has ever established which prebuilt voice names the
// Live API accepts, or what it does with one it does not recognise. If an
// unknown name quietly yields the default voice, then three files rendered from
// three names could be three copies of one voice -- and the honest-looking
// conclusion "they all sound the same to me" would be drawn from a rig that
// never varied anything.
//
// So every rendering is hashed, and IDENTICAL AUDIO IS REPORTED AS A FAULT
// rather than as a result. That is the difference between this and a script
// that merely produces files.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { connectLive } from "../lib/voice/live/client.js";

// The sentence. Digile Media's real greeting, because the thing being judged is
// how the DEMO sounds, and the demo opens with exactly this.
const LINE =
  process.env.VOICE_COMPARE_LINE ||
  "Thanks for calling Digile Media. You're through to our AI receptionist — " +
    "calls are recorded for quality. How can I help you today?";

const LANGUAGE = process.env.VOICE_COMPARE_LANGUAGE || "en-GB";

// Candidates. Overridable precisely because the accepted set is not known --
// this list is a starting point to be disproved, not an authority.
const VOICES = (process.env.VOICE_COMPARE_VOICES || "Kore,Puck,Charon,Aoede,Leda")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const OUT_DIR = process.env.VOICE_COMPARE_OUT || join(process.cwd(), "voice-compare");

// Gemini Live returns 16-bit signed PCM, mono, 24 kHz on the output side.
const SAMPLE_RATE = 24_000;

/** Wrap raw PCM16 mono in a WAV header so anything can play it. */
function wav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * One session, one voice, one sentence. Returns the audio and what was said.
 *
 * No tenant, no tools and no business prompt: this is a voice test, and loading
 * the real 24,000-character instruction would bill it on every candidate for a
 * question it cannot help answer.
 */
async function render(voiceName) {
  const chunks = [];
  let transcript = "";
  let done;
  const finished = new Promise((r) => {
    done = r;
  });

  const { session } = await connectLive({
    env: process.env,
    config: {
      responseModalities: ["AUDIO"],
      systemInstruction: {
        parts: [
          {
            text:
              "Read the user's message aloud, word for word, exactly as written. " +
              "Add nothing, remove nothing, and do not reply to it.",
          },
        ],
      },
      outputAudioTranscription: {},
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        languageCode: LANGUAGE,
      },
    },
    callbacks: {
      onmessage: (msg) => {
        const sc = msg?.serverContent;
        if (!sc) return;
        for (const part of sc.modelTurn?.parts || []) {
          const b64 = part?.inlineData?.data;
          if (b64) chunks.push(Buffer.from(b64, "base64"));
        }
        if (sc.outputTranscription?.text) transcript += sc.outputTranscription.text;
        if (sc.turnComplete) done();
      },
      onerror: (e) => {
        // Recorded, not thrown. A vendor that REFUSES an unknown voice name is
        // one of the outcomes this script exists to discover, and it is a much
        // better outcome than a silent substitution -- so it must be reported
        // rather than crashing the run half way through the candidates.
        transcript += `\n[error] ${e?.message || String(e)}`;
        done();
      },
      onclose: () => done(),
    },
  });

  session.sendClientContent({ turns: [{ role: "user", parts: [{ text: LINE }] }], turnComplete: true });

  const timer = setTimeout(done, 30_000);
  await finished;
  clearTimeout(timer);
  try {
    session.close();
  } catch {
    /* already gone */
  }

  return { pcm: Buffer.concat(chunks), transcript: transcript.trim() };
}

async function main() {
  const confirmed = process.argv.slice(2).includes("--confirm");

  console.log("\n  voice-compare — one sentence, several voices, one file each");
  console.log("  ---------------------------------------------------------");
  console.log(`  language  ${LANGUAGE}`);
  console.log(`  voices    ${VOICES.join(", ")}  (${VOICES.length})`);
  console.log(`  line      "${LINE.slice(0, 70)}${LINE.length > 70 ? "..." : ""}"`);
  console.log(`  out       ${OUT_DIR}`);
  console.log(`\n  COST      ${VOICES.length} short Live sessions. A few hundred tokens each`);
  console.log("            plus the audio out — pennies, not dollars. No phone calls.");

  if (!confirmed) {
    console.log("\n  Not run. Re-run with --confirm to spend the above.\n");
    return;
  }

  if (!process.env.GEMINI_API_KEY && process.env.LIVE_SURFACE !== "vertex") {
    console.error("\n  GEMINI_API_KEY is not set. Nothing to do.\n");
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const results = [];

  for (const voice of VOICES) {
    process.stdout.write(`\n  ${voice.padEnd(10)} `);
    try {
      const { pcm, transcript } = await render(voice);
      if (!pcm.length) {
        console.log("NO AUDIO — " + (transcript || "the session produced nothing"));
        results.push({ voice, hash: null, bytes: 0, transcript });
        continue;
      }
      const hash = createHash("sha256").update(pcm).digest("hex").slice(0, 16);
      const file = join(OUT_DIR, `${voice}.wav`);
      writeFileSync(file, wav(pcm));
      const seconds = (pcm.length / 2 / SAMPLE_RATE).toFixed(1);
      console.log(`${seconds}s  ${hash}  -> ${voice}.wav`);
      results.push({ voice, hash, bytes: pcm.length, transcript });
    } catch (err) {
      console.log(`FAILED — ${err?.message || err}`);
      results.push({ voice, hash: null, bytes: 0, transcript: String(err?.message || err) });
    }
  }

  // ---------------------------------------------------------------------
  // The check that makes the files worth listening to.
  // ---------------------------------------------------------------------
  const rendered = results.filter((r) => r.hash);
  const byHash = new Map();
  for (const r of rendered) byHash.set(r.hash, [...(byHash.get(r.hash) || []), r.voice]);
  const collisions = [...byHash.values()].filter((v) => v.length > 1);

  console.log("\n  ---------------------------------------------------------");
  if (rendered.length < 2) {
    console.log("  INCONCLUSIVE — fewer than two voices rendered. Nothing to compare.");
    process.exitCode = 1;
  } else if (collisions.length) {
    console.log("  DO NOT JUDGE THESE FILES. Identical audio from different names:");
    for (const group of collisions) console.log(`    ${group.join(" == ")}`);
    console.log("\n  Byte-identical audio means those names did not select different");
    console.log("  voices — most likely the API ignored a name it did not recognise.");
    console.log("  Picking a favourite here would be picking between copies of one voice.");
    process.exitCode = 1;
  } else {
    console.log(`  ${rendered.length} distinct voices rendered, all hashes differ.`);
    console.log("  Safe to listen and choose. The winner goes in businesses.live_voice,");
    console.log("  and becomes the en-GB default in lib/voice/live/index.js.");
  }

  const failed = results.filter((r) => !r.hash);
  if (failed.length) {
    console.log("\n  Did not render:");
    for (const f of failed) console.log(`    ${f.voice.padEnd(10)} ${f.transcript.slice(0, 100)}`);
    console.log("  A name the API rejects outright is a GOOD outcome — it means an");
    console.log("  unrecognised voice cannot silently become the default one.");
  }
  console.log("");
}

await main();
