// ---------------------------------------------------------------------------
// R3b — can WE own endpointing, instead of the vendor?
//
//   node scripts/probes/r3-manual-vad.mjs
//
// Round 3 found Gemini 3.1 cutting into a trailing-off caller ("It's for, uh —")
// 5/5 at its default VAD and still 3/5 at END_SENSITIVITY_LOW + 1200 ms, and I
// concluded that speech-to-speech hands endpointing to the vendor and the
// trail-off regression is unavoidable.
//
// That conclusion was wrong, and only two sensitivity settings were ever tried.
// Gemini supports `automaticActivityDetection: { disabled: true }`, where the
// client sends explicit activityStart / activityEnd signals — so classifyHold
// keeps deciding when a caller has finished, exactly as it does today, and the
// vendor never endpoints at all.
//
// This probe checks the mechanism actually holds under the failing fixture:
//
//   1. send `trailing_lead_in` with automatic VAD DISABLED
//   2. hold the line open with real silence for HOLD_MS and send NO activityEnd
//      -> a correct result is total silence from the model
//   3. send activityEnd
//      -> the model should then answer promptly
//
// If step 2 stays silent, the trail-off defect is a configuration choice rather
// than a property of the model, and lib/voice/classifyHold + inboundVad survive
// the migration instead of being deleted.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { openSession, sendAudio, armTurn, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { geminiFrames, paceFrames, silenceFrames } from "./lib/audio.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { p50, writeRaw } from "./lib/stats.js";

const MODEL = process.env.PROBE_MODEL || "gemini-3.1-flash-live-preview";
const SURFACE = process.env.PROBE_SURFACE || "aistudio";
const N = Number(process.env.PROBE_N || 5);
/** Well past the 2,000 ms classifyHold charges for trailing_lead_in. */
const HOLD_MS = 3000;
const FIXTURE = process.env.PROBE_FIXTURE || "trailing_lead_in";
const EST = 0.04;

async function trial(idx) {
  reserve(`R3b manual-vad ${idx + 1}`, EST);
  const { session, state } = await openSession({
    surface: SURFACE, model: MODEL,
    automaticActivityDetection: { disabled: true },
  });
  let row = { trial: idx + 1, fixture: FIXTURE, hold_ms: HOLD_MS };
  try {
    await setupOk(state);
    armTurn(state);

    session.sendRealtimeInput({ activityStart: {} });
    await paceFrames(geminiFrames(FIXTURE).frames, (f) => sendAudio(session, f));
    const tSpeechEnd = Date.now();

    // The caller has trailed off. Keep the line alive exactly as Twilio would,
    // and deliberately do NOT signal end-of-turn. The model must stay silent.
    await paceFrames(silenceFrames("pcm16k", HOLD_MS), (f) => sendAudio(session, f));
    const spokeDuringHold = state.firstAudioAt !== null;
    const spokeAtMs = spokeDuringHold ? state.firstAudioAt - tSpeechEnd : null;

    // Now we decide the turn is over — the role classifyHold plays today.
    session.sendRealtimeInput({ activityEnd: {} });
    const tEnd = Date.now();
    const answered = await waitFor(() => state.firstAudioAt !== null, 15000);

    row = {
      ...row,
      cut_in_during_hold: spokeDuringHold,
      spoke_at_ms: spokeAtMs,
      answered_after_activity_end: answered,
      reply_ms: answered && !spokeDuringHold ? state.firstAudioAt - tEnd : null,
      heard: state.inputTranscript.trim(),
      said: state.outputTranscript.trim().slice(0, 160),
    };
  } finally { try { session.close(); } catch {} await sleep(400); }
  const c = price(MODEL, state.usage);
  commit({ probe: "R3b", arm: `manual-vad:${FIXTURE}`, run: idx + 1, model: MODEL, usage: state.usage, usd: c.usd });
  return { ...row, usd: c.usd };
}

async function main() {
  console.log(`R3b manual activity detection — ${MODEL} @ ${SURFACE}`);
  console.log(`fixture ${FIXTURE}, hold ${HOLD_MS} ms with NO activityEnd, N=${N}`);
  console.log(`spent $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);

  const rows = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await trial(i);
      rows.push(r);
      console.log(
        `  trial ${r.trial}: cut_in_during_hold=${r.cut_in_during_hold}` +
        `  answered_after_activityEnd=${r.answered_after_activity_end}` +
        `  reply ${r.reply_ms ?? "-"} ms`
      );
      writeRaw("r3-manual-vad", { model: MODEL, fixture: FIXTURE, hold_ms: HOLD_MS, rows });
    } catch (e) {
      if (e.name === "BudgetExceeded") throw e;
      console.log(`  trial ${i + 1}: FAILED — ${e.message?.slice(0, 120)}`);
      rows.push({ trial: i + 1, error: e.message });
      writeRaw("r3-manual-vad", { model: MODEL, fixture: FIXTURE, hold_ms: HOLD_MS, rows });
    }
  }

  const held = rows.filter((r) => r.cut_in_during_hold === false).length;
  const answered = rows.filter((r) => r.answered_after_activity_end).length;
  const valid = rows.filter((r) => !r.error).length;
  console.log(`\n  held the turn open ${held}/${valid}   answered on our signal ${answered}/${valid}`);
  console.log(`  reply latency after activityEnd p50 ${p50(rows.map((r) => r.reply_ms).filter(Boolean))} ms`);
  console.log(`  spent $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`R3b ABORTED: ${e.message}`); process.exit(1); });
