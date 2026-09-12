// v2. The v1 heuristic was too loose and inflated the miss rate: it counted
// completion CLAIMS ("I've cancelled that for you"), SMS-consent lines ("Can I
// send you a text confirmation?") and open questions ("what day would you like?")
// as read-backs. None of those should match confirmReadBackRe, so counting them
// as misses measured my own sloppiness rather than the regex.
//
// v2 narrows the candidate pool using detectors this repo already owns, so the
// filter is not something I invented to agree with my conclusion:
//
//   - completionClaimWideRe EXCLUDES a turn that reports something already done.
//     A claim is the opposite of a read-back: one reports, the other asks.
//   - SMS-consent boilerplate is excluded by its own fixed wording.
//   - the turn must still name an appointment action AND a time AND ask.
//
// What is left is turns that describe a PENDING appointment action and put a
// question to the caller. Those are the population confirmReadBackRe exists to
// recognise.
import fs from "node:fs";
import { getStrings } from "./lib/voice/strings.js";

const S = getStrings({ businessName: "Digile Media", timezone: "America/Chicago" });
const re = S.confirmReadBackRe;
const claimRe = S.completionClaimWideRe || S.completionClaimRe;

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const turns = raw
  .map((r) => ({ ts: r.timestamp, sid: r.jsonPayload.callSid, text: String(r.jsonPayload.text || "").trim() }))
  .filter((t) => t.text.length > 0);

const ACTION = /\b(book|cancel|cancelling|canceling|move|moving|reschedul\w*|change|changing)\b/i;
const TIME = /\b(\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}:\d{2}|o'?clock|morning|afternoon|evening|thirty)\b/i;
const DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|september|october|november|december)\b/i;
const SMS = /text confirmation|message and data rates/i;
// An open question asks the caller to SUPPLY something, rather than to approve
// a specific pending action.
const OPEN = /\bwhat (day|time|date)\b|\bwhich (would|time|one)\b|\bwhat.{0,20}works (for you|best)\b/i;

const candidate = (t) =>
  ACTION.test(t) && (TIME.test(t) || DAY.test(t)) && /\?/.test(t) && !SMS.test(t) && !claimRe.test(t) && !OPEN.test(t);

const pool = turns.filter((t) => candidate(t.text));
const missed = pool.filter((t) => !re.test(t.text));

console.log(`corpus                      ${turns.length} assistant turns, ${new Set(turns.map((t) => t.sid)).size} calls`);
console.log(`pending-action questions    ${pool.length}`);
console.log(`  regex RECOGNISES          ${pool.length - missed.length}`);
console.log(`  regex MISSES              ${missed.length}  (${((missed.length / pool.length) * 100).toFixed(0)}%)`);
console.log("");
console.log("=== every miss, deduped ===");
const seen = new Set();
for (const m of missed) {
  const k = m.text.slice(0, 55).toLowerCase();
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`\n[${m.sid.slice(-8)} ${m.ts.slice(11, 19)}]`);
  console.log(`  ${m.text.slice(0, 210)}`);
}
