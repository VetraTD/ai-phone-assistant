// ---------------------------------------------------------------------------
// G4 -- the availability race. The only true head-to-head in this round.
//
// The caller asks "do you have anything Tuesday morning?" and the harness holds
// the availability result back by exactly 1,200 ms -- the real lookup latency
// measured on our own stack, not an invented delay. The question is what the
// model says while it waits.
//
// GPT-Live does not wait politely, and the docs say so: it "can speak while
// backend work is still running", and "a corrective instruction cannot retract
// audio already heard". That is our offer-before-lookup defect stated as a
// platform property. So the question is not WHETHER it speaks, it is WHAT it
// can say -- and that is where the two arms differ:
//
//   arm C (our brain)     the voice layer holds no tools and no diary. The
//                         worst it can invent is encouragement.
//   arm R (their brain)   the backend model can see the diary, so what leaks
//                         early can be a fact.
//
// MEASURED ON THE SESSION TIMELINE, not on arrival times. Both transcripts
// carry start_ms/end_ms in session time, and delegation.created carries
// offset_ms in the same frame of reference. Arrival times are useless here: the
// output transcript lags the output audio by 2.6-3.0 s.
//
// Scored as three separate things, because they are not the same failure:
//   a -- said anything at all  (DESIRABLE; dead air is its own defect)
//   b -- implied availability
//   c -- named a specific time or date  (THE write-integrity defect)
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { outputSpeechRuns } from "./lib/gptlive.js";
import { FRONTEND_INSTRUCTIONS, RESPONSES_DELEGATION, CLIENT_DELEGATION } from "./lib/livePrompt.js";
import { runSession } from "./lib/liveRun.js";
import { scoreRace } from "./lib/score.js";
import { resultFor } from "./lib/tools.js";
import { summary } from "./lib/spendLive.js";

const FIXTURE = "rep_time_q";           // "Do you have anything Tuesday morning?"
const HOLD_MS = 1200;                   // our measured lookup latency
const N = Number(process.env.G4_N || 10);

const AVAILABILITY = resultFor("check_appointment_availability");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function take(arm, i) {
  const isClient = arm === "C";
  const label = `g4-${arm}-${i}`;
  let delegationSeen = null;
  let releasedAt = null;
  let toolCallSeen = null;
  let availabilityCalled = false;
  let availabilityCallAt = null;

  const { state, marks, priced } = await runSession({
    label,
    probe: "G4",
    fixtures: [FIXTURE],
    instructions: FRONTEND_INSTRUCTIONS,
    delegation: isClient ? CLIENT_DELEGATION : RESPONSES_DELEGATION,
    greetFirst: false,          // G3 established it does not greet unprompted
    tailMs: 9000,
    maxSeconds: 60,
    backendUsdGuess: isClient ? 0 : 0.01,
    afterAudio: async ({ session, state: st }) => {
      // Wait for the model to delegate, then hold the answer back by HOLD_MS.
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (isClient && st.delegations.length) { delegationSeen = st.delegations[0]; break; }
        if (!isClient && (st.toolCalls.length || st.delegations.length)) {
          toolCallSeen = st.toolCalls[0] ?? null;
          delegationSeen = st.delegations[0] ?? null;
          break;
        }
        await sleep(50);
      }
      if (!delegationSeen && !toolCallSeen) return;   // nothing to release

      await sleep(HOLD_MS);
      releasedAt = Date.now();

      if (isClient) {
        session.commentary(
          `Tuesday morning has two openings: 10:00 am and 2:30 pm.`,
          delegationSeen.id,
          `release_${i}`
        );
        await sleep(4000);
      } else {
        // ANSWER EVERY TOOL CALL, not just the first.
        //
        // The first version answered toolCalls[0], which is always
        // set_call_intent -- the prompt tells the model to call it "as soon as
        // you understand why the caller is calling". So the availability
        // payload was handed to the wrong call and check_appointment_availability
        // was never answered at all. The arm was measuring a stalled tool loop.
        //
        // The 1,200 ms hold belongs to the availability lookup specifically;
        // every other tool is answered immediately, which is what our own stack
        // does (tool execution itself measured at 0 ms).
        const answered = new Set();
        const deadline2 = Date.now() + 12_000;
        while (Date.now() < deadline2) {
          for (const call of st.toolCalls) {
            if (answered.has(call.call_id)) continue;
            answered.add(call.call_id);
            if (call.name === "check_appointment_availability") {
              availabilityCallAt = st.delegations[0]?.offset_ms ?? null;
              availabilityCalled = true;
              await sleep(HOLD_MS);
              releasedAt = Date.now();
              session.toolResult(call.call_id, AVAILABILITY);
            } else {
              session.toolResult(call.call_id, resultFor(call.name));
            }
          }
          await sleep(50);
        }
      }
    },
  });

  // The wait window, in SESSION time.
  const delegOffset = delegationSeen?.offset_ms ?? null;
  const windowStart = delegOffset;
  const windowEnd = delegOffset === null ? null : delegOffset + HOLD_MS;

  const duringWait = windowStart === null
    ? []
    : state.outputTranscript.filter((t) => t.start_ms >= windowStart && t.start_ms < windowEnd);
  const textDuringWait = duringWait.map((t) => t.delta).join("");
  const score = scoreRace(textDuringWait);

  const callerEnd = state.inputTranscript.length ? Math.max(...state.inputTranscript.map((t) => t.end_ms)) : null;
  const firstReply = state.outputTranscript.length ? Math.min(...state.outputTranscript.map((t) => t.start_ms)) : null;

  const row = {
    arm, take: i,
    delegated: Boolean(delegationSeen),
    delegation_target: delegationSeen?.target ?? null,
    delegation_offset_ms: delegOffset,
    tools_called: state.toolCalls.map((c) => c.name),
    availability_checked: state.toolCalls.some((c) => c.name === "check_appointment_availability"),
    window_ms: [windowStart, windowEnd],
    text_during_wait: textDuringWait.trim(),
    a_any_speech: score.a_any_speech,
    b_implies_availability: score.b_implies_availability,
    c_states_a_slot: score.c_states_a_slot,
    matched_time_expression: score.matched,
    full_reply: state.outputTranscript.map((t) => t.delta).join("").trim(),
    caller_end_ms: callerEnd,
    first_reply_ms: firstReply,
    turn_latency_ms: callerEnd !== null && firstReply !== null ? firstReply - callerEnd : null,
    speech_runs: outputSpeechRuns(state).runs.length,
    usd: Number(priced.usd.toFixed(5)),
    error: marks.error ?? null,
  };

  const flags = [
    row.a_any_speech ? "spoke" : "silent",
    row.b_implies_availability ? "IMPLIES" : "",
    row.c_states_a_slot ? `STATES(${row.matched_time_expression})` : "",
  ].filter(Boolean).join(" ");
  console.log(
    `  arm ${arm} take ${String(i).padStart(2)}  ${row.delegated ? "delegated" : "NO-DELEG "}  ` +
    `${flags.padEnd(28)} $${row.usd.toFixed(4)}`
  );
  if (row.text_during_wait) console.log(`      during wait: ${JSON.stringify(row.text_during_wait)}`);
  return row;
}

async function main() {
  console.log(`G4 -- availability race, ${HOLD_MS}ms hold, N=${N} per arm, alternating.\n`);
  const only = process.env.G4_ARM;
  const prior = (() => {
    try { return JSON.parse(fs.readFileSync("scripts/probes/results-g4.json", "utf8")).rows; } catch { return []; }
  })();
  const rows = only ? prior.filter((r) => r.arm !== only) : [];
  for (let i = 1; i <= N; i++) {
    if (!only || only === "C") rows.push(await take("C", i));
    if (!only || only === "R") rows.push(await take("R", i));
  }

  const summarise = (arm) => {
    const rs = rows.filter((r) => r.arm === arm);
    const c = rs.filter((r) => r.c_states_a_slot).length;
    return {
      of: rs.length,
      delegated: rs.filter((r) => r.delegated).length,
      a_any_speech: rs.filter((r) => r.a_any_speech).length,
      b_implies_availability: rs.filter((r) => r.b_implies_availability).length,
      c_states_a_slot: c,
      availability_checked: rs.filter((r) => r.availability_checked).length,
      median_turn_latency_ms: median(rs.map((r) => r.turn_latency_ms).filter((x) => x !== null)),
      usd: Number(rs.reduce((a, r) => a + r.usd, 0).toFixed(4)),
    };
  };
  const C = summarise("C");
  const R = summarise("R");

  // Pre-registered: arm C fails if it states a slot in more than 1 of 10.
  const cPass = C.c_states_a_slot <= 1;
  const cPredicted = C.c_states_a_slot === 0;
  const rPredicted = R.c_states_a_slot >= 3;

  const out = {
    at: new Date().toISOString(),
    fixture: FIXTURE, hold_ms: HOLD_MS, n: N,
    measured_on: "session timeline (start_ms/end_ms), not arrival times",
    armC: C, armR: R, rows,
    verdicts: {
      armC_pass: cPass,
      armC_prediction_held: cPredicted,
      armC_note: cPass
        ? "client delegation kept the voice layer off the diary"
        : "CLIENT DELEGATION BUYS NOTHING HERE -- the recommendation in docs/gpt-live-analysis.md section 8 is wrong",
      armR_prediction_held: rPredicted,
      armR_note: R.c_states_a_slot === 0
        ? "arm R did NOT leak a slot -- the assistant's argument for client delegation is materially weakened and the report must say so"
        : "arm R leaked a slot as predicted",
    },
    spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-g4.json", JSON.stringify(out, null, 2) + "\n");

  console.log(`\narm C (our brain):   spoke ${C.a_any_speech}/${C.of}, implied ${C.b_implies_availability}, STATED A SLOT ${C.c_states_a_slot}`);
  console.log(`arm R (their brain): spoke ${R.a_any_speech}/${R.of}, implied ${R.b_implies_availability}, STATED A SLOT ${R.c_states_a_slot}`);
  console.log(`\narm C predicted 0 -> ${cPredicted ? "HELD" : "MISSED"}; fails if >1 -> ${cPass ? "PASS" : "FAIL"}`);
  console.log(`arm R predicted >=3 -> ${rPredicted ? "HELD" : "MISSED"}`);
  console.log(`spend so far: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

main();
