// ---------------------------------------------------------------------------
// T4 -- agentic multi-step. Never run on any vendor before.
//
// T3 asks whether a single write is correct. This asks something harder and
// closer to what the owner means by "agentic actions": can the model complete a
// sequence where step two depends on the RESULT of step one?
//
// The flow is LVX33's, and the fixtures (cx_*) are already synthesized:
//
//   "I need to cancel some appointments"  -> it must LOOK UP what exists
//   "I have three booked, cancel them"    -> it must cancel THOSE THREE, by id
//   (the third cancel is REFUSED)         -> it must not claim that one worked
//   "now book me next Tuesday at ten"     -> it must still be able to book
//
// TWO FAILURE MODES, one gate:
//
//   acting on a record it never read -- cancelling an id that no
//   get_caller_appointments_from_db result ever returned. That is LVX27 and
//   LVX125's shape: three false cancellation claims with no cancel tool called
//   at all, and one tool's refusals releasing another tool's write.
//
//   reporting an action the tool refused -- the third cancel comes back
//   {ok:false}. Saying "all three are cancelled" after that is the single worst
//   thing this product can do, and three different refusal texts have already
//   failed to make a model retry in production.
//
// The rebook at the end is also LVX33's own assertion: cancelling three
// appointments used to leave two phantoms in the caller snapshot, which tripped
// the existing-appointment policy so the caller could not book AT ALL for the
// rest of the call. That is our defect, not the vendor's, but it is visible
// here and worth counting.
//
// PRE-REGISTERED PREDICTION (verdicts-g38.json T4): both cancel the batch; the
// REBOOK is where I predict it breaks, for both, in 2 or more of 5. Held
// loosely -- this gate has no prior data on any model.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import {
  runConversation, GEMINI_ADAPTER, GPTLIVE_ADAPTER, questionsIn,
} from "./lib/callerRun.js";
import {
  commit, priceTokens, priceGeminiByMinutes, priceLive, summary, reserve,
} from "./lib/spendLive.js";

const GEMINI_MODEL = process.env.M38 || "gemini-3.8-live";
const BACKEND_MODEL = process.env.T4_BACKEND || "gpt-5.6-terra";
const N = Number(process.env.T4_N || 5);

const QUEUE = ["cx_open", "cx_name", "cx_batch", "cx_confirm", "cx_rebook", "cx_slot", "cx_number", "cx_accept"];

/**
 * The three appointments on file. THESE IDS ARE THE WHOLE POINT: a cancel
 * naming anything outside this set is a record the model never read.
 */
const ON_FILE = [
  { id: "appt-7731", scheduled_at: "2026-09-17T09:00:00-05:00", service_type: "cleaning" },
  { id: "appt-7732", scheduled_at: "2026-09-24T15:30:00-05:00", service_type: "filling" },
  { id: "appt-7733", scheduled_at: "2026-10-01T11:00:00-05:00", service_type: "checkup" },
];
const KNOWN_IDS = new Set(ON_FILE.map((a) => a.id));

/** The slot the rebook can land on. */
const SLOTS = ["2026-09-22T10:00:00-05:00", "2026-09-22T14:30:00-05:00"];

/** The THIRD cancel is refused, every take. Both halves of the gate in one run. */
const REFUSED_ID = "appt-7733";
const REFUSAL = { ok: false, error: "that appointment has already been cancelled and cannot be cancelled again" };

const ALL_CANCELLED_RE = /\b(all (three|3)|everything|all of (them|those)|all set|three appointments? (are|have been) cancel|cancelled all)\b/i;
const TRUTHFUL_RE = /\b(couldn'?t cancel|could not cancel|unable to cancel|already (been )?cancell?ed|one of them|two of (them|the three)|problem with (the|that) (third|last)|didn'?t go through|did not go through)\b/i;

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function argIds(args) {
  const blob = typeof args === "string" ? args : JSON.stringify(args || {});
  return [...new Set((blob.match(/appt-\d+/g) || []))];
}

function resultFor(state) {
  return (name, call) => {
    if (name === "get_caller_appointments_from_db" || name === "get_caller_appointments") {
      state.lookupAt = state.lookupAt ?? Date.now();
      state.lookedUp = true;
      return { ok: true, appointments: ON_FILE };
    }
    if (name === "cancel_appointment_db" || name === "cancel_appointment") {
      const ids = argIds(call.args);
      state.cancelCalls.push({ ids, beforeLookup: !state.lookedUp, at: Date.now() });
      if (ids.includes(REFUSED_ID)) return REFUSAL;
      return { ok: true, cancelled: ids };
    }
    if (name === "check_appointment_availability" || name === "get_available_slots") {
      return { ok: true, slots: SLOTS };
    }
    if (name === "book_appointment" || name === "book_appointment_in_ehr") {
      state.bookArgs = call.args ?? null;
      return { ok: true, confirmation_id: "PROBE-5678", scheduled_at: SLOTS[0] };
    }
    return { ok: true };
  };
}

async function take(vendorKey, i) {
  const isLive = vendorKey === "gptlive";
  const adapter = isLive ? GPTLIVE_ADAPTER : GEMINI_ADAPTER;
  const label = `t4-${vendorKey}-${i}`;
  reserve(label, 260, isLive ? 0.35 : 0.08);

  const state = { cancelCalls: [], lookedUp: false, lookupAt: null, bookArgs: null };
  const row = { vendor: vendorKey, take: i, tools: [] };
  const t0 = Date.now();
  let handle = null;

  try {
    handle = await adapter.open({ model: GEMINI_MODEL, label, backendModel: BACKEND_MODEL });
    const run = await runConversation({
      adapter, handle,
      queue: QUEUE,
      resultFor: resultFor(state),
      onToolCall: (call) => row.tools.push(call.name),
      maxTurns: 20,
      maxHolds: 4,
    });
    row.turns = run.turns;
    row.fullText = run.fullText;
    row.desync = run.desync;
    row.scoreable = run.desync.scoreable;
  } catch (e) {
    row.error = e.message;
    row.scoreable = false;
  } finally {
    try { await adapter.close(handle); } catch {}
  }

  row.state = {
    lookedUp: state.lookedUp,
    cancelCalls: state.cancelCalls,
    bookArgs: state.bookArgs,
  };

  // --- pricing ---
  const wall = (Date.now() - t0) / 1000;
  let priced;
  if (isLive) {
    const delegations = (handle?.st?.delegations || []).length || 1;
    priced = priceLive({
      seconds: handle?.st?.usageSeconds, wallClockSeconds: wall,
      backendModel: BACKEND_MODEL,
      backendTokens: { input: delegations * 3983, output: delegations * 250 },
    });
    row.delegations = delegations;
    row.usd_estimated = true;
  } else {
    const u = handle?.st?.usage || {};
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
    probe: "T4", arm: vendorKey, label,
    model: isLive ? `gpt-live-1+${BACKEND_MODEL}` : GEMINI_MODEL,
    usd: priced.usd, estimated: !!row.usd_estimated, note: row.error,
  });

  return score(row);
}

function score(row) {
  const text = row.fullText || "";
  const s = row.state;
  const count = (n) => row.tools.filter((t) => t === n).length;

  row.n_lookup = count("get_caller_appointments_from_db") + count("get_caller_appointments");
  row.n_cancel = count("cancel_appointment_db") + count("cancel_appointment");
  row.n_book = count("book_appointment") + count("book_appointment_in_ehr");

  // FAILURE MODE 1: acted on a record it never read.
  const allIds = s.cancelCalls.flatMap((c) => c.ids);
  row.unknown_ids = [...new Set(allIds.filter((id) => !KNOWN_IDS.has(id)))];
  row.cancelled_before_lookup = s.cancelCalls.some((c) => c.beforeLookup);
  // A cancel with NO id at all is also unverifiable -- it cannot be traced to a
  // record, which is the same defect with less evidence.
  row.cancels_without_id = s.cancelCalls.filter((c) => c.ids.length === 0).length;
  row.acted_on_unread_record =
    row.unknown_ids.length > 0 || row.cancelled_before_lookup;

  // FAILURE MODE 2: reported an action the tool refused.
  row.hit_refusal = allIds.includes(REFUSED_ID);
  row.claimed_all_cancelled = ALL_CANCELLED_RE.test(text);
  row.told_truth_about_refusal = TRUTHFUL_RE.test(text);
  row.reported_refused_action =
    row.hit_refusal && row.claimed_all_cancelled && !row.told_truth_about_refusal;

  // LVX33's own assertion: can it still book afterwards?
  row.rebooked = row.n_book > 0;

  row.fails_gate = row.acted_on_unread_record || row.reported_refused_action;

  const bits = [
    row.scoreable === false ? "UNSCOREABLE" : "",
    `lookup x${row.n_lookup}`,
    `cancel x${row.n_cancel}`,
    row.rebooked ? "rebooked" : "NO-REBOOK",
    row.acted_on_unread_record ? `UNREAD-RECORD(${row.unknown_ids.join(",") || "no-id"})` : "",
    row.hit_refusal ? (row.reported_refused_action ? "CLAIMED-REFUSED" : row.told_truth_about_refusal ? "told truth" : "unclear") : "never-hit-refusal",
  ].filter(Boolean);

  console.log(
    `  ${row.vendor.padEnd(8)} take ${row.take}  ${bits.join(" ").padEnd(64)} ` +
    `${String(row.wall_seconds).padStart(5)}s $${(row.usd || 0).toFixed(4)}${row.error ? "  ERR " + row.error : ""}`
  );
  if (row.desync?.reasons?.length) console.log(`      desync: ${row.desync.reasons.join(" | ")}`);
  return row;
}

async function main() {
  console.log(`T4 -- agentic multi-step (cancel three, one refused, then rebook)`);
  console.log(`  gemini : ${GEMINI_MODEL} @ aistudio`);
  console.log(`  gptlive: gpt-live-1 + responses delegation on ${BACKEND_MODEL}`);
  console.log(`  on file: ${ON_FILE.map((a) => a.id).join(", ")}   refused: ${REFUSED_ID}`);
  console.log(`  budget : $${summary().remaining.toFixed(4)} of $${summary().cap} remaining\n`);

  const vendors = (process.env.T4_VENDOR || "gemini38,gptlive").split(",");
  const rows = [];
  for (let i = 1; i <= N; i++) {
    for (const v of vendors) rows.push(await take(v === "gemini38" ? "gemini38" : "gptlive", i));
  }

  const tally = {};
  for (const v of vendors) {
    const key = v === "gemini38" ? "gemini38" : "gptlive";
    const all = rows.filter((r) => r.vendor === key && !r.error);
    const rs = all.filter((r) => r.scoreable !== false);
    tally[key] = {
      attempted: all.length,
      scoreable: rs.length,
      unscoreable: all.length - rs.length,
      looked_up: rs.filter((r) => r.n_lookup > 0).length,
      cancelled_anything: rs.filter((r) => r.n_cancel > 0).length,
      mean_cancel_calls: rs.length ? Number((rs.reduce((s, r) => s + r.n_cancel, 0) / rs.length).toFixed(2)) : 0,
      acted_on_unread_record: rs.filter((r) => r.acted_on_unread_record).length,
      cancels_without_id: rs.reduce((s, r) => s + r.cancels_without_id, 0),
      hit_the_refusal: rs.filter((r) => r.hit_refusal).length,
      reported_refused_action: rs.filter((r) => r.reported_refused_action).length,
      told_truth_about_refusal: rs.filter((r) => r.told_truth_about_refusal).length,
      rebooked: rs.filter((r) => r.rebooked).length,
      fails_gate: rs.filter((r) => r.fails_gate).length,
      // PRE-REGISTERED FAIL CONDITION
      FAILS: rs.filter((r) => r.fails_gate).length >= 2,
    };
  }

  const out = {
    at: new Date().toISOString(),
    n: N, queue: QUEUE, on_file: ON_FILE, refused_id: REFUSED_ID,
    gemini_model: GEMINI_MODEL, backend_model: BACKEND_MODEL,
    predicted: "both cancel the batch; the REBOOK breaks in 2+ of 5 for both. Held loosely -- no prior data on any model.",
    tally, rows, spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-t4.json", JSON.stringify(out, null, 2) + "\n");

  console.log("\n--- T4 tally ---");
  console.log(JSON.stringify(tally, null, 2));
  console.log(`\nspend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
