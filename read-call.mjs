#!/usr/bin/env node
/**
 * Read back ONE rig call: the transcript, the counters, and the database rows.
 *
 * Both halves, always. Staging gives neither, which is why four staging calls
 * could not settle what one local call did.
 *
 * Usage: node read-call.js [/tmp/rig.log]
 */
import pg from "pg";
import { readFileSync } from "node:fs";

const LOG = process.argv[2] || "/tmp/rig.log";
const DB = "postgres://vetra:vetra_local_dev@localhost:55432/vetra";

const lines = readFileSync(LOG, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const sids = [...new Set(lines.map((l) => l.callSid).filter(Boolean))];
const sid = sids[sids.length - 1];
if (!sid) {
  console.log("No call in the log yet.");
  process.exit(0);
}
const call = lines.filter((l) => l.callSid === sid);

console.log(`\n=== CALL ${sid} ===\n`);

console.log("--- TRANSCRIPT (assistant turns; the caller side is echo-gated) ---");
const turns = call.filter((l) => l.event === "live_debug_assistant_turn");
if (turns.length === 0) console.log("  (none — note auditTurn runs on turnComplete, so an INTERRUPTED turn leaves no line)");
for (const t of turns) {
  if (t.user_text) console.log(`  caller> ${t.user_text}`);
  console.log(`  asst  > ${t.text}`);
}

const leaks = call.filter((l) => l.event === "live_debug_leak_text");
if (leaks.length) {
  console.log("\n--- LEAK TEXT ---");
  for (const l of leaks) console.log(`  [${l.matched}] ${l.text}`);
}

console.log("\n--- SUMMARY / VERDICT ---");
for (const e of ["live_call_summary", "postcall_verify"]) {
  for (const l of call.filter((x) => x.event === e)) {
    const { event, ts, level, callSid, ...rest } = l;
    console.log(`  ${e}: ${JSON.stringify(rest)}`);
  }
}

console.log("\n--- GUARD EVENTS THIS CALL ---");
const interesting = call.filter((l) =>
  /live_guard_|live_claim|live_offer|live_unusable|live_spelling|live_turn_note|end_call_refused|write_refused|spelling_gate|live_deferral|live_promise|live_zero_text/.test(
    l.event || ""
  )
);
if (interesting.length === 0) console.log("  (none)");
for (const l of interesting) console.log(`  ${l.event}${l.kind ? " kind=" + l.kind : ""}${l.tool ? " tool=" + l.tool : ""}`);

const tok = readFileSync(".env","utf8").match(/^DEBUG_TOKEN=(.*)$/m)?.[1]?.trim();
const res = await fetch("http://localhost:3000/api/debug/latency", { headers: { "x-debug-token": tok } }).then((r) => r.json());
console.log("\n--- COUNTERS (non-zero only) ---");
const nz = Object.entries(res.turnTaking || {}).filter(([, v]) => v);
if (nz.length === 0) console.log("  (all zero)");
for (const [k, v] of nz) console.log(`  ${k.padEnd(38)} ${v}`);

const c = new pg.Client({ connectionString: DB });
await c.connect();
const rows = await c.query(
  `SELECT a.client_name, a.client_phone, a.scheduled_at, a.status, a.notes, a.call_id
     FROM appointments a
     LEFT JOIN calls cl ON cl.id = a.call_id
    WHERE cl.twilio_call_sid = $1 OR a.created_at > now() - interval '20 minutes'
    ORDER BY a.created_at DESC LIMIT 10`,
  [sid]
);
console.log("\n--- DATABASE ROWS (this call, or written in the last 20 min) ---");
if (rows.rowCount === 0) console.log("  (no rows)");
for (const r of rows.rows) {
  console.log(
    `  ${String(r.status).padEnd(10)} ${String(r.client_name).padEnd(18)} ${r.scheduled_at?.toISOString?.() ?? r.scheduled_at}  notes=${r.notes ?? "-"}  call_id=${r.call_id ? "set" : "NULL"}`
  );
}
await c.end();
console.log("");
