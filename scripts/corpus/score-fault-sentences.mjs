// LVX158. How often does the assistant tell a caller it CANNOT do something,
// on a call where that something then happens anyway?
//
// The measurement owed since the entry was filed. It decides whether this needs
// its own fix or whether it simply evaporates when the refusals do -- which is
// the whole question, because the only other lever (rewording) has six failures
// and a closed A/B behind it.
//
// The unit that matters is the CALL, not the sentence: a caller hears one of
// these and decides whether to stay on the line. Both are reported, because a
// call with four of them is a different experience from a call with one.
import fs from "node:fs";
import path from "node:path";

const CORPUS = "C:/Users/nithi/VetraTD/ai-phone-assistant/call-corpus";

// Deliberately broad on the FAULT claim and narrow on nothing else. These are
// the shapes seen on real calls: "I am unable to process the cancellations
// right now", "I'm not able to get into the details of why the system isn't
// working", "I couldn't get that time into the diary", "I seem to be having
// trouble accessing the system".
const FAULT =
  /\b(?:i am|i'm|i)\s+(?:so\s+)?(?:sorry[, ]+)?(?:but\s+)?(?:i\s+)?(?:am|'m)?\s*(?:unable to|not able to|can(?:no|')t)\b|\bhaving trouble\b|\bisn'?t working\b|\bis not working\b|\bcouldn'?t get\b|\bcan'?t (?:book|cancel|reschedule|process|access)\b/i;
// An offer to fall back to a human or a message, which is what turns a fault
// sentence into a lost booking.
const FALLBACK =
  /\btake your details\b|\bsomeone (?:from the team |on the team )?(?:can|will) (?:follow up|get back|contact)\b|\bcallback number\b|\bleave your (?:name|number)\b|\bthe team will\b/i;

const ACTION = new Set([
  "book_appointment",
  "cancel_appointment_db",
  "reschedule_appointment_db",
  "correct_appointment_name",
]);

let callsWithRefusal = 0;
let callsWithFault = 0;
let callsWithFaultThenSuccess = 0;
let callsWithFallback = 0;
let sentences = 0;
const detail = [];

for (const file of fs.readdirSync(CORPUS).filter((f) => f.endsWith(".json"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(CORPUS, file), "utf8"));
  const rows = (Array.isArray(raw) ? raw : Object.values(raw))
    .map((e) => e.jsonPayload || {})
    .filter((p) => p.event && p.ts);
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const refusals = rows.filter((p) => p.event === "write_order_refused");
  if (!refusals.length) continue;
  callsWithRefusal += 1;

  const firstRefusalAt = Date.parse(refusals[0].ts);
  // A fault sentence spoken AFTER the first refusal. Before it, the model is
  // talking about something else entirely.
  const faults = rows.filter(
    (p) =>
      p.event === "live_debug_assistant_turn" &&
      Date.parse(p.ts) >= firstRefusalAt &&
      FAULT.test(p.text || "")
  );
  if (!faults.length) continue;
  callsWithFault += 1;
  sentences += faults.length;

  const withFallback = faults.filter((p) => FALLBACK.test(p.text || ""));
  if (withFallback.length) callsWithFallback += 1;

  // Did ANY action tool succeed after the first fault sentence? That is the
  // case that matters: the caller was told it could not be done, and it was.
  const firstFaultAt = Date.parse(faults[0].ts);
  const laterSuccess = rows.some(
    (p) =>
      p.event === "tool_duration" &&
      ACTION.has(p.tool || p.name) &&
      p.success === true &&
      Date.parse(p.ts) > firstFaultAt
  );
  if (laterSuccess) callsWithFaultThenSuccess += 1;

  detail.push({
    call: file.slice(0, 10),
    n: faults.length,
    fallback: withFallback.length > 0,
    laterSuccess,
    first: (faults[0].text || "").slice(0, 120),
  });
}

console.log(`calls with at least one write-order refusal : ${callsWithRefusal}`);
console.log(`...that then told the caller it COULD NOT   : ${callsWithFault}  (${Math.round((100 * callsWithFault) / callsWithRefusal)}%)`);
console.log(`...and offered a message or callback instead: ${callsWithFallback}`);
console.log(`...where the action then SUCCEEDED anyway   : ${callsWithFaultThenSuccess}`);
console.log(`total fault sentences spoken               : ${sentences}`);
console.log("");
for (const d of detail) {
  console.log(
    `${d.call}  x${d.n}${d.fallback ? "  [offered fallback]" : ""}${d.laterSuccess ? "  [SUCCEEDED ANYWAY]" : ""}`
  );
  console.log(`    ${JSON.stringify(d.first)}`);
}
