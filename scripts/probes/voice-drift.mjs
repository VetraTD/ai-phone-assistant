#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LVX81 -- does a pinned Gemini Live voice drift between sessions?
//
// THROWAWAY. PLAN.md's rule for this directory: the output of this work is an
// ANSWER, not code we keep.
//
// ---------------------------------------------------------------------------
// Why this is not scripts/voice-compare.js
// ---------------------------------------------------------------------------
//
// That rig renders one sentence per voice, once, and reports IDENTICAL AUDIO AS
// A FAULT -- because there, two names yielding the same bytes means the API
// ignored a name and the files are copies of one voice.
//
// Here the verdict inverts. This renders the SAME voice repeatedly, and
// identical audio is the FINDING: if five takes of Kore are byte-identical then
// the model is deterministic for that (voice, text, language), session-level
// drift is impossible, and changing the prebuilt voice cannot fix what the owner
// heard. One script carrying two opposite verdicts on the same hash is how an
// instrument gets misread, so this is a second script.
//
// ---------------------------------------------------------------------------
// What the eight calls of 2026-09-07 established, and what they did not
// ---------------------------------------------------------------------------
//
// Established: voice pinned to Kore, languageCode pinned to en-GB, Google
// ACCEPTED both -- language_pinned: true on every summary, zero
// live_language_code_rejected, connectLive's strip-and-retry path never fired.
// The accent drifted anyway. There is no further config lever.
//
// NOT established: whether the drift is between sessions or inside one. Only
// the first makes "try the other prebuilt voices" a candidate fix at all, and
// nobody has measured which it is. That is the whole question here.
//
// ---------------------------------------------------------------------------
// It renders the TELEPHONE band, and that is not decoration
// ---------------------------------------------------------------------------
//
// Through lib/voice/resample.js -- the production downsampler, not a copy. A
// call is mu-law 8 kHz and discards everything above ~3.4 kHz. On 2026-09-05
// Kore was chosen from 24 kHz WAVs and then reported "not the best quality over
// the phone but it was on the wav file", and Aoede was picked from the same
// files and rejected after four turns of a real call. A 24 kHz judgement has
// already been overturned by 8 kHz once in this project. Rate the phone file.
//
// ---------------------------------------------------------------------------
// Blind by construction
// ---------------------------------------------------------------------------
//
// Takes are shuffled and named take-NN.wav. The voice mapping is written to a
// SIBLING directory so the audio folder can be handed over without it. A rater
// who knows which file is the incumbent is not rating the audio.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { connectLive } from "../../lib/voice/live/client.js";
import { createDownsampler, mulaw8kToPcm16k } from "../../lib/voice/resample.js";
import { reserve, commit, price, remaining, CAP_USD, spent } from "./lib/spend.js";

const MODEL = process.env.LIVE_MODEL || "gemini-3.1-flash-live-preview";

// Longer than voice-compare's greeting on purpose. An accent shows itself over
// a few sentences with varied vowels, not over one line, and the complaint is
// about how the receptionist sounds across a call rather than at hello.
const LINE =
  process.env.VOICE_DRIFT_LINE ||
  "Thanks for calling Digile Media. You are through to our AI receptionist. " +
    "I can book you in, take a message, or answer a question about what we do. " +
    "We are open from half past eight in the morning until half five, " +
    "Monday through Thursday, and we close a little earlier on Fridays. " +
    "Can I take your name to get started?";

const LANGUAGE = process.env.VOICE_DRIFT_LANGUAGE || "en-GB";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const VOICES = arg("--voices", "Kore,Puck,Charon,Aoede,Leda,Orus,Zephyr,Fenrir")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const TAKES = Number.parseInt(arg("--takes", "5"), 10);
const OUT_DIR = arg("--out", join(process.cwd(), "voice-drift"));

const STUDIO_RATE = 24_000;
const PHONE_RATE = 16_000; // 8 kHz mu-law decoded back up, which is what we send

/** Wrap raw PCM16 mono in a WAV header so anything can play it. */
function wav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Put the studio audio through the SAME path a caller's ear is on.
 *
 * lib/voice/resample.js's downsampler, not a reimplementation: a probe that
 * band-limits differently from production is measuring its own filter.
 */
function toTelephoneBand(pcm24k) {
  const down = createDownsampler();
  const mulaw = down.process(pcm24k);
  return mulaw8kToPcm16k(mulaw);
}

/** One session, one voice, one reading. No tenant, no tools, no real prompt. */
async function render(voiceName) {
  const chunks = [];
  let usage = null;
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
        if (msg?.usageMetadata) usage = msg.usageMetadata;
        const sc = msg?.serverContent;
        if (!sc) return;
        for (const part of sc.modelTurn?.parts || []) {
          const b64 = part?.inlineData?.data;
          if (b64) chunks.push(Buffer.from(b64, "base64"));
        }
        if (sc.outputTranscription?.text) transcript += sc.outputTranscription.text;
        if (sc.turnComplete) done();
      },
      // Recorded, not thrown. A vendor that REFUSES an unknown voice name is a
      // reported outcome and a better one than a silent substitution.
      onerror: (e) => {
        transcript += `\n[error] ${e?.message || String(e)}`;
        done();
      },
      onclose: () => done(),
    },
  });

  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: LINE }] }],
    turnComplete: true,
  });
  const timer = setTimeout(done, 45_000);
  await finished;
  clearTimeout(timer);
  try {
    session.close();
  } catch {
    /* already gone */
  }

  return { pcm: Buffer.concat(chunks), transcript: transcript.trim(), usage };
}

/**
 * Book one session against the shared meter, and never let that lose a take.
 *
 * `price()` returns `{ usd, breakdown, unpriced_tokens }`, NOT a number. Handing
 * the whole object to commit() as `usd` makes the running total a string, and
 * `state.entries.reduce(...).toFixed` then throws on every subsequent call --
 * which is exactly what happened on the first run of this probe and cost forty
 * rendered sessions.
 *
 * Wrapped, because a meter that cannot add up is a bookkeeping problem and the
 * audio is the evidence. A failure here is reported loudly and the take is
 * kept; the alternative destroyed everything the run paid for.
 */
function recordSpend(voice, take, usage) {
  if (!usage) return;
  try {
    commit({
      probe: "voice-drift",
      arm: voice,
      run: take + 1,
      model: MODEL,
      usage,
      usd: price(MODEL, usage).usd,
    });
  } catch (err) {
    console.log(`\n    [meter] NOT RECORDED — ${err?.message || err}`);
    console.log("    [meter] the session still billed. spend.json now understates the run.");
  }
}

/** Fisher-Yates, so file order carries no information about the arm. */
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");
  const planned = VOICES.length * TAKES;

  console.log("\n  voice-drift — LVX81. One voice, several takes, does it move?");
  console.log("  -----------------------------------------------------------");
  console.log(`  model     ${MODEL}`);
  console.log(`  language  ${LANGUAGE}`);
  console.log(`  voices    ${VOICES.join(", ")}  (${VOICES.length})`);
  console.log(`  takes     ${TAKES} per voice  ->  ${planned} sessions`);
  console.log(`  out       ${OUT_DIR}`);
  console.log(
    `\n  BUDGET    cap $${CAP_USD.toFixed(2)}, spent $${spent().toFixed(4)}, ` +
      `remaining $${remaining().toFixed(4)}`
  );
  console.log("            Short renders. reserve() aborts the run rather than breaching.");
  console.log("\n  VERDICTS  scripts/probes/verdicts-voice.json — written before this ran,");
  console.log("            and not to be edited after reading a result.");

  if (!confirmed) {
    console.log("\n  Not run. Re-run with --confirm to spend the above.\n");
    return;
  }
  if (!process.env.GEMINI_API_KEY && process.env.LIVE_SURFACE !== "vertex") {
    console.error("\n  GEMINI_API_KEY is not set. Nothing to do.\n");
    process.exitCode = 1;
    return;
  }

  const audioDir = join(OUT_DIR, "audio");
  const mapDir = join(OUT_DIR, "_mapping");
  mkdirSync(audioDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });

  const jobs = shuffle(
    VOICES.flatMap((voice) => Array.from({ length: TAKES }, (_, take) => ({ voice, take })))
  );
  const results = [];
  let consecutiveErrors = 0;

  for (let i = 0; i < jobs.length; i += 1) {
    const { voice, take } = jobs[i];
    const label = `take-${String(i + 1).padStart(2, "0")}`;
    process.stdout.write(`  ${label}  ${voice.padEnd(9)} `);

    try {
      // PLAN.md rule 1. A pessimistic reservation before the socket opens, so
      // the ceiling holds even if the run dies before commit().
      reserve(`voice-drift ${voice} #${take + 1}`, 0.02);
      const { pcm, transcript, usage } = await render(voice);

      // ACCOUNTING RUNS AFTER THE ARTIFACT IS ON DISK, and that ordering is the
      // whole lesson of the first run. It used to run here, before the files
      // were written, and a bug in the meter (usd was handed price()'s whole
      // object instead of its .usd) threw on every take -- so forty sessions
      // were paid for, rendered, and then discarded by the catch below without
      // a single WAV reaching disk. The audio is what the money bought; it gets
      // saved first, and the bookkeeping is never allowed to destroy it.
      if (!pcm.length) {
        console.log(`NO AUDIO — ${transcript.slice(0, 70) || "session produced nothing"}`);
        results.push({ label, voice, take, hash: null, bytes: 0, note: transcript.slice(0, 200) });
        recordSpend(voice, take, usage);
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) {
          throw new Error("three consecutive empty renders — aborting (PLAN.md rule 7)");
        }
        continue;
      }
      consecutiveErrors = 0;

      const phone = toTelephoneBand(pcm);
      writeFileSync(join(audioDir, `${label}.wav`), wav(phone, PHONE_RATE));
      writeFileSync(join(audioDir, `${label}.studio.wav`), wav(pcm, STUDIO_RATE));

      const hash = createHash("sha256").update(pcm).digest("hex").slice(0, 16);
      const seconds = (pcm.length / 2 / STUDIO_RATE).toFixed(1);
      console.log(`${seconds}s  ${hash}`);
      results.push({ label, voice, take, hash, bytes: pcm.length, transcript });
      recordSpend(voice, take, usage);
    } catch (err) {
      console.log(`FAILED — ${err?.message || err}`);
      results.push({ label, voice, take, hash: null, bytes: 0, note: String(err?.message || err) });
      if (String(err?.message || "").includes("aborting")) break;
      if (String(err?.name) === "BudgetExceeded") break;
    }
  }

  writeFileSync(join(mapDir, "mapping.json"), JSON.stringify(results, null, 2));
  writeFileSync(
    join(audioDir, "RATE-ME.txt"),
    [
      "LVX81 blind accent rating.",
      "",
      "Play the take-NN.wav files (NOT the .studio.wav ones -- those are 24 kHz",
      "and a 24 kHz judgement has been overturned by a real phone call in this",
      "project before). For each, write ONE of:",
      "",
      "    british | american | australian | other_or_mixed",
      "",
      "Do not look in the _mapping directory until every take is rated.",
      "",
      `${results.filter((r) => r.hash).length} takes to rate.`,
      "",
    ].join("\n")
  );

  // -------------------------------------------------------------------------
  // The half that needs no ear.
  // -------------------------------------------------------------------------
  console.log("\n  -----------------------------------------------------------");
  const byVoice = new Map();
  for (const r of results.filter((x) => x.hash)) {
    byVoice.set(r.voice, [...(byVoice.get(r.voice) || []), r.hash]);
  }

  let anyDeterministic = false;
  for (const [voice, hashes] of byVoice) {
    const distinct = new Set(hashes).size;
    if (distinct === 1 && hashes.length > 1) {
      anyDeterministic = true;
      console.log(`  ${voice.padEnd(9)} ${hashes.length} takes, ALL IDENTICAL`);
    } else {
      console.log(`  ${voice.padEnd(9)} ${hashes.length} takes, ${distinct} distinct renderings`);
    }
  }

  // NOTHING RENDERED IS NOT A RESULT, and the first run printed one anyway.
  //
  // With 40 of 40 failed it still reported "renderings differ between takes",
  // which is a statement about data it did not have, and exited 0. A probe that
  // cannot come back empty-handed cannot be trusted when it comes back full.
  const renderedCount = results.filter((r) => r.hash).length;
  if (renderedCount === 0) {
    console.log("  INCONCLUSIVE — nothing rendered. No take reached disk, so there is");
    console.log("  no evidence here for or against any verdict in verdicts-voice.json.");
    console.log("  Fix the run before reading anything into it.");
    process.exitCode = 1;
  } else if (renderedCount < jobs.length) {
    console.log(`\n  PARTIAL — ${renderedCount} of ${jobs.length} takes rendered.`);
    console.log("  Arms with fewer takes than the others are not comparable with them.");
    process.exitCode = 1;
  }

  if (renderedCount === 0) {
    // No conclusion, deliberately. Fall through to the failure list below.
  } else if (anyDeterministic) {
    console.log("\n  A voice whose takes are byte-identical is DETERMINISTIC for this");
    console.log("  (voice, text, language). Session-level drift is then impossible for");
    console.log("  it, and verdicts-voice.json V1 is refuted without anybody listening:");
    console.log("  the drift the owner heard is within-call, and no prebuilt voice name");
    console.log("  reaches it.");
  } else {
    console.log("\n  Renderings differ between takes. This PROVES NOTHING about accent on");
    console.log("  its own — bit-level difference is expected from sampling. V1 and V2 are");
    console.log("  decided by the blind rating, against verdicts-voice.json, not here.");
  }

  const failed = results.filter((r) => !r.hash);
  if (failed.length) {
    console.log(`\n  Did not render (${failed.length}):`);
    for (const f of failed) {
      console.log(`    ${f.label}  ${f.voice.padEnd(9)} ${(f.note || "").slice(0, 80)}`);
    }
    console.log("  A name the API rejects outright is a GOOD outcome — an unrecognised");
    console.log("  voice cannot then silently become the default one.");
  }

  console.log(`\n  audio    ${audioDir}    (hand this over)`);
  console.log(`  mapping  ${mapDir}    (do NOT hand this over)`);
  console.log(`  spent    $${spent().toFixed(4)} of $${CAP_USD.toFixed(2)}\n`);
}

await main();
