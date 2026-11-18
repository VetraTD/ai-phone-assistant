// ---------------------------------------------------------------------------
// Does MANUAL VAD fix the trail-off, on 3.8 and on 3.1?
//
// THE CORRECTION THIS PROBE EXISTS TO SERVE. T1 reported "0 cut-ins of 10" for
// gemini-3.8-live and that number measured the WRONG PROPERTY. T1's detector
// asked "did model audio arrive before the caller's last frame" -- i.e. did it
// talk OVER the caller. The trail-off defect is different: it is the model
// jumping into the PAUSE in "It's for, uh --", a caller who has obviously not
// finished. Measured correctly, as time-to-speak after the fixture ends:
//
//   gemini-3.1  p50 1,721ms   min 1,657   10/10 under our 2,000ms bar
//   gemini-3.8  p50 1,179ms   min 1,022   10/10 under our 2,000ms bar
//
// NEITHER model holds a trailing-off caller, and 3.8 is ~540ms WORSE than the
// model it was supposed to replace. The distributions do not overlap.
//
// But `lib/voice/live/turnEnd/classifyHold.js:59` already ships the fix:
//   realtimeInputConfig: { automaticActivityDetection: { disabled: true } }
// with our own classifyHold deciding when the turn ended, behind
// LIVE_TURN_END=hold. Round 3 measured it holding 3/3 on 3.1 and it has never
// been run on 3.8.
//
// So: with the vendor's VAD OFF and no activityEnd sent, does the model stay
// SILENT through a long hold? If yes, the trail-off is not a vendor property at
// all -- it is a configuration we already own, on either model, and it stops
// being a reason to migrate.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import { openSession, sendAudio, armTurn, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { commit, priceGeminiByMinutes, summary, reserve } from "./lib/spendLive.js";

const MODELS = (process.env.MV_MODELS || "gemini-3.8-live,gemini-3.1-flash-live-preview").split(",");
const N = Number(process.env.MV_N || 5);
const FIXTURE = process.env.MV_FIXTURE || "trailing_lead_in";
/** Well past the 2,000 ms classifyHold charges for this fixture. */
const HOLD_MS = 3000;

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

async function trial(model, i) {
  reserve(`MV/${model}-${i}`, 60, 0.02);
  const row = { model, take: i, fixture: FIXTURE, hold_ms: HOLD_MS };
  let ctx = null;
  const t0 = Date.now();
  try {
    ctx = await openSession({
      surface: "aistudio",
      model,
      answerTools: true,
      // THE WHOLE POINT. Vendor endpointing off; we decide when the turn ends.
      automaticActivityDetection: { disabled: true },
    });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;
    armTurn(st);

    ctx.session.sendRealtimeInput({ activityStart: {} });
    await paceFrames(pcmFrames(FIXTURE), (f) => sendAudio(ctx.session, f));
    const speechEndAt = Date.now();

    // The caller has trailed off. Keep the line alive exactly as Twilio would,
    // and deliberately do NOT signal end of turn. A correct model says nothing.
    await paceFrames(silenceFrames("pcm16k", HOLD_MS), (f) => sendAudio(ctx.session, f));

    row.spoke_during_hold = st.firstAudioAt !== null;
    row.spoke_at_ms = row.spoke_during_hold ? st.firstAudioAt - speechEndAt : null;

    // Now WE decide the turn is over -- classifyHold's job in production.
    ctx.session.sendRealtimeInput({ activityEnd: {} });
    const endAt = Date.now();
    const answered = await waitFor(() => st.firstAudioAt !== null, 15000);
    row.answered_after_activity_end = answered;
    row.reply_ms = answered && !row.spoke_during_hold ? st.firstAudioAt - endAt : null;
    row.heard = (st.inputTranscript || "").trim().slice(0, 80);
    await sleep(500);
  } catch (e) {
    row.error = e.message.slice(0, 120);
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const priced = priceGeminiByMinutes({
    inSeconds: (Date.now() - t0) / 1000,
    outSeconds: (ctx?.state?.audioBytes || 0) / (24000 * 2),
  });
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "MANUALVAD", arm: model, label: `mv-${model}-${i}`, model, usd: priced.usd, estimated: true });

  console.log(
    `  ${model.padEnd(32)} t${i}  ` +
    `${row.spoke_during_hold ? "*** CUT IN at " + row.spoke_at_ms + "ms ***" : "held silent  "}   ` +
    `${row.answered_after_activity_end ? "answered after activityEnd" + (row.reply_ms != null ? " +" + row.reply_ms + "ms" : "") : "NO ANSWER"}` +
    `${row.error ? "  ERR " + row.error : ""}`
  );
  return row;
}

const out = { at: new Date().toISOString(), fixture: FIXTURE, hold_ms: HOLD_MS, n: N, rows: [] };
console.log(`manual VAD -- automaticActivityDetection disabled, ${HOLD_MS}ms hold, no activityEnd`);
console.log(`fixture: ${FIXTURE} ("It's for, uh") -- a correct model stays SILENT\n`);
for (const m of MODELS) {
  for (let i = 1; i <= N; i++) out.rows.push(await trial(m.trim(), i));
}

out.tally = {};
for (const m of MODELS) {
  const rs = out.rows.filter((r) => r.model === m.trim() && !r.error);
  out.tally[m.trim()] = {
    of: rs.length,
    held_silent: rs.filter((r) => !r.spoke_during_hold).length,
    cut_in: rs.filter((r) => r.spoke_during_hold).length,
    answered_after_end: rs.filter((r) => r.answered_after_activity_end).length,
    median_reply_after_end_ms: (() => {
      const v = rs.map((r) => r.reply_ms).filter((x) => x != null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    })(),
  };
}
fs.writeFileSync("scripts/probes/results-manualvad.json", JSON.stringify(out, null, 2) + "\n");

console.log("\n--- manual VAD ---");
for (const [m, t] of Object.entries(out.tally)) {
  console.log(`  ${m.padEnd(32)} held silent ${t.held_silent}/${t.of}   cut in ${t.cut_in}   answered after activityEnd ${t.answered_after_end}/${t.of}   reply +${t.median_reply_after_end_ms}ms`);
}
console.log(`\nIf both held: the trail-off is a CONFIG WE OWN, not a vendor property,`);
console.log(`and it stops being a reason to choose one model over the other.`);
console.log(`spend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
