// ---------------------------------------------------------------------------
// Can the VENDOR's detector be told to be more patient?
//
// WHY THIS EXISTS. Task 3 measured arm C (LIVE_TURN_END=hold) and found it
// unusable as designed: classifyHold classifies TEXT, and
// automaticActivityDetection:{disabled:true} -- the setting arm C requires --
// stops Gemini emitting inputAudioTranscription until after activityEnd. A
// transcript arrived before the close on 0 of 20 takes, so classifyHold decided
// 0 of 20 turns and the arm degraded to a flat 1,200 ms timer costing +715 ms
// on every complete turn on 3.1.
//
// But lib/voice/live/turnEnd/vendorAd.js sends NO realtimeInputConfig at all --
// connectConfig() returns {} -- so we have been running Google's DEFAULT VAD
// and have never tried tuning it. The SDK exposes silenceDurationMs: how long
// the vendor waits after speech stops before calling the turn over. That is the
// patience knob, and it buys patience WITHOUT disabling the transcription that
// arm C had to sacrifice.
//
// ---------------------------------------------------------------------------
// THE INSTRUMENT MUST BE ABLE TO FAIL
// ---------------------------------------------------------------------------
//
// gemini-3.8-live ACCEPTS toolConfig.functionCallingConfig and does not ENFORCE
// it: mode:ANY forced a call 0 of 5, mode:NONE still called 2 of 5, and an
// allowlist of one function called a different function. A silently-ignored
// config is worse than an absent one because it reads like a working guard.
//
// So "the session started" proves NOTHING here. The falsifiable claim is that
// time-to-speak rises MONOTONICALLY with silenceDurationMs. If 2,500 ms behaves
// like the default, the knob is decorative and this arm dies with arm C. That
// comparison is the point of the probe, and the default arm is in the run for
// exactly that reason rather than as a courtesy.
//
// Note from the SDK's own docs: endOfSpeechSensitivity already DEFAULTS to
// END_SENSITIVITY_LOW, so setting it is expected to be a no-op. It is included
// as a fourth arm precisely to check that expectation rather than assume it.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import { openSession, sendAudio, armTurn, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { commit, priceGeminiByMinutes, summary, reserve } from "./lib/spendLive.js";

const MODEL = process.env.VK_MODEL || "gemini-3.1-flash-live-preview";
const N = Number(process.env.VK_N || 5);

/** How long we keep the line alive after the fixture before giving up. */
const LISTEN_MS = 5_000;

// VK_SILENCE overrides the sweep, for pinning a value once the knob is known to
// be enforced. The default arm stays in every run: without it there is nothing
// to compare against and the enforcement question cannot be re-answered.
const SWEEP = (process.env.VK_SILENCE || "").trim();
const ARMS = SWEEP
  ? [{ key: "default", cfg: null }].concat(
      SWEEP.split(",").map((ms) => ({ key: `silence${ms.trim()}`, cfg: { silenceDurationMs: Number(ms.trim()) } }))
    )
  : [
      // The incumbent. No realtimeInputConfig at all, exactly as vendorAd.js ships.
      { key: "default", cfg: null },
      { key: "silence1200", cfg: { silenceDurationMs: 1200 } },
      { key: "silence2500", cfg: { silenceDurationMs: 2500 } },
      // Expected no-op -- LOW is documented as the default. Here to test that.
      { key: "endsens_low", cfg: { endOfSpeechSensitivity: "END_SENSITIVITY_LOW" } },
    ];

const FIXTURES = [
  // The defect: a caller who has obviously not finished.
  "trailing_lead_in",
  // The cost: a complete phrase, which is nearly every turn.
  "rep_confirm",
];

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

async function trial(arm, fixture, i) {
  reserve(`VK/${arm.key}-${fixture}-${i}`, 60, 0.02);
  const row = { model: MODEL, arm: arm.key, fixture, take: i, cfg: arm.cfg };
  let ctx = null;
  const t0 = Date.now();

  try {
    ctx = await openSession({
      surface: "aistudio",
      model: MODEL,
      answerTools: true,
      // null leaves realtimeInputConfig unset, which is the incumbent.
      automaticActivityDetection: arm.cfg || undefined,
    });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;
    armTurn(st);
    st.inputTranscript = "";

    // The vendor's detector is ON. We send no activityStart and no activityEnd:
    // every turn boundary here is the vendor's own decision, which is the thing
    // being measured.
    await paceFrames(pcmFrames(fixture), (f) => sendAudio(ctx.session, f));
    const speechEndAt = Date.now();

    let transcriptAt = null;
    await paceFrames(
      silenceFrames("pcm16k", LISTEN_MS),
      (f) => {
        sendAudio(ctx.session, f);
        if (transcriptAt === null && st.inputTranscript) transcriptAt = Date.now();
      },
      { stop: () => st.firstAudioAt !== null }
    );

    row.spoke = st.firstAudioAt !== null;
    // THE NUMBER. How long the caller got after they stopped, before we spoke.
    row.spoke_at_ms = row.spoke ? st.firstAudioAt - speechEndAt : null;
    // THE ADVANTAGE OVER ARM C. Did the transcript arrive at all, and when?
    row.transcript_at_ms = transcriptAt ? transcriptAt - speechEndAt : null;
    row.transcript = (st.inputTranscript || "").trim();
    row.has_terminal_punct = /[.!?]\s*$/.test(row.transcript);
    await sleep(200);
  } catch (e) {
    row.error = (e.message || String(e)).slice(0, 140);
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const priced = priceGeminiByMinutes({
    inSeconds: (Date.now() - t0) / 1000,
    outSeconds: (ctx?.state?.audioBytes || 0) / (24000 * 2),
  });
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "VADKNOBS", arm: `${arm.key}/${fixture}`, label: `vk-${arm.key}-${fixture}-${i}`, model: MODEL, usd: priced.usd, estimated: true });

  console.log(
    `  ${arm.key.padEnd(12)} ${fixture.padEnd(17)} t${i}  ` +
    `spoke ${String(row.spoke_at_ms ?? "never").padStart(6)}ms  ` +
    `transcript ${String(row.transcript_at_ms ?? "-").padStart(5)}ms ${row.has_terminal_punct ? "punct" : "  -  "}  ` +
    `${JSON.stringify((row.transcript || "").slice(0, 34))}${row.error ? "  ERR " + row.error : ""}`
  );
  return row;
}

const median = (v) => {
  const s = v.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function main() {
  console.log(`vendor-VAD knobs on ${MODEL}`);
  console.log(`  does silenceDurationMs actually move the turn end, or is it another`);
  console.log(`  accepted-but-ignored config like toolConfig was?\n`);
  console.log(`budget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const out = { at: new Date().toISOString(), model: MODEL, n: N, arms: ARMS, fixtures: FIXTURES, rows: [] };
  for (const fixture of FIXTURES) {
    for (const arm of ARMS) {
      for (let i = 1; i <= N; i++) out.rows.push(await trial(arm, fixture, i));
    }
    console.log("");
  }

  out.tally = {};
  for (const fixture of FIXTURES) {
    for (const arm of ARMS) {
      const rs = out.rows.filter((r) => r.arm === arm.key && r.fixture === fixture && !r.error);
      out.tally[`${fixture} / ${arm.key}`] = {
        of: rs.length,
        spoke: rs.filter((r) => r.spoke).length,
        p50_spoke_at_ms: median(rs.map((r) => r.spoke_at_ms)),
        min_spoke_at_ms: rs.length ? Math.min(...rs.map((r) => r.spoke_at_ms ?? Infinity)) : null,
        p50_transcript_at_ms: median(rs.map((r) => r.transcript_at_ms)),
        transcripts_seen: rs.filter((r) => r.transcript).length,
        punctuated: rs.filter((r) => r.has_terminal_punct).length,
      };
    }
  }

  // THE ENFORCEMENT VERDICT. Stated as a falsifiable comparison, not as "the
  // session started". If more silence tolerance does not buy more time, the
  // knob is decorative.
  const grab = (f, a) => out.tally[`${f} / ${a}`]?.p50_spoke_at_ms ?? null;
  out.enforcement = {};
  for (const f of FIXTURES) {
    const d = grab(f, "default"), s12 = grab(f, "silence1200"), s25 = grab(f, "silence2500");
    out.enforcement[f] = {
      default: d, silence1200: s12, silence2500: s25,
      delta_1200: d != null && s12 != null ? s12 - d : null,
      delta_2500: d != null && s25 != null ? s25 - d : null,
      // A knob that works makes 2,500 slower than 1,200 and both slower than
      // the default. 150 ms of slack absorbs ordinary jitter.
      ENFORCED: d != null && s25 != null && s25 - d > 150 && (s12 == null || s25 >= s12 - 150),
    };
  }

  fs.writeFileSync("scripts/probes/results-vadknobs.json", JSON.stringify(out, null, 2) + "\n");

  console.log("--- tally ---");
  console.log(JSON.stringify(out.tally, null, 2));
  console.log("\n--- IS THE KNOB ENFORCED? ---");
  console.log(JSON.stringify(out.enforcement, null, 2));
  for (const [f, e] of Object.entries(out.enforcement)) {
    console.log(`  ${f}: ${e.ENFORCED ? "ENFORCED -- silenceDurationMs moves the turn end" : "*** NOT ENFORCED -- accepted and ignored, like toolConfig ***"}`);
  }
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
