// ---------------------------------------------------------------------------
// T5 -- the asynchronous function-calling race.
//
// gemini-3.8-live has NON_BLOCKING function calling PERMANENTLY ENABLED. There
// is no synchronous mode; the documented behaviour is that the model keeps
// generating while a tool runs. That is the whole point of the model, and it is
// also, precisely, our oldest unfixed defect: the assistant naming a time
// before the diary has answered.
//
// This gate holds check_appointment_availability for 1,200 ms and asks whether
// anything the caller HEARD during that window named a clock time. Nothing else
// counts -- "let me check", "one moment", a backchannel are all fine and are
// what the wait is for.
//
// PRE-REGISTERED PREDICTION (verdicts-g38.json T5): I predict 3.8 FAILS this,
// stating a clock time in 2 or more of 10, where GPT-Live scored 0 of 10 on
// both delegation arms. This is the gate where I expect the newest model to be
// WORSE than the old one, recorded before the run so it can be checked.
//
// The regex is the pre-registered one, settled against 10 hand positives, 10
// hand negatives and a 373-string corpus of real transcripts. It deliberately
// excludes bare weekday names: the G4 round's only hit was "I'll check Tuesday",
// which is the model echoing the caller, not claiming a diary fact.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import {
  openSession, sendAudio, armTurn, waitForQuiet, setupOk, sleep,
} from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { commit, priceTokens, priceGeminiByMinutes, summary, reserve } from "./lib/spendLive.js";

const MODEL = process.env.M38 || "gemini-3.8-live";
const SURFACE = "aistudio";
const N = Number(process.env.T5_N || 10);
const HOLD_MS = 1200;
const FIXTURE = "rep_time_q";   // "Do you have anything Tuesday morning?"

const SLOTS = ["2026-09-22T10:00:00-05:00", "2026-09-22T14:30:00-05:00"];

/** PRE-REGISTERED. Read from verdicts-g38.json so the two cannot drift apart. */
const PREREG = JSON.parse(fs.readFileSync("scripts/probes/verdicts-g38.json", "utf8"));
const TIME_RE = new RegExp(PREREG.verdicts.find((v) => v.id === "T5").time_regex, "i");

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

async function take(i) {
  reserve(`T5/${i}`, 90, 0.03);
  let ctx = null;
  const row = { take: i };
  const t0 = Date.now();
  try {
    ctx = await openSession({ surface: SURFACE, model: MODEL, answerTools: false });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;

    // PREAMBLE. The first T5 run went straight to rep_time_q with no greeting
    // and only 3 of 10 takes called the diary at all -- where T2, which sent
    // clean_open first, got tool calls 5 of 5, and T3 saw availability checked
    // before every single write. A model asked for a time by a stranger who has
    // not said hello reasonably asks who is calling instead of hitting the
    // diary. The 3 of 10 measured the harness, not the vendor, and a race gate
    // is only meaningful on takes that actually race.
    armTurn(st);
    await paceFrames(pcmFrames("clean_open"), (f) => sendAudio(ctx.session, f));
    await paceFrames(silenceFrames("pcm16k", 2200), (f) => sendAudio(ctx.session, f));
    await waitForQuiet(st, { quietMs: 900, maxMs: 10000 });

    armTurn(st);
    await paceFrames(pcmFrames(FIXTURE), (f) => sendAudio(ctx.session, f));
    await paceFrames(silenceFrames("pcm16k", 1500), (f) => sendAudio(ctx.session, f));

    // Wait for the availability call, then HOLD it.
    const answered = new Set();
    let held = false;
    const deadline = Date.now() + 14_000;
    while (Date.now() < deadline) {
      const pending = (st.turnToolCallObjects || []).filter((c) => !answered.has(c.id));
      for (const call of pending) {
        answered.add(call.id);
        row.tools = row.tools || [];
        row.tools.push(call.name);

        const isAvailability =
          call.name === "check_appointment_availability" || call.name === "get_available_slots";

        if (isAvailability && !held) {
          held = true;
          // THE WINDOW. Everything the caller hears between the model asking
          // for the diary and the diary answering.
          const before = st.outputTranscript;
          row.held_from_ms = Date.now() - t0;
          await sleep(HOLD_MS);
          const after = st.outputTranscript;
          row.text_during_hold = after.slice(before.length);
          row.stated_time_during_hold = TIME_RE.test(row.text_during_hold);
          row.time_match = row.text_during_hold.match(TIME_RE)?.[0] ?? null;
          row.spoke_during_hold = row.text_during_hold.trim().length > 0;
        }

        ctx.session.sendToolResponse({
          functionResponses: [{
            id: call.id, name: call.name,
            response: isAvailability ? { ok: true, slots: SLOTS } : { ok: true },
          }],
        });
      }
      if (held && st.lastAudioAt && Date.now() - st.lastAudioAt > 1200) break;
      await sleep(60);
    }
    await waitForQuiet(st, { quietMs: 900, maxMs: 8000 });

    row.checked_availability = !!held;
    row.full_text = st.outputTranscript.slice(0, 500);
    row.caller_heard = st.inputTranscript.slice(0, 200);
  } catch (e) {
    row.error = e.message;
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const u = ctx?.state?.usage || {};
  let priced = priceTokens(MODEL, {
    audio_in: u.audio_in || 0, audio_out: u.audio_out || 0,
    text_in: u.text_in || 0, text_out: u.text_out || 0,
  });
  if (!(priced.usd > 0)) {
    priced = priceGeminiByMinutes({
      inSeconds: (Date.now() - t0) / 1000,
      outSeconds: (ctx?.state?.audioBytes || 0) / (24000 * 2),
    });
    row.usd_estimated = true;
  }
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "T5", arm: MODEL, label: `t5-${i}`, model: MODEL, usd: priced.usd, estimated: !!row.usd_estimated, note: row.error });

  console.log(
    `  take ${String(i).padStart(2)}  ` +
    `${row.checked_availability ? "checked " : "NO-CHECK"}  ` +
    `${row.stated_time_during_hold ? "*** STATED A TIME ***" : row.spoke_during_hold ? "spoke, no time   " : "silent           "}  ` +
    `$${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`
  );
  if (row.text_during_hold) console.log(`      during hold: ${JSON.stringify(row.text_during_hold.slice(0, 150))}`);
  if (row.time_match) console.log(`      MATCHED: ${JSON.stringify(row.time_match)}`);
  return row;
}

async function main() {
  console.log(`T5 -- async NON_BLOCKING race.  ${MODEL} @ ${SURFACE}`);
  console.log(`  holding ${FIXTURE} availability for ${HOLD_MS}ms, N=${N}`);
  console.log(`  budget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const out = { at: new Date().toISOString(), model: MODEL, n: N, hold_ms: HOLD_MS, fixture: FIXTURE, time_regex: TIME_RE.source, rows: [] };
  for (let i = 1; i <= N; i++) out.rows.push(await take(i));

  const good = out.rows.filter((r) => !r.error && r.checked_availability);
  const statedTime = good.filter((r) => r.stated_time_during_hold);
  const spoke = good.filter((r) => r.spoke_during_hold);

  out.tally = {
    attempted: out.rows.length,
    errored: out.rows.filter((r) => r.error).length,
    never_checked_availability: out.rows.filter((r) => !r.error && !r.checked_availability).length,
    scored: good.length,
    spoke_during_hold: spoke.length,
    stated_a_clock_time: statedTime.length,
    silent_during_hold: good.length - spoke.length,
  };
  out.verdict = {
    predicted: "FAILS -- states a clock time in 2 or more of 10",
    measured: `${statedTime.length} of ${good.length} stated a clock time during the hold`,
    fails: statedTime.length >= 2,
    prediction_held: statedTime.length >= 2,
    baseline_gptlive: "0 of 10 on both delegation arms",
    note_on_dead_air:
      `${good.length - spoke.length} of ${good.length} were SILENT during the hold. ` +
      "Full-Duplex-Bench-v3 reports ~25% silent gaps on delegated turns; a silent " +
      "wait is not a defect here, it is the alternative to the defect.",
  };

  fs.writeFileSync("scripts/probes/results-t5.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\n--- T5 ---`);
  console.log(`  checked the diary       ${good.length}/${out.rows.length}`);
  console.log(`  spoke during the hold   ${spoke.length}/${good.length}`);
  console.log(`  STATED A CLOCK TIME     ${statedTime.length}/${good.length}   ${out.verdict.fails ? "*** FAILS ***" : "pass"}`);
  console.log(`  prediction ("2+ of 10") ${out.verdict.prediction_held ? "HELD" : "WRONG -- I said 3.8 would be worse than GPT-Live here and it was not"}`);
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
