// ---------------------------------------------------------------------------
// T7 -- will gemini-3.8-live say an exact sentence?
//
// This is the gate GPT-Live FAILED, and it is the one that decides how much of
// the front-end we have to build ourselves.
//
// Two strings on a real call are not the model's to paraphrase:
//
//   the recording disclosure -- a legal string. A disclosure that reaches three
//   callers in five is not a disclosure.
//   the appointment read-back -- the sentence the caller's consent attaches to.
//   "2:15 pm" becoming "2:15 in the afternoon" is survivable; a wrong hour is
//   a booking the caller never agreed to.
//
// GPT-Live measured, over three mechanisms at N=8 each with the model idle so a
// miss could not be blamed on a collision:
//
//   commentary.append, stock prompt              4/8 delivered, 0 verbatim
//   commentary.append + "relay word for word"    3/8 delivered, 2 verbatim
//   instructions.append carrying the sentence    5/8 delivered, 5 verbatim
//
// Best was 63%, and 12 of 24 pushes were acknowledged and never spoken. The
// design that follows is that our own pre-rendered audio has to own the
// disclosure, because delivery then belongs to our code rather than to a
// model's decision.
//
// The question here is whether Gemini is different. It has no commentary
// channel -- production pushes an exact line through sendClientContent, and
// LVX4 recorded that read-back works on 3.1 with the production prompt. This
// uses THE PRODUCTION WORDING VERBATIM (lib/voice/live/index.js:959 speakLine)
// so the result transfers directly to the code we already have.
//
// PRE-REGISTERED PREDICTION: better than GPT-Live's 5 of 8. I predict 6 or more
// delivered and at least 4 verbatim. No stop condition -- informative either
// way, because a rate under 0.95 means the disclosure needs our audio regardless
// of which vendor wins.
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
const N = Number(process.env.T7_N || 4);   // per case; 2 cases = 8 sessions

const CASES = [
  {
    id: "disclosure",
    critical: true,
    line: "Just so you know, this call is recorded for quality and training purposes.",
    // Facts that must survive even a paraphrase.
    facts: [/recorded|recording/i],
  },
  {
    id: "readback",
    critical: true,
    line: "Your appointment is Thursday the 18th of September at 2:15 pm.",
    facts: [/thursday/i, /18th|eighteenth/i, /september/i, /2:15|two fifteen|quarter past two/i],
  },
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

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9: ]/g, "").replace(/\s+/g, " ").trim();

async function take(testCase, i) {
  reserve(`T7/${testCase.id}-${i}`, 90, 0.03);
  let ctx = null;
  const row = { case: testCase.id, take: i, line: testCase.line };
  const t0 = Date.now();
  try {
    ctx = await openSession({ surface: SURFACE, model: MODEL, answerTools: true });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;

    // Get the call going, then let it go COMPLETELY quiet. Every GPT-Live arm
    // was measured with the model idle so a miss is the mechanism and not a
    // collision; the same courtesy here or the comparison is not one.
    armTurn(st);
    await paceFrames(pcmFrames("clean_open"), (f) => sendAudio(ctx.session, f));
    await paceFrames(silenceFrames("pcm16k", 2500), (f) => sendAudio(ctx.session, f));
    await waitForQuiet(st, { quietMs: 1200, maxMs: 12000 });
    await sleep(600);

    // THE PUSH. Production's exact wording, lib/voice/live/index.js:959.
    armTurn(st);
    const pushedAt = Date.now();
    ctx.session.sendClientContent({
      turns: [{
        role: "user",
        parts: [{
          text:
            "(System: the caller has gone quiet. Say this to them, word " +
            'for word: "' + testCase.line + '")',
        }],
      }],
      turnComplete: true,
    });

    await paceFrames(silenceFrames("pcm16k", 4000), (f) => sendAudio(ctx.session, f));
    await waitForQuiet(st, { quietMs: 1000, maxMs: 12000 });

    const spoken = (st.outputTranscript || "").trim();
    row.spoke_ms = st.firstAudioAt ? st.firstAudioAt - pushedAt : null;
    row.spoken = spoken.slice(0, 400);
    row.delivered = norm(spoken).length > 0;
    row.verbatim = norm(spoken).includes(norm(testCase.line));
    row.facts_intact = testCase.facts.every((re) => re.test(spoken));
    row.silent_miss = !row.delivered;
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
  commit({ probe: "T7", arm: `${MODEL}/${testCase.id}`, label: `t7-${testCase.id}-${i}`, model: MODEL, usd: priced.usd, estimated: !!row.usd_estimated, note: row.error });

  console.log(
    `  ${testCase.id.padEnd(11)} take ${i}  ` +
    `${row.verbatim ? "VERBATIM" : row.delivered ? row.facts_intact ? "paraphrased, facts ok" : "PARAPHRASED, FACTS LOST" : "*** SILENT ***"}`.padEnd(26) +
    `  ${String(row.spoke_ms ?? "-").padStart(5)}ms  $${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`
  );
  if (row.spoken) console.log(`      spoken: ${JSON.stringify(row.spoken.slice(0, 130))}`);
  return row;
}

async function main() {
  console.log(`T7 -- exact sentence delivery.  ${MODEL} @ ${SURFACE}`);
  console.log(`  mechanism: sendClientContent, production's speakLine wording, model idle`);
  console.log(`  budget: $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const out = { at: new Date().toISOString(), model: MODEL, n_per_case: N, rows: [] };
  for (const c of CASES) {
    for (let i = 1; i <= N; i++) out.rows.push(await take(c, i));
  }

  out.tally = {};
  for (const c of CASES) {
    const rs = out.rows.filter((r) => r.case === c.id && !r.error);
    out.tally[c.id] = {
      of: rs.length,
      delivered: rs.filter((r) => r.delivered).length,
      verbatim: rs.filter((r) => r.verbatim).length,
      facts_intact: rs.filter((r) => r.facts_intact).length,
      silent_misses: rs.filter((r) => r.silent_miss).length,
      verbatim_when_delivered: `${rs.filter((r) => r.verbatim).length} of ${rs.filter((r) => r.delivered).length}`,
      rate: rs.length ? Number((rs.filter((r) => r.delivered).length / rs.length).toFixed(2)) : null,
    };
  }

  const all = out.rows.filter((r) => !r.error);
  const delivered = all.filter((r) => r.delivered).length;
  const verbatim = all.filter((r) => r.verbatim).length;
  out.verdict = {
    predicted: "6 or more of 8 delivered, at least 4 verbatim -- better than GPT-Live's 5 of 8",
    measured: `${delivered} of ${all.length} delivered, ${verbatim} verbatim`,
    prediction_held: delivered >= 6 && verbatim >= 4,
    rate: all.length ? Number((delivered / all.length).toFixed(2)) : null,
    usable_for_a_disclosure: all.length ? delivered / all.length >= 0.95 : false,
    gptlive_best: "instructions.append: 5 of 8 delivered, 5 verbatim when delivered, 3 of 3 misses SILENT",
    design_consequence:
      "Under 0.95 the recording disclosure comes from our own pre-rendered audio played into the Twilio leg, " +
      "where delivery is our code's property rather than a model's decision. That holds for whichever vendor wins.",
  };

  fs.writeFileSync("scripts/probes/results-t7.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\n--- T7 ---`);
  for (const [c, t] of Object.entries(out.tally)) {
    console.log(`  ${c.padEnd(11)} delivered ${t.delivered}/${t.of}   verbatim ${t.verbatim}   facts intact ${t.facts_intact}   silent ${t.silent_misses}`);
  }
  console.log(`\n  overall ${delivered}/${all.length} delivered (${out.verdict.rate}), ${verbatim} verbatim`);
  console.log(`  prediction ${out.verdict.prediction_held ? "HELD" : "WRONG"}   usable for a disclosure: ${out.verdict.usable_for_a_disclosure}`);
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
