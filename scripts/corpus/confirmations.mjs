#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Round A1 "say it once" (T6) — the offline "before".
//
// How many times did a caller hear a booking or message read back before it
// was saved? Computed from call-corpus/ with the SAME detectors and the SAME
// attribution rule as the live per-call `confirm` block (lib/voice/live/
// index.js confirmAudit), so the before and after are one measure:
//   - a read-back is an assistant turn matching confirmReadBackRe or
//     readBackStatementRe (silence-ladder lines excluded);
//   - it belongs to the next save; one spoken in the same turn as the save
//     (the tool ran inside that turn) belongs to that save;
//   - a refusal is a held write (tool_duration gated:true) since the last save.
//
// Revision-independent: it reads what was SAID and what the tools returned,
// not a counter the deployed code emitted (live-counter-is-not-a-baseline).
// The corpus is a set of investigations, not a sample -- report it as the
// distribution of what those calls did, never as a rate for all calls.
//
// Usage: node scripts/corpus/confirmations.mjs [--json]
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStrings } from "../../lib/voice/strings.js";
import { saveRuleFor } from "../../lib/voice/savePolicy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = path.join(ROOT, "call-corpus");
const S = getStrings("en");

// Every tool that writes something a caller asked for (saveRuleFor's tables).
const ACTION_TOOLS = new Set([
  "record_customer_request",
  "record_quote_request",
  "book_appointment",
  "reschedule_appointment_db",
  "book_appointment_in_ehr",
  "reschedule_appointment",
  "cancel_appointment_db",
  "cancel_appointment",
  "correct_appointment_name",
  "add_appointment_note",
]);

// Ladder lines, old wording and new: the model speaking a line it was handed.
const LADDER = [
  /\bsay yes to confirm\b/i,
  /^I'm still here/i,
  /^Hello\? Are you still there\?$/i,
  /^Sorry, are you still there\?/i,
  /stepped away/i,
  /lost you/i,
];
const isLadder = (t) => LADDER.some((re) => re.test(t.trim()));
const isReadBack = (t) =>
  !isLadder(t) && Boolean(S.confirmReadBackRe?.test(t) || S.readBackStatementRe?.test(t));

function loadCall(file) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const payloads = rows
    .map((r) => r.jsonPayload)
    .filter((p) => p && p.ts)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const revision = rows.find((r) => r?.resource?.labels?.revision_name)?.resource?.labels?.revision_name || "unknown";
  return { callSid: path.basename(file, ".json"), revision, payloads };
}

function scoreCall(call) {
  const saves = [];
  let pending = 0;
  let refusals = 0;
  let savesThisTurn = [];
  let readbacks = 0;
  let gateRefusals = 0;
  for (const p of call.payloads) {
    if (p.event === "tool_duration" && ACTION_TOOLS.has(p.tool)) {
      if (p.success === true) {
        savesThisTurn.push({ tool: p.tool, rule: saveRuleFor(p.tool), readbacks: pending, refusals });
        pending = 0;
        refusals = 0;
      } else if (p.gated === true) {
        refusals += 1;
        gateRefusals += 1;
      }
      continue;
    }
    if (p.event !== "live_debug_assistant_turn" || !p.text?.trim()) continue;
    const rb = isReadBack(p.text);
    if (rb) readbacks += 1;
    if (savesThisTurn.length) {
      if (rb) savesThisTurn[0].readbacks += 1;
    } else if (rb) {
      pending += 1;
    }
    saves.push(...savesThisTurn);
    savesThisTurn = [];
  }
  saves.push(...savesThisTurn);
  return {
    callSid: call.callSid.slice(0, 10),
    revision: call.revision,
    saves,
    readbacks,
    gateRefusals,
    overOne: saves.filter((s) => s.readbacks > 1).length,
  };
}

const files = fs.existsSync(CORPUS)
  ? fs.readdirSync(CORPUS).filter((f) => f.endsWith(".json")).map((f) => path.join(CORPUS, f))
  : [];
if (!files.length) {
  console.error(`no corpus at ${CORPUS} (call-corpus/ is gitignored; pull it first)`);
  process.exit(1);
}

const calls = files.map(loadCall).map(scoreCall).filter((c) => c.saves.length || c.gateRefusals);
const allSaves = calls.flatMap((c) => c.saves);
const dist = {};
for (const s of allSaves) dist[s.readbacks] = (dist[s.readbacks] || 0) + 1;
const byRule = {};
for (const s of allSaves) {
  const r = (byRule[s.rule] ||= { saves: 0, over_one: 0, readbacks: 0, refusals: 0 });
  r.saves += 1;
  r.readbacks += s.readbacks;
  r.refusals += s.refusals;
  if (s.readbacks > 1) r.over_one += 1;
}
const totals = {
  calls_with_writes: calls.length,
  calls_with_a_save: calls.filter((c) => c.saves.length).length,
  calls_with_a_save_over_one_readback: calls.filter((c) => c.overOne > 0).length,
  saves: allSaves.length,
  saves_over_one_readback: allSaves.filter((s) => s.readbacks > 1).length,
  readbacks_per_save_distribution: dist,
  gate_refusals: calls.reduce((n, c) => n + c.gateRefusals, 0),
  by_rule: byRule,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ totals, calls }, null, 2));
} else {
  console.log("callSid     revision                    saves  readbacks/save        refusals/save  over_one");
  for (const c of calls) {
    console.log(
      `${c.callSid}  ${c.revision.padEnd(26)}  ${String(c.saves.length).padStart(5)}  ` +
        `${c.saves.map((s) => s.readbacks).join(",").padEnd(20)}  ${c.saves.map((s) => s.refusals).join(",").padEnd(13)}  ${c.overOne}`
    );
  }
  console.log("");
  console.log(JSON.stringify(totals, null, 2));
}
