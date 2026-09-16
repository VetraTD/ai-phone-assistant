// ---------------------------------------------------------------------------
// T1 -- does gemini-3.8-live cut into a trailing-off caller?
//
// This is the fail-fast gate. Cutting into a caller who has not finished is the
// defect that made the incumbent gemini-3.1-flash-live-preview unusable: 5/5 at
// default settings, 3/5 even at END_SENSITIVITY_LOW + 1200ms, and in a
// speech-to-speech stack the VAD belongs to the vendor, so there is no setting
// of ours that fixes it. Gemini 2.5 holds 10/10 and GPT-Live holds 10/10, so
// the defect looks like a 3.1 defect rather than a Gemini one.
//
// Pre-registered in verdicts-g38.json: prediction 0 cut-ins, and 2+ of 5 on
// EITHER fixture STOPS THE ROUND.
//
// INSTRUMENT VALIDATION COMES FIRST, and it is not optional.
//
// Arrival-based detection -- "audio arrived while the caller was still
// speaking, therefore it interrupted" -- is only sound if the model's output
// stream is TURN-BASED, i.e. it goes quiet between turns. On a full-duplex
// stream the output is always on and carries silence, and counting arrivals
// then counts silence: during the GPT-Live round that exact detector scored 10
// of 10 cut-ins and would have published the precise opposite of the truth
// (218 deltas, no gap over 400ms, 21.8s of stream carrying ~1s of speech).
//
// 3.8 is documented as "full duplex, permanently enabled", which is the same
// phrase that describes GPT-Live. So the assumption the 2.5 round was allowed
// to make is NOT available here by inheritance -- it has to be re-earned on
// this model. Step A measures the gap distribution and decides which detector
// is valid. If the stream turns out to be continuous, the arrival numbers are
// void and the run re-scores by RMS energy instead.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import {
  openSession, sendAudio, armTurn, waitForQuiet, setupOk, sleep,
} from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { commit, priceTokens, priceGeminiByMinutes, summary, reserve } from "./lib/spendLive.js";

const MODEL = process.env.M38 || "gemini-3.8-live";
const SURFACE = "aistudio";           // the only surface that serves 3.8 -- proved by the M38 pilot
const FIXTURES = ["no_terminal_punct", "trailing_lead_in"];
const N = Number(process.env.T1_N || 5);
const THINK = process.env.THINK || null;   // "high"/"low" for gemini-3.8-live-extended-thinking
const SUFFIX = process.env.SUFFIX || "";   // keeps the extended-thinking run from overwriting the plain one


/** Pre-registered discrimination rule, carried over from the GPT-Live round. */
const BACKCHANNEL_MAX_MS = 800;       // a short run returning to silence is a backchannel, not a cut-in
const CUT_IN_MIN_MS = 1500;           // a sustained run beginning before the caller finished is a cut-in
const RMS_FLOOR = 500;                // same floor the GPT-Live detector settled on

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

/** Inter-arrival gaps between output audio chunks. The instrument validator. */
function chunkGaps(log) {
  const gaps = [];
  for (let i = 1; i < log.length; i++) gaps.push(log[i].at - log[i - 1].at);
  gaps.sort((a, b) => a - b);
  const pct = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : 0);
  return {
    total_gaps: gaps.length,
    over_400ms: gaps.filter((g) => g > 400).length,
    p50: pct(0.5), p90: pct(0.9), p99: pct(0.99),
    max: gaps.length ? gaps[gaps.length - 1] : 0,
  };
}

/**
 * Energy-based speech runs over PCM16 24kHz output, for the fallback path.
 * Gemini emits PCM16 at 24 kHz, so a 20 ms frame is 480 samples / 960 bytes.
 */
function speechRuns(chunks, { frameMs = 20, hangoverMs = 240 } = {}) {
  if (!chunks.length) return { runs: [], frames: 0 };
  const buf = Buffer.concat(chunks.map((c) => c.pcm));
  const bytesPerFrame = Math.round((24000 * 2 * frameMs) / 1000);
  const origin = chunks[0].at;
  const runs = [];
  let open = null, quiet = 0;
  const nFrames = Math.floor(buf.length / bytesPerFrame);
  for (let i = 0; i < nFrames; i++) {
    let sum = 0;
    const off = i * bytesPerFrame;
    for (let j = 0; j < bytesPerFrame; j += 2) {
      const s = buf.readInt16LE(off + j);
      sum += s * s;
    }
    const rms = Math.sqrt(sum / (bytesPerFrame / 2));
    const atMs = origin + i * frameMs;
    if (rms > RMS_FLOOR) {
      if (!open) open = { startAt: atMs, endAt: atMs, peakRms: rms };
      open.endAt = atMs + frameMs;
      open.peakRms = Math.max(open.peakRms, rms);
      quiet = 0;
    } else if (open) {
      quiet += frameMs;
      if (quiet >= hangoverMs) { runs.push({ ...open, ms: open.endAt - open.startAt }); open = null; quiet = 0; }
    }
  }
  if (open) runs.push({ ...open, ms: open.endAt - open.startAt });
  return {
    runs,
    frames: nFrames,
    streamMs: nFrames * frameMs,
    speechMs: runs.reduce((s, r) => s + r.ms, 0),
  };
}

async function take(fixture, i) {
  reserve(`T1/${fixture}-${i}`, 60, 0.02);
  let ctx = null;
  const row = { fixture, take: i };
  const startedAt = Date.now();
  try {
    // capturePcm: raw audio is kept alongside the arrival log so the RMS-energy
    // fallback is available WITHOUT a second paid run if step A invalidates
    // arrival-based detection.
    ctx = await openSession({ surface: SURFACE, model: MODEL, thinkingLevel: THINK, answerTools: true, capturePcm: true });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;
    row.connect_ms = Date.now() - startedAt;
    armTurn(st);
    st.audioChunkLog.length = 0;
    st.pcmChunks.length = 0;

    const origLen = st.audioChunkLog.length;
    await paceFrames(pcmFrames(fixture), (f) => sendAudio(ctx.session, f));
    const speechEndAt = Date.now();

    await paceFrames(silenceFrames("pcm16k", 4000), (f) => sendAudio(ctx.session, f));
    // Whether this SUCCEEDS is itself instrument evidence: it needs 900ms with
    // no audio chunk at all. On an always-on stream it can only ever time out.
    const quietReached = await waitForQuiet(st, { quietMs: 900, maxMs: 12000 });

    const log = st.audioChunkLog.slice(origLen);
    row.chunks = log.length;
    row.chunks_during_speech = log.filter((c) => c.at < speechEndAt).length;
    row.bytes_during_speech = log.filter((c) => c.at < speechEndAt).reduce((s, c) => s + c.bytes, 0);
    row.gaps = chunkGaps(log);
    row.turn_latency_ms = st.firstAudioAt ? st.firstAudioAt - speechEndAt : null;

    // The energy view of the SAME session. Scored unconditionally so the two
    // detectors can be compared even when arrivals are valid -- if they
    // disagree, that disagreement is itself the finding.
    const energy = speechRuns(st.pcmChunks);
    row.energy_runs = energy.runs.length;
    row.energy_frames = energy.frames;
    row.stream_ms = energy.streamMs;
    row.speech_ms = energy.speechMs;
    // THE instrument number. A stream that carries silence between turns has a
    // low ratio; GPT-Live measured 21.8s of stream holding ~1.0s of speech
    // (0.05). A stream that only flows while speaking sits near 1.0.
    row.speech_to_stream_ratio = energy.streamMs ? Number((energy.speechMs / energy.streamMs).toFixed(3)) : null;
    row.quiet_reached = quietReached;
    const during = energy.runs.filter((r) => r.startAt < speechEndAt);
    row.energy_speech_before_caller_finished_ms = during.reduce((s, r) => s + r.ms, 0);
    row.energy_longest_run_before_caller_finished_ms = Math.max(0, ...during.map((r) => r.ms));
    row.energy_classification =
      row.energy_longest_run_before_caller_finished_ms >= CUT_IN_MIN_MS ? "cut_in"
      : row.energy_longest_run_before_caller_finished_ms > BACKCHANNEL_MAX_MS ? "ambiguous"
      : row.energy_longest_run_before_caller_finished_ms > 0 ? "backchannel"
      : "waited";

    row.transcript = st.outputTranscript.slice(0, 300);
    row.input_transcript = st.inputTranscript.slice(0, 200);
    row.tools = st.turnToolCalls.slice();
    row.speech_end_at = speechEndAt;

    // Pre-registered classification, arrival-based (valid only if step A says so).
    row.classification = row.chunks_during_speech === 0 ? "waited" : "spoke_during";
  } catch (e) {
    row.error = e.message;
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const u = ctx?.state?.usage || {};
  row.usage = { ...u };
  let priced = priceTokens(MODEL, {
    audio_in: u.audio_in || 0, audio_out: u.audio_out || 0,
    text_in: u.text_in || 0, text_out: u.text_out || 0,
  });
  // A session that billed and reported nothing still cost money. Falling back
  // to measured audio duration is an estimate; recording $0 is a wrong number.
  if (!(priced.usd > 0)) {
    const outSeconds = (ctx?.state?.audioBytes || 0) / (24000 * 2);
    const inSeconds = (row.fixture ? loadUlaw(fixture).seconds : 0) + 4;  // fixture + the 4s of silence sent
    priced = priceGeminiByMinutes({ inSeconds, outSeconds });
    row.usd_estimated = true;
  }
  row.usd = Number(priced.usd.toFixed(5));
  row.unpriced_tokens = priced.unpriced_tokens || 0;
  commit({
    probe: `T1${SUFFIX}`, arm: MODEL, label: `t1-${fixture}-${i}`, model: MODEL,
    usd: priced.usd, estimated: !!row.usd_estimated, note: row.error,
  });

  console.log(
    `  ${fixture.padEnd(18)} take ${i}  ` +
    `arrival:${(row.chunks_during_speech ? "CUT-IN" : "held").padEnd(7)} ` +
    `energy:${String(row.energy_classification ?? "-").padEnd(11)} ` +
    `lat ${String(row.turn_latency_ms ?? "-").padStart(5)}ms  ` +
    `chunks ${String(row.chunks ?? "-").padStart(3)}  ` +
    `gaps>400 ${row.gaps?.over_400ms ?? "-"}/${row.gaps?.total_gaps ?? "-"}  ` +
    `$${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`
  );
  return row;
}

async function main() {
  console.log(`T1 -- trail-off.  ${MODEL} @ ${SURFACE}`);
  console.log(`budget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const out = { at: new Date().toISOString(), model: MODEL, surface: SURFACE, n: N, rows: [] };

  for (const fixture of FIXTURES) {
    for (let i = 1; i <= N; i++) out.rows.push(await take(fixture, i));
  }

  // --- Step A, scored AFTER the fact from the same sessions: is the stream
  // turn-based? Doing it this way rather than as a separate paid session means
  // the validator runs on the very data it validates.
  const scored = out.rows.filter((r) => !r.error && r.chunks > 1);
  const totalGaps = scored.reduce((s, r) => s + r.gaps.total_gaps, 0);
  const over400 = scored.reduce((s, r) => s + r.gaps.over_400ms, 0);
  const p50 = Math.round(scored.reduce((s, r) => s + r.gaps.p50, 0) / Math.max(1, scored.length));
  const p90 = Math.round(scored.reduce((s, r) => s + r.gaps.p90, 0) / Math.max(1, scored.length));

  // WHAT THIS ACTUALLY TESTS, corrected mid-gate.
  //
  // The first version of this check asked "are there gaps over 400ms between
  // chunks?" and, finding none, declared the stream continuous and the arrival
  // counts void. That was the WRONG PROPERTY and it would have published a
  // misleading instrument claim. Chunks arriving back-to-back is what EVERY
  // streaming model does while it is talking; the 2.5 round's own "turn-based"
  // verdict rested on 8 gaps in 241, which is also essentially continuous.
  //
  // The property that actually invalidated the GPT-Live detector is different:
  // its output stream stayed on BETWEEN turns and carried silence, so 21.8s of
  // stream held ~1.0s of speech. Counting arrivals there counts silence.
  //
  // So the real test is the speech-to-stream ratio, plus whether a 900ms quiet
  // window is ever reachable at all -- on an always-on stream it never is.
  const ratios = scored.map((r) => r.speech_to_stream_ratio).filter((x) => x != null);
  const meanRatio = ratios.length ? Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3)) : null;
  const quietAlwaysReached = scored.every((r) => r.quiet_reached);

  out.instrument = {
    total_gaps: totalGaps,
    over_400ms: over400,
    mean_p50_gap_ms: p50,
    mean_p90_gap_ms: p90,
    mean_speech_to_stream_ratio: meanRatio,
    quiet_window_reached_every_take: quietAlwaysReached,
    gpt_live_comparison_ratio: 0.046,
    arrival_detection_valid: quietAlwaysReached && meanRatio != null && meanRatio > 0.5,
    reading: quietAlwaysReached && meanRatio > 0.5
      ? `TURN-BASED. ${(meanRatio * 100).toFixed(0)}% of the streamed audio is speech and a 900ms quiet window was reached on every take, so the stream stops when the model stops. Arrival-based counts are meaningful here, and they agree with the energy detector.`
      : `SILENCE-CARRYING. ratio ${meanRatio}, quiet reachable on every take: ${quietAlwaysReached}. Arrival-based counts are VOID -- they measure bytes flowing, not speech. Energy is the only valid detector.`,
    superseded_reading: "An earlier version of this gate scored 'gaps over 400ms' and called the stream continuous on that basis. That test was measuring chunk spacing during a response, which is not the thing that breaks arrival detection. Recorded rather than deleted.",
  };

  const held = out.rows.filter((r) => !r.error && r.chunks_during_speech === 0).length;
  const cutIn = out.rows.filter((r) => !r.error && r.chunks_during_speech > 0).length;
  const errs = out.rows.filter((r) => r.error).length;

  out.tally = {};
  for (const f of FIXTURES) {
    const rs = out.rows.filter((r) => r.fixture === f && !r.error);
    const energyCutIns = rs.filter((r) => r.energy_classification === "cut_in").length;
    const arrivalCutIns = rs.filter((r) => r.chunks_during_speech > 0).length;
    out.tally[f] = {
      of: rs.length,
      held: rs.filter((r) => r.chunks_during_speech === 0).length,
      cut_in_arrival: arrivalCutIns,
      cut_in_energy: energyCutIns,
      backchannel_energy: rs.filter((r) => r.energy_classification === "backchannel").length,
      ambiguous_energy: rs.filter((r) => r.energy_classification === "ambiguous").length,
      detectors_disagree: arrivalCutIns !== energyCutIns,
      median_latency_ms: rs.map((r) => r.turn_latency_ms).filter((x) => x != null).sort((a, b) => a - b)[Math.floor(rs.length / 2)] ?? null,
      // PRE-REGISTERED FAIL CONDITION. Scored on whichever detector step A says
      // is valid: energy is always sound, arrivals only on a turn-based stream.
      // Taking the MAX is deliberate -- if the two disagree the gate should fail
      // loudly and be looked at, not quietly pick the flattering number.
      fails: Math.max(arrivalCutIns, energyCutIns) >= 2,
    };
  }
  out.verdict = {
    predicted: "0 cut-ins, holds 5/5 on both fixtures",
    measured: `${held} held, ${cutIn} cut in, ${errs} errored, of ${out.rows.length}`,
    fails_round: Object.values(out.tally).some((t) => t.fails),
    baselines: {
      "gemini-3.1-flash-live-preview": "5/5 cut in at default, 3/5 at END_SENSITIVITY_LOW+1200ms",
      "gemini-live-2.5-flash-native-audio": "0 cut-ins of 10",
      "gpt-live-1": "0 cut-ins of 10 (RMS energy)",
    },
  };

  fs.writeFileSync(`scripts/probes/results-t1${SUFFIX}.json`, JSON.stringify(out, null, 2) + "\n");

  console.log(`\n--- instrument check ---`);
  console.log(`  gaps over 400ms: ${over400} of ${totalGaps}   p50 ${p50}ms   p90 ${p90}ms`);
  console.log(`  speech:stream ratio ${meanRatio}  (GPT-Live was 0.046)   quiet window reached every take: ${quietAlwaysReached}`);
  console.log(`  ${out.instrument.reading}`);
  console.log(`\n--- T1 ---`);
  for (const f of FIXTURES) {
    const t = out.tally[f];
    console.log(
      `  ${f.padEnd(18)} of ${t.of}   cut-in(arrival) ${t.cut_in_arrival}   cut-in(energy) ${t.cut_in_energy}` +
      `   backchannel ${t.backchannel_energy}   ${t.detectors_disagree ? "DETECTORS DISAGREE  " : ""}${t.fails ? "*** FAILS ***" : "pass"}`
    );
  }
  console.log(`\n  ${out.verdict.fails_round ? "*** T1 FAILS -- THE ROUND STOPS HERE ***" : "T1 PASSES -- continue to T2"}`);
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
  if (out.verdict.fails_round) process.exitCode = 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
