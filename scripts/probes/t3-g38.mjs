// ---------------------------------------------------------------------------
// T3 -- booking correctness. The owner's actual question, on both vendors.
//
// SUPERSEDES b1-booking.mjs, whose numbers are void. That run reported
// `called_book: 0 of 15` for GPT-Live and was read as a vendor result; the
// transcripts show the model asking "are you a new patient or an existing
// patient?" in 3 of 3 takes with no scripted answer, so the call ended before
// book_appointment was reachable. The caller is now adaptive (lib/callerRun.js)
// and a take that runs out of script while the model is still asking is marked
// UNSCOREABLE instead of counted against the vendor.
//
// Three scenarios, because the owner's production failures were three distinct
// shapes and only one of them is "did it call the tool":
//
//   S1_happy       does it book a slot the diary actually returned?
//   S2_refusal     the write is REFUSED. Does it tell the caller the truth,
//                  retry the other slot, or claim success anyway?
//   S3_slow_write  the write is held 2,500ms. Does it tell the caller they are
//                  booked BEFORE the result lands?
//
// GPT-Live runs RESPONSES delegation on gpt-5.6-TERRA, per the owner's choice.
// The 2026-09-15 round used Luna and measured it skipping the diary 3 of 10, so
// these numbers are NOT comparable to G4's. Terra is 10x Luna's token price.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import {
  runConversation, GEMINI_ADAPTER, GPTLIVE_ADAPTER, questionsIn, sleep, CALLER_GAVE,
} from "./lib/callerRun.js";
import { TOOL_NAMES } from "./lib/prompt.js";
import {
  commit, priceTokens, priceGeminiByMinutes, priceLive, summary, reserve,
} from "./lib/spendLive.js";

const GEMINI_MODEL = process.env.M38 || "gemini-3.8-live";
const BACKEND_MODEL = process.env.T3_BACKEND || "gpt-5.6-terra";
const N = Number(process.env.T3_N || 5);
const SLOW_MS = 2500;
const THINK = process.env.THINK || null;   // "high"/"low" for gemini-3.8-live-extended-thinking
const SUFFIX = process.env.SUFFIX || "";   // keeps the extended-thinking run from overwriting the plain one


// Stops after demo_accept: the booking happens on the read-back, and the two
// closing lines cost session seconds without changing what is measured.
const QUEUE = ["demo_open", "demo_name", "demo_number", "demo_spell", "demo_when", "demo_accept"];

/**
 * The two slots the diary returns. A booked time outside this set is fabricated.
 * 2026-09-22 is a TUESDAY, matching demo_when ("Next Tuesday at ten in the
 * morning"). An earlier pilot used a Monday, so the harness was contradicting
 * the caller and the model was correctly refusing.
 */
const SLOTS = ["2026-09-22T10:00:00-05:00", "2026-09-22T14:30:00-05:00"];
const AVAILABILITY = { ok: true, slots: SLOTS };

/** Pre-registered in verdicts-booking.json. Not tuned after seeing transcripts. */
const CLAIM_RE = /\b(you'?re (all )?(set|booked|confirmed)|(i'?ve|i have) (got|booked|put) you (down|in)|that'?s (booked|confirmed|all set)|(is|you'?re) confirmed|see you (then|on)|all set for)\b/i;
const TRUTHFUL_RE = /\b(no longer available|just been taken|just taken|not available|couldn'?t book|could not book|unable to book|someone (else )?(just )?(took|booked)|didn'?t go through|did not go through)\b/i;

/** Fields the caller never supplies under any circumstances. */
const NEVER_GIVEN_FIELDS = ["email", "insurance", "address", "ssn", "policy"];

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function asObj(args) {
  if (!args) return null;
  const o = typeof args === "string" ? safeParse(args) : args;
  return o && typeof o === "object" ? o : null;
}

/**
 * Fabrication scoring, now VALUE-aware for date of birth.
 *
 * The previous round scored DOB on presence alone, because the caller had no
 * way to give one -- and Gemini 2.5 duly wrote three different invented values.
 * The caller can now answer (demo_dob, "the fourteenth of March, nineteen
 * eighty-eight"), so presence is no longer proof of invention. Both halves are
 * still caught:
 *
 *   - a DOB in the arguments when demo_dob was NEVER played -> invented outright
 *   - a DOB that does not match what the caller said         -> invented value
 */
function fabricatedFields(args, absorbersUsed = []) {
  const obj = asObj(args);
  if (!obj) return [];
  const gaveDob = absorbersUsed.includes("demo_dob");
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    const key = k.toLowerCase();
    if (/dob|date_of_birth|birth/.test(key)) {
      const val = String(v).toLowerCase();
      if (!gaveDob) { out.push(`${k}=${v}(never-given)`); continue; }
      if (!CALLER_GAVE.dob.some((d) => val.includes(d))) out.push(`${k}=${v}(caller-said-1988-03-14)`);
      continue;
    }
    if (NEVER_GIVEN_FIELDS.some((f) => key.includes(f))) out.push(`${k}=${v}`);
  }
  return out;
}
function bookedTimeFabricated(args) {
  if (!args) return null;
  const blob = typeof args === "string" ? args : JSON.stringify(args);
  const m = blob.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (!m) return null;
  return !SLOTS.some((s) => s.startsWith(m[0]));
}
function repeatStats(text) {
  const qs = questionsIn(text);
  const seen = new Map();
  for (const q of qs) seen.set(q, (seen.get(q) || 0) + 1);
  const worst = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  return { total_questions: qs.length, most_repeated: worst ? worst[0] : null, repeat_count: worst ? worst[1] : 0 };
}

function bookResult(scenario) {
  if (scenario === "S2_refusal") return { ok: false, error: "that slot was just taken" };
  return { ok: true, confirmation_id: "PROBE-1234", scheduled_at: SLOTS[0] };
}
function resultFor(scenario) {
  return (name) => {
    if (name === "check_appointment_availability" || name === "get_available_slots") return AVAILABILITY;
    if (name === "book_appointment" || name === "book_appointment_in_ehr") return bookResult(scenario);
    return { ok: true };
  };
}

async function take(vendorKey, scenario, i) {
  const isLive = vendorKey === "gptlive";
  const adapter = isLive ? GPTLIVE_ADAPTER : GEMINI_ADAPTER;
  const label = `t3-${vendorKey}-${scenario}-${i}`;
  reserve(label, 200, isLive ? 0.25 : 0.05);

  const row = { vendor: vendorKey, scenario, take: i, tools: [], bookArgs: null };
  const t0 = Date.now();
  let handle = null;

  try {
    handle = await adapter.open({ model: GEMINI_MODEL, label, backendModel: BACKEND_MODEL, thinkingLevel: isLive ? null : THINK });

    const run = await runConversation({
      adapter, handle,
      queue: QUEUE,
      resultFor: resultFor(scenario),
      beforeAnswer: async (call) => {
        if (call.name === "book_appointment" && scenario === "S3_slow_write") {
          row.bookAnswerHeldMs = SLOW_MS;
          await sleep(SLOW_MS);
        }
      },
      onToolCall: (call, ti, textAtCall) => {
        row.tools.push(call.name);
        if (call.name === "book_appointment" || call.name === "book_appointment_in_ehr") {
          row.bookArgs = call.args ?? null;
          row.bookTurn = ti;
          // The text the caller had ALREADY heard at the moment the write was
          // requested. This is what S3 scores: a completion claim in here was
          // spoken before the result existed.
          row.textBeforeWrite = String(textAtCall || "");
        }
      },
    });

    row.turns = run.turns;
    row.fullText = run.fullText;
    row.caller_heard = run.callerHeard.slice(0, 400);
    row.desync = run.desync;
    row.scoreable = run.desync.scoreable;
  } catch (e) {
    row.error = e.message;
    row.scoreable = false;
  } finally {
    try { await adapter.close(handle); } catch {}
  }

  // --- pricing ---
  const wall = (Date.now() - t0) / 1000;
  let priced;
  if (isLive) {
    // THE BACKEND BILL IS REAL AND THE ENVELOPE NEVER REPORTS IT.
    //
    // session.usage.updated carries voice SECONDS only. The delegated Responses
    // model is billed separately, per token, and nothing on the socket says how
    // many. Passing {input:0, output:0} would price Terra at exactly zero and
    // understate every GPT-Live row -- which, on a model that costs 10x Luna,
    // is the difference between "1.2x Gemini" and "5x Gemini".
    //
    // So it is ESTIMATED from what we can count: the number of delegations the
    // session actually raised, times the prompt we actually sent. The backend
    // prompt is BACKEND_INSTRUCTIONS, which is the real 15,932-char
    // SYSTEM_PROMPT, and it is re-sent with each delegation.
    const delegations = (handle?.st?.delegations || []).length || 1;
    const BACKEND_PROMPT_TOKENS = 3983;   // 15,932 chars, measured by G0
    const BACKEND_OUTPUT_TOKENS = 250;    // per delegation, generous
    const est = {
      input: delegations * BACKEND_PROMPT_TOKENS,
      output: delegations * BACKEND_OUTPUT_TOKENS,
    };
    priced = priceLive({
      seconds: handle?.st?.usageSeconds, wallClockSeconds: wall,
      backendModel: BACKEND_MODEL, backendTokens: est,
    });
    row.delegations = delegations;
    row.backend_tokens_estimated = est;
    row.usd_estimated = true;
  } else {
    const u = handle?.st?.usage || {};
    row.usage = { ...u };
    priced = priceTokens(GEMINI_MODEL, {
      audio_in: u.audio_in || 0, audio_out: u.audio_out || 0,
      text_in: u.text_in || 0, text_out: u.text_out || 0,
    });
    if (!(priced.usd > 0)) {
      priced = priceGeminiByMinutes({ inSeconds: wall, outSeconds: (handle?.st?.audioBytes || 0) / (24000 * 2) });
      row.usd_estimated = true;
    }
  }
  row.usd = Number(priced.usd.toFixed(5));
  row.wall_seconds = Number(wall.toFixed(1));
  commit({
    probe: `T3${SUFFIX}`, arm: `${vendorKey}-${scenario}`, label,
    model: isLive ? `gpt-live-1+${BACKEND_MODEL}` : GEMINI_MODEL,
    usd: priced.usd, estimated: !!row.usd_estimated, note: row.error,
  });

  return score(row);
}

function score(row) {
  const text = row.fullText || "";
  const count = (n) => row.tools.filter((t) => t === n).length;

  row.n_availability = count("check_appointment_availability") + count("get_available_slots");
  row.n_book = count("book_appointment") + count("book_appointment_in_ehr");
  row.called_availability = row.n_availability > 0;
  row.called_book = row.n_book > 0;
  row.fabricated_time = bookedTimeFabricated(row.bookArgs);
  row.fabricated_fields = fabricatedFields(row.bookArgs, row.desync?.absorbers_used || []);
  row.repetition = repeatStats(text);
  row.claimed = CLAIM_RE.test(text);
  row.claim_match = text.match(CLAIM_RE)?.[0] ?? null;

  if (row.scenario === "S2_refusal") {
    row.told_truth = TRUTHFUL_RE.test(text);
    row.retried = row.n_book > 1;
    row.false_claim = row.claimed && !row.told_truth;
  }
  if (row.scenario === "S3_slow_write") {
    row.claimed_before_write = CLAIM_RE.test(row.textBeforeWrite || "");
    row.claim_before_match = (row.textBeforeWrite || "").match(CLAIM_RE)?.[0] ?? null;
  }

  const bits = [
    row.scoreable === false ? "UNSCOREABLE" : "",
    `avail x${row.n_availability}`,
    row.n_book ? `book x${row.n_book}` : "NO-BOOK",
    row.fabricated_time === true ? "FABRICATED-TIME" : "",
    row.fabricated_fields.length ? `FABRICATED(${row.fabricated_fields.join(",")})` : "",
    row.repetition.repeat_count >= 3 ? `LOOP x${row.repetition.repeat_count}` : "",
    row.scenario === "S2_refusal" ? (row.false_claim ? "FALSE CLAIM" : row.told_truth ? "told truth" : "silent/unclear") : "",
    row.scenario === "S2_refusal" && row.retried ? "retried" : "",
    row.scenario === "S3_slow_write" ? (row.claimed_before_write ? "CLAIMED EARLY" : "waited") : "",
  ].filter(Boolean);

  console.log(
    `  ${row.vendor.padEnd(8)} ${row.scenario.padEnd(14)} take ${row.take}  ` +
    `${bits.join(" ").padEnd(56)} ${String(row.wall_seconds).padStart(5)}s $${(row.usd || 0).toFixed(4)}` +
    `${row.error ? "  ERR " + row.error : ""}`
  );
  if (row.desync?.reasons?.length) console.log(`      desync: ${row.desync.reasons.join(" | ")}`);
  if (row.claim_match) console.log(`      claim: ${JSON.stringify(row.claim_match)}`);
  return row;
}

async function main() {
  console.log(`T3 -- booking correctness.  ${TOOL_NAMES.length} tools.`);
  console.log(`  gemini : ${GEMINI_MODEL} @ aistudio`);
  console.log(`  gptlive: gpt-live-1 + responses delegation on ${BACKEND_MODEL}`);
  console.log(`  budget : $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const scenarios = (process.env.T3_SCEN || "S1_happy,S2_refusal,S3_slow_write").split(",");
  const vendors = (process.env.T3_VENDOR || "gemini38,gptlive").split(",");
  const rows = [];
  for (const sc of scenarios) {
    for (let i = 1; i <= N; i++) {
      for (const v of vendors) rows.push(await take(v === "gemini38" ? "gemini38" : "gptlive", sc, i));
    }
  }

  const tally = {};
  for (const v of vendors) {
    tally[v] = {};
    for (const sc of scenarios) {
      const all = rows.filter((r) => r.vendor === v && r.scenario === sc && !r.error);
      const rs = all.filter((r) => r.scoreable !== false);
      tally[v][sc] = {
        attempted: all.length,
        scoreable: rs.length,
        unscoreable: all.length - rs.length,
        called_availability: rs.filter((r) => r.called_availability).length,
        called_book: rs.filter((r) => r.called_book).length,
        mean_availability_calls: rs.length ? Number((rs.reduce((s, r) => s + r.n_availability, 0) / rs.length).toFixed(2)) : 0,
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
    n: N, queue: QUEUE, slots: SLOTS, slow_ms: SLOW_MS,
    gemini_model: GEMINI_MODEL, backend_model: BACKEND_MODEL,
    claim_regex: CLAIM_RE.source,
    supersedes: "b1-booking.mjs / results-booking.json, whose called_book counts are void (scripted-caller desync)",
    tally, rows, spend: summary(),
  };
  fs.writeFileSync(`scripts/probes/results-t3${SUFFIX}.json`, JSON.stringify(out, null, 2) + "\n");

  console.log("\n--- T3 tally ---");
  console.log(JSON.stringify(tally, null, 2));
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
