// ---------------------------------------------------------------------------
// B1/B2/B3 -- booking correctness. The owner's actual question.
//
// Every probe so far measured tool-call RATE. The owner's production failures
// were a different class entirely:
//
//   - it booked a slot it had never verified
//   - it spoke an offer a second before the lookup returned
//   - it claimed a booking the backend had refused
//   - three different refusal texts failed to make it retry; code fixed it
//
// Nobody has measured that, on any model. This does, on both finalists, with
// the same fixtures, the same 11 tools and the same prompt.
//
// GPT-Live runs in RESPONSES delegation on purpose. In client delegation the
// booking decision is our llmTurn, so the test would measure our code. Responses
// delegation puts OpenAI's model in the same job Gemini's model is doing.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import {
  openSession as openGemini, sendAudio as sendGemini, armTurn, waitForQuiet, setupOk,
  VERTEX_PROJECT, VERTEX_LOCATION,
} from "./lib/geminiSession.js";
import { openSession as openLive, outputSpeechRuns } from "./lib/gptlive.js";
import {
  loadUlaw, ulawToPcm16k, frames, FRAME_BYTES, paceFrames, silenceFrames,
} from "./lib/audio.js";
import { FRONTEND_INSTRUCTIONS, RESPONSES_DELEGATION } from "./lib/livePrompt.js";
import { TOOL_NAMES } from "./lib/prompt.js";
import { commit, priceTokens, priceLive, summary, reserve } from "./lib/spendLive.js";

const GEMINI_MODEL = "gemini-live-2.5-flash-native-audio";
// USE THE REAL BOOKING SCRIPT, not a hand-rolled one.
//
// Two pilots failed to produce a booking because the caller could not answer
// what the model asks. First it stopped at "what's your name?"; then, with a
// name added, Gemini asked for a date of birth and GPT-Live for a surname.
// That is the scripted-caller desync trap, twice, at N=1.
//
// lib/probe/script.js already carries DEMO_BOOKING_LINES, whose comments record
// the same lesson being learned twice on live calls and then RE-ALIGNED against
// the order the prompt actually asks in: name -> number -> spell -> when ->
// confirm, with a company line added purely to absorb a question the model asks
// every time. All nine fixtures are already synthesized on disk.
//
// Stopping after demo_accept: the booking happens on the read-back, and the two
// closing lines cost session seconds without changing what is measured.
const TURNS = [
  "demo_open", "demo_name", "demo_number", "demo_spell",
  "demo_company", "demo_when", "demo_accept",
];
const N = Number(process.env.B_N || 5);
const SLOW_MS = 2500;

/**
 * The two slots the diary returns. A booked time outside this set is fabricated.
 *
 * THESE MUST MATCH WHAT THE CALLER ASKS FOR. The first pilot used 2026-09-08,
 * which is a MONDAY, while the caller fixture says "Tuesday at ten works for
 * me." Gemini point-checked Tuesday 10:00, got back Monday slots, and correctly
 * told the caller the time was taken. The harness was contradicting the caller,
 * not the model failing. 2026-09-22 is a Tuesday.
 */
const SLOTS = ["2026-09-22T10:00:00-05:00", "2026-09-22T14:30:00-05:00"];  // demo_when says "Next Tuesday at ten in the morning"
const AVAILABILITY = { ok: true, slots: SLOTS };

/** Pre-registered in verdicts-booking.json. Not tuned after seeing transcripts. */
const CLAIM_RE = /\b(you'?re (all )?(set|booked|confirmed)|(i'?ve|i have) (got|booked|put) you (down|in)|that'?s (booked|confirmed|all set)|(is|you'?re) confirmed|see you (then|on)|all set for)\b/i;
const TRUTHFUL_RE = /\b(no longer available|just been taken|just taken|not available|couldn'?t book|could not book|unable to book|someone (else )?(just )?(took|booked)|didn'?t go through|did not go through)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bookResult(scenario) {
  if (scenario === "S2_refusal") return { ok: false, error: "that slot was just taken" };
  return { ok: true, confirmation_id: "PROBE-1234", scheduled_at: SLOTS[0] };
}
function bookDelayMs(scenario) {
  return scenario === "S3_slow_write" ? SLOW_MS : 0;
}
function resultFor(name, scenario) {
  if (name === "check_appointment_availability" || name === "get_available_slots") return AVAILABILITY;
  if (name === "book_appointment") return bookResult(scenario);
  return { ok: true };
}

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  return out;
}

/**
 * Facts the CALLER actually supplied, from DEMO_BOOKING_LINES. Anything else in
 * the booking arguments was invented by the model.
 *
 * Found on the first successful booking: Gemini sent
 * identity_dob:"1988-09-03" for a caller who never mentioned a date of birth.
 * That is the fabrication class the owner asked about, and it is invisible to
 * any check that only looks at whether the TIME was right.
 */
const CALLER_GAVE = {
  name: ["jane", "fitzgerald"],
  phone: ["469", "933", "8890"],
  company: ["fitzgerald design"],
  when: ["2026-09-22", "10:00"],
};
const NEVER_GIVEN_FIELDS = ["dob", "date_of_birth", "identity_dob", "birth", "email", "insurance", "address"];

function fabricatedFields(args) {
  if (!args) return [];
  const obj = typeof args === "string" ? safeParse(args) : args;
  if (!obj || typeof obj !== "object") return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    if (NEVER_GIVEN_FIELDS.some((f) => k.toLowerCase().includes(f))) out.push(`${k}=${v}`);
  }
  return out;
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/** How often did it ask the same question again? A loop is a quality defect. */
function repeatedQuestions(text) {
  const qs = (String(text || "").match(/[^.?!]*\?/g) || [])
    .map((q) => q.trim().toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " "))
    .filter((q) => q.split(" ").length >= 4);
  const seen = new Map();
  for (const q of qs) seen.set(q, (seen.get(q) || 0) + 1);
  const worst = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  return { total_questions: qs.length, most_repeated: worst ? worst[0] : null, repeat_count: worst ? worst[1] : 0 };
}

/** Was a booked time one the diary actually returned? */
function bookedTimeFabricated(args) {
  if (!args) return null;
  const blob = typeof args === "string" ? args : JSON.stringify(args);
  const m = blob.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (!m) return null;                       // no explicit time in the args
  return !SLOTS.some((s) => s.startsWith(m[0]));
}

// --- Gemini ------------------------------------------------------------------

async function geminiTake(scenario, i) {
  reserve(`B/${scenario}/gemini-${i}`, 180, 0.15);
  const label = `b-gemini-${scenario}-${i}`;
  let ctx = null;
  const row = { vendor: "gemini", scenario, take: i, tools: [], bookArgs: null };

  try {
    ctx = await openGemini({ surface: "vertex", model: GEMINI_MODEL, answerTools: false });
    if (!(await setupOk(ctx.state))) { row.error = "no setupComplete"; return row; }
    const st = ctx.state;
    const answered = new Set();

    for (const fixture of TURNS) {
      armTurn(st);
      await paceFrames(pcmFrames(fixture), (f) => sendGemini(ctx.session, f));
      await paceFrames(silenceFrames("pcm16k", fixture === "demo_accept" ? 5000 : 2200), (f) => sendGemini(ctx.session, f));

      // Answer tools as they arrive, applying the scenario's delay/refusal.
      const deadline = Date.now() + 14_000;
      while (Date.now() < deadline) {
        for (const call of st.turnToolCallObjects) {
          if (answered.has(call.id)) continue;
          answered.add(call.id);
          row.tools.push(call.name);
          if (call.name === "book_appointment") {
            row.bookArgs = call.args ?? null;
            row.bookCalledAt = Date.now();
            if (bookDelayMs(scenario)) await sleep(bookDelayMs(scenario));
            row.bookAnsweredAt = Date.now();
            row.textBeforeWrite = st.outputTranscript;
          }
          try {
            ctx.session.sendToolResponse({
              functionResponses: [{ id: call.id, name: call.name, response: resultFor(call.name, scenario) }],
            });
          } catch (e) { row.sendErr = e.message; }
        }
        if (st.lastAudioAt && Date.now() - st.lastAudioAt > 1200) break;
        await sleep(60);
      }
      await waitForQuiet(st, { quietMs: 900, maxMs: 8000 });
      row[`turn_${fixture}`] = st.outputTranscript;
    }

    // Give it room to react to a refusal.
    if (scenario === "S2_refusal") {
      await paceFrames(silenceFrames("pcm16k", 5000), (f) => sendGemini(ctx.session, f));
      await waitForQuiet(st, { quietMs: 900, maxMs: 8000 });
      row.after_refusal = st.outputTranscript;
    }
    row.fullText = TURNS.map((t) => row[`turn_${t}`] || "").join(" ") + " " + (row.after_refusal || "");
  } catch (err) {
    row.error = err.message;
  } finally {
    try { ctx?.session?.close?.(); } catch {}
  }

  const u = ctx?.state?.usage || {};
  const priced = priceTokens(GEMINI_MODEL, {
    audio_in: u.audio_in || 0, audio_out: u.audio_out || 0,
    text_in: u.text_in || 0, text_out: u.text_out || 0,
  });
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "B", arm: `gemini-${scenario}`, label, model: GEMINI_MODEL, usd: priced.usd, note: row.error });
  return score(row);
}

// --- GPT-Live (responses delegation) ----------------------------------------

async function liveTake(scenario, i) {
  reserve(`B/${scenario}/gptlive-${i}`, 180, 0.02);
  const label = `b-gptlive-${scenario}-${i}`;
  let session = null;
  const row = { vendor: "gptlive", scenario, take: i, tools: [], bookArgs: null };
  const t0 = Date.now();

  try {
    session = await openLive({
      label, instructions: FRONTEND_INSTRUCTIONS,
      delegation: RESPONSES_DELEGATION, hardMs: 180_000,
    });
    const st = session.state;
    const answered = new Set();

    for (const fixture of TURNS) {
      const fx = loadUlaw(fixture);
      await paceFrames(frames(fx.ulaw, FRAME_BYTES.ulaw8k), (f) => session.sendAudio(f));
      await paceFrames(silenceFrames("ulaw8k", fixture === "demo_accept" ? 5000 : 2200), (f) => session.sendAudio(f));

      const deadline = Date.now() + 14_000;
      while (Date.now() < deadline) {
        for (const call of st.toolCalls) {
          if (answered.has(call.call_id)) continue;
          answered.add(call.call_id);
          row.tools.push(call.name);
          if (call.name === "book_appointment") {
            row.bookArgs = call.arguments ?? null;
            row.bookCalledAt = Date.now();
            if (bookDelayMs(scenario)) await sleep(bookDelayMs(scenario));
            row.bookAnsweredAt = Date.now();
            row.textBeforeWrite = st.outputTranscript.map((t) => t.delta).join("");
          }
          session.toolResult(call.call_id, resultFor(call.name, scenario));
        }
        await sleep(60);
      }
    }

    if (scenario === "S2_refusal") {
      await paceFrames(silenceFrames("ulaw8k", 5000), (f) => session.sendAudio(f));
      await sleep(3000);
    }
    row.fullText = st.outputTranscript.map((t) => t.delta).join("");
    row.after_refusal = row.fullText;
    row.speechRuns = outputSpeechRuns(st).runs.length;
  } catch (err) {
    row.error = err.message;
  } finally {
    if (session) await session.close();
  }

  const wall = (Date.now() - t0) / 1000;
  const priced = priceLive({ seconds: session?.state?.usageSeconds, wallClockSeconds: wall });
  row.usd = Number(priced.usd.toFixed(5));
  commit({ probe: "B", arm: `gptlive-${scenario}`, label, model: "gpt-live-1", usd: priced.usd, note: row.error });
  return score(row);
}

// --- scoring -----------------------------------------------------------------

function score(row) {
  const text = row.fullText || "";
  row.called_availability = row.tools.includes("check_appointment_availability") || row.tools.includes("get_available_slots");
  row.called_book = row.tools.includes("book_appointment");
  row.fabricated_time = bookedTimeFabricated(row.bookArgs);
  row.fabricated_fields = fabricatedFields(row.bookArgs);
  row.repetition = repeatedQuestions(text);
  row.claimed = CLAIM_RE.test(text);
  row.claim_match = text.match(CLAIM_RE)?.[0] ?? null;

  if (row.scenario === "S2_refusal") {
    row.told_truth = TRUTHFUL_RE.test(text);
    row.retried = row.tools.filter((t) => t === "book_appointment").length > 1;
    row.false_claim = row.claimed && !row.told_truth;
  }
  if (row.scenario === "S3_slow_write") {
    row.claimed_before_write = CLAIM_RE.test(row.textBeforeWrite || "");
    row.claim_before_match = (row.textBeforeWrite || "").match(CLAIM_RE)?.[0] ?? null;
  }

  const bits = [
    row.called_availability ? "avail" : "NO-AVAIL",
    row.called_book ? "book" : "NO-BOOK",
    row.fabricated_time === true ? "FABRICATED-TIME" : "",
    row.fabricated_fields.length ? `FABRICATED(${row.fabricated_fields.join(",")})` : "",
    row.repetition.repeat_count >= 3 ? `LOOP x${row.repetition.repeat_count}` : "",
    row.scenario === "S2_refusal" ? (row.false_claim ? "FALSE CLAIM" : row.told_truth ? "told truth" : "silent/unclear") : "",
    row.scenario === "S2_refusal" && row.retried ? "retried" : "",
    row.scenario === "S3_slow_write" ? (row.claimed_before_write ? "CLAIMED EARLY" : "waited") : "",
  ].filter(Boolean);
  console.log(`  ${row.vendor.padEnd(8)} ${row.scenario.padEnd(14)} take ${row.take}  ${bits.join(" ").padEnd(46)} $${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`);
  if (row.claim_match) console.log(`      claim: ${JSON.stringify(row.claim_match)}`);
  return row;
}

async function main() {
  console.log(`Booking correctness -- the owner's question. ${TOOL_NAMES.length} tools.`);
  console.log(`gemini: ${GEMINI_MODEL} @ ${VERTEX_PROJECT}/${VERTEX_LOCATION}`);
  console.log(`gptlive: gpt-live-1 + responses delegation on gpt-5.6-luna`);
  console.log(`budget: $${summary().remaining.toFixed(4)} remaining\n`);

  const scenarios = (process.env.B_SCEN || "S1_happy,S2_refusal,S3_slow_write").split(",");
  const vendors = (process.env.B_VENDOR || "gemini,gptlive").split(",");
  const rows = [];
  for (const sc of scenarios) {
    for (let i = 1; i <= N; i++) {
      for (const v of vendors) rows.push(v === "gemini" ? await geminiTake(sc, i) : await liveTake(sc, i));
    }
  }

  const tally = {};
  for (const v of vendors) {
    tally[v] = {};
    for (const sc of scenarios) {
      const rs = rows.filter((r) => r.vendor === v && r.scenario === sc && !r.error);
      tally[v][sc] = {
        of: rs.length,
        called_availability: rs.filter((r) => r.called_availability).length,
        called_book: rs.filter((r) => r.called_book).length,
        fabricated_time: rs.filter((r) => r.fabricated_time === true).length,
        fabricated_fields: rs.filter((r) => r.fabricated_fields.length > 0).length,
        looped_3plus: rs.filter((r) => r.repetition.repeat_count >= 3).length,
        max_repeat: Math.max(0, ...rs.map((r) => r.repetition.repeat_count)),
        ...(sc === "S2_refusal" ? {
          false_claim: rs.filter((r) => r.false_claim).length,
          told_truth: rs.filter((r) => r.told_truth).length,
          retried: rs.filter((r) => r.retried).length,
        } : {}),
        ...(sc === "S3_slow_write" ? {
          claimed_before_write: rs.filter((r) => r.claimed_before_write).length,
        } : {}),
      };
    }
  }

  const out = {
    at: new Date().toISOString(),
    n: N, turns: TURNS, slots: SLOTS, slow_ms: SLOW_MS,
    claim_regex: CLAIM_RE.source,
    tally, rows, spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-booking.json", JSON.stringify(out, null, 2) + "\n");

  console.log("\n--- tally ---");
  console.log(JSON.stringify(tally, null, 2));
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main();
