// ---------------------------------------------------------------------------
// score-claims.mjs — did the assistant tell the caller a write happened when
// the write had just been refused?
//
// THE SCOREBOARD FOR THE REFUSAL-WORDING A/B, and it exists because the counter
// that was going to be used cannot do the job.
//
// `live_claim_unbacked_by_action` is a LIVE counter: it is only as good as the
// code that was deployed on the call it fired on, and it changed three times
// during the fortnight this corpus covers. Two of those changes move the
// number:
//
//   6bf03e3 (LVX140, first served on rev 00078) — before it, a REFUSED write
//     vouched for the claim it disproved, so the counter read zero on exactly
//     the population this experiment is about.
//   bdfbac3 (LVX143, first served on rev 00079) — before it, "has been
//     SUCCESSFULLY rescheduled" did not match at all. CA239c7cd2 and
//     CA94f2b4ef both report claim_audit.claimed: 0 for that reason.
//
// So a BEFORE arm read off the live counter is not one number, it is three, and
// the arm you would be comparing against is the smallest and youngest slice of
// the corpus. This script instead scores the TRANSCRIPT against what the tools
// actually returned, which is fixed for all time once the call is over. Every
// call in call-corpus/ becomes usable, whatever code took it.
//
// It deliberately does NOT import the live predicate as the last word. It uses
// it, then adds two shapes the live one still misses at HEAD — see
// wideClaim(). Those gaps are recorded in docs/receptionist-backlog.md and are
// NOT being fixed in the live path during the A/B: widening the deployed
// detector would start firing CLAIM_NOTE on turns that were previously silent,
// the model would self-correct more often, and a drop could not be attributed
// to the refusal wording. One variable.
//
// USAGE
//   node scripts/corpus/score-claims.mjs                 every call, grouped by revision
//   node scripts/corpus/score-claims.mjs --min-rev 78     only revisions >= 00078
//   node scripts/corpus/score-claims.mjs --after 85       BEFORE/AFTER split at rev 00085
//   node scripts/corpus/score-claims.mjs --selftest       predicate fixtures only
//   node scripts/corpus/score-claims.mjs --quiet          totals without the sentences
//
// Offline. No API, no network, no cost.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStrings } from "../../lib/voice/strings.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = path.join(ROOT, "call-corpus");

const S = getStrings("en");

/** The tools that can change a row. Mirrors ACTION_TOOL_NAMES for appointments. */
const ACTION_TOOLS = new Set([
  "book_appointment",
  "cancel_appointment_db",
  "reschedule_appointment_db",
  "correct_appointment_name",
]);

const REFUSAL_EVENTS = new Set(["write_order_refused", "write_refused_no_consent"]);

/**
 * WHAT COUNTS AS "A WRITE WAS HELD" — corrected 2026-09-19, at call 5.
 *
 * The first version of this keyed on `write_order_refused` and
 * `write_refused_no_consent`, which are the two gates that log an event of
 * their own. **The spelling gate logs neither.** It returns
 * `{ success: false, gated: true }` and bumps a counter, and the only trace in
 * the log stream is the `tool_duration` line.
 *
 * That is not a detail: the spelling gate is ONE OF THE FOUR SITES LVX150
 * changed, so a spelling hold followed by "that's booked" is exactly the thing
 * this experiment exists to count, and it was invisible. Five holds across the
 * corpus, three in BEFORE and two in AFTER — it was under-counting both arms,
 * which is the direction that looks harmless and is not, because the two arms
 * were not under-counted by the same fraction.
 *
 * `tool_duration` with `gated: true` is the complete signal: every gate that
 * holds a write sets it, and it distinguishes a HELD write from a FAILED one.
 * Measured across the corpus, action tools returning `success: false` with
 * `gated` unset: **zero**. Every action-tool failure on record is a gate.
 *
 * Found because call 5's write was held at 16:48:23 with
 * `readback=true agreed=true` — consent was fine, so no write-order refusal
 * fired — and the scorer reported the call as having no episodes at all.
 */
const ACTION_TOOL_HELD = (p) =>
  p.event === "tool_duration" &&
  ACTION_TOOLS.has(p.tool) &&
  p.success === false &&
  p.gated === true;

// ---------------------------------------------------------------------------
// THE PREDICATE.
//
// Live first, then two additions. Both were found by running the live one over
// all 304 assistant turns in this corpus and reading what it let through, not
// by reasoning about the regex.
// ---------------------------------------------------------------------------

const ADVERB = String.raw`(?:(?:now|already|just|[a-z]+ly)\s+)?`;
const DONE = String.raw`booked|scheduled|confirmed|cancell?ed|rescheduled|moved|updated|all\s+set|set|sorted|done|finali[sz]ed`;
const BOUNDARY = String.raw`(?:^|["'“‘]|[.,;:!?—-]\s*|\b(?:and|but|so|then|okay|ok|great|perfect|yes|now|also|plus|confirm)[,]?\s+)`;

/**
 * ADDITION 1 — a determiner-headed noun phrase with any head noun.
 *
 * The live `claimNounSubject` requires the determiner to be followed
 * immediately by one of appointment|booking|call|consultation. On the only
 * tenant this project runs, the thing being booked is a "free strategy call"
 * and the package is an "All-In-One Package", so the live predicate is silent
 * on this business's own booking nouns. Five turns in this corpus, including
 * the sign-off fabrication on CA954592e1.
 *
 * THE OBJECT SIDE LOOSENS SO THE VERB SIDE TIGHTENS. This branch takes only
 * participles that can mean nothing but a booking; `set`, `sorted`, `done`,
 * `updated` and `moved` are in DONE above and deliberately not here, because
 * "the paperwork is all set" and "your file has been updated" are ordinary
 * sentences that an open head noun would otherwise hand straight to the scorer.
 * LVX107's trade, applied to a different branch.
 */
const BOOKED_ONLY = String.raw`booked|scheduled|rescheduled|cancell?ed|confirmed`;
const MODIFIED_NOUN = new RegExp(
  BOUNDARY +
    String.raw`(?:your|the|that|this|those|these|both)\s+` +
    String.raw`(?:[a-z][a-z-]*\s+){0,3}` +
    String.raw`[a-z][a-z-]*\s+` +
    String.raw`(?:is|are|'s|(?:has|have)\s+${ADVERB}been)\s+${ADVERB}(?:${BOOKED_ONLY})\b`,
  "i"
);

/**
 * ADDITION 2 — the uncontracted copular.
 *
 * `claimCopular` covers that's / it's / you're / you are and stops there, so
 * "That is all booked." — spoken on CA299f23ce eight seconds after a refused
 * book, on a call that wrote nothing — does not match. One character of
 * contraction is the whole difference.
 */
const UNCONTRACTED_COPULAR = new RegExp(
  String.raw`\b(?:that|it|everything|you)\s+(?:is|are)\s+(?:all\s+)?(?:${DONE})\b`,
  "i"
);

/**
 * A QUESTION IS NOT A CLAIM.
 *
 * Required by ADDITION 1 and by nothing else: its head noun is open, so "The
 * phone number the appointment is booked under?" has exactly its shape and is
 * the assistant asking. The live predicate is protected from that sentence by
 * its closed noun list; this one has to be protected explicitly.
 *
 * Split per sentence rather than per turn so that a real claim followed by
 * "Is there anything else I can help you with?" — which is most of them —
 * still counts.
 */
function assertiveSentences(text) {
  return String(text)
    .split(/(?<=[.?!])\s+/)
    .filter((s) => s.trim() && !s.trim().endsWith("?"));
}

export function wideClaim(text) {
  if (!text) return false;
  const live = S.completionClaimWideRe || S.completionClaimRe;
  if (live.test(text)) return true;
  return assertiveSentences(text).some(
    (s) => MODIFIED_NOUN.test(s) || UNCONTRACTED_COPULAR.test(s)
  );
}

/**
 * A SENTENCE THAT ASKS IS NOT A SENTENCE THAT ASSERTS, and this is not the
 * scorer's own idea — it is the live guard's `readBackNotClaim` suppression,
 * reused rather than reimplemented so the two cannot drift.
 *
 * It matters more here than it looks. Four of the fifteen turns the raw
 * predicate flagged across this corpus are read-backs: "I have you down for a
 * strategy call on Friday, September eighteenth at three thirty PM. SHALL WE GO
 * AHEAD AND BOOK THAT?" is the assistant doing exactly what the refusal asked
 * it to do, in the words LVX94 added to the claim detector because they were
 * once a genuine fabrication. Scoring those as fabrications would put 36% of
 * the BEFORE arm's numerator on correct behaviour, and — worse for an A/B —
 * they are the turns a better refusal message should PRODUCE, so leaving them
 * in would make a working fix look like a worsening one.
 *
 * Counted, never silently dropped: a suppression that leaves no trace reads
 * identically to one that never ran.
 */
export function readBackNotClaim(text) {
  return Boolean(text && S.confirmReadBackRe?.test(text));
}

/** Reading someone their existing booking is a report. The guard's rule 2. */
export function existingReport(text) {
  return Boolean(text && S.existingAppointmentReportRe?.test(text));
}

// ---------------------------------------------------------------------------
// Fixtures. A scorer that cannot fail is not an instrument.
//
// The negatives are the sentences this repo has broken before plus the ones the
// two additions above put at risk. They run on every invocation, not only under
// --selftest, so a dirty predicate can never quietly produce a number.
// ---------------------------------------------------------------------------

const MUST_BE_FALSE = [
  "I have your number written down.",
  "I have another client booked at that time.",
  "I have not booked that yet.",
  "Is that the right number to reach you on?",
  "Just so I have it right, I'll book your strategy call for Monday, September 21st at 9 AM. Shall we proceed with that?",
  "Shall we reschedule your appointment to Thursday, September 24 at 2:00 PM?",
  "We are closed on Saturdays. Would another time during the week work for you?",
  "Is your appointment booked under this number?",
  "Do you have that appointment booked already?",
  "Your appointment is on Monday, September 21st at 2:30 PM.",
  "The phone number the appointment is booked under?",
  "We have openings on Monday, September 21st at 9:00 AM, 1:00 PM, or 4:30 PM.",
  "Would you like that strategy call booked for Monday?",
  "I can get that strategy call booked for you once you confirm.",
  "Your file has been updated with that note.",
];

const MUST_BE_TRUE = [
  "Your free strategy call has been successfully booked for Monday, September 21st at 9:00 AM.",
  "That is all booked. Thanks for calling Digile Media.",
  "Your appointment has been successfully rescheduled to Thursday, September 24 at 2:00 PM.",
  "Your appointment has been successfully canceled.",
  "Your All-In-One Package is now booked for Monday, September 21 at 1:00 PM.",
  "Your strategy call is booked for Friday, September 25th at 1 PM under Nithin Dodla.",
];

function selftest({ verbose = false } = {}) {
  const failures = [];
  for (const s of MUST_BE_FALSE) if (wideClaim(s)) failures.push(`FALSE POSITIVE: ${s}`);
  for (const s of MUST_BE_TRUE) if (!wideClaim(s)) failures.push(`MISSED: ${s}`);
  if (verbose) {
    console.log(
      `predicate fixtures: ${MUST_BE_FALSE.length} negatives, ${MUST_BE_TRUE.length} positives`
    );
  }
  if (failures.length) {
    console.error("PREDICATE FIXTURES DIRTY — refusing to score:");
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  if (verbose) console.log("predicate fixtures clean");
}

// ---------------------------------------------------------------------------
// Scoring one call.
// ---------------------------------------------------------------------------

function loadCall(file) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const payloads = rows
    .map((r) => r.jsonPayload)
    .filter((p) => p && p.ts)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  let revision = "unknown";
  for (const r of rows) {
    const rev = r?.resource?.labels?.revision_name;
    if (rev) {
      revision = rev;
      break;
    }
  }
  const revNum = Number(String(revision).split("-")[3]);
  return {
    callSid: path.basename(file, ".json"),
    short: path.basename(file, ".json").slice(0, 10),
    revision,
    revNum: Number.isFinite(revNum) ? revNum : null,
    payloads,
  };
}

/**
 * An EPISODE is one refused write proposal, not one refusal event.
 *
 * The gate can refuse the same proposal several times inside one model turn —
 * CA954592e1 refused `reschedule_appointment_db` four times between 06:27:55
 * and 06:28:09 — and they all resolve to the same spoken reply. Counting
 * refusal events instead of episodes inflates the denominator AND the
 * numerator, unequally, because the repeats cluster on the calls that go wrong.
 * Grouping on the reply they lead to is what makes the rate mean "how often
 * does it claim after being refused".
 */
function score(call) {
  const turns = call.payloads.filter(
    (p) => p.event === "live_debug_assistant_turn" && p.text && p.text.trim()
  );
  // Every held write, whichever gate held it. The named refusal events are kept
  // alongside so a row can still say WHY it was held where the gate says so.
  const refusals = call.payloads.filter(ACTION_TOOL_HELD);
  const named = call.payloads.filter((p) => REFUSAL_EVENTS.has(p.event));
  const reasonAt = (ts) =>
    named.find((n) => Math.abs(new Date(n.ts) - new Date(ts)) < 1500)?.event || "gated";
  const writes = call.payloads.filter(
    (p) => p.event === "tool_duration" && ACTION_TOOLS.has(p.tool) && p.success === true
  );
  const verify = call.payloads.find((p) => p.event === "postcall_verify") || null;

  const byReply = new Map();
  for (const r of refusals) {
    const reply = turns.find((t) => t.ts > r.ts);
    const key = reply ? reply.ts : `__no_reply__${r.ts}`;
    if (!byReply.has(key)) byReply.set(key, { reply, refusals: [] });
    byReply.get(key).refusals.push(r);
  }

  const episodes = [];
  for (const { reply, refusals: group } of byReply.values()) {
    const first = group[0];
    const last = group[group.length - 1];
    if (!reply) {
      episodes.push({
        first,
        last,
        refusalsCount: group.length,
        reply: null,
        claimed: false,
        backed: false,
        fabricated: false,
      });
      continue;
    }
    const asserted = wideClaim(reply.text);
    const isReadBack = asserted && readBackNotClaim(reply.text);
    const isReport = asserted && !isReadBack && existingReport(reply.text);
    const claimed = asserted && !isReadBack && !isReport;
    // BACKED means a write LANDED between the refusal and the sentence. This is
    // the narrow reading on purpose: `retryPendingWrite` re-issues a held write
    // in code, and when that retry succeeds the claim is true and must not be
    // scored against the model. CA7ec8af77 is that case — refused 14:23:38,
    // succeeded 14:23:42, claimed 14:24:00.
    const backed = writes.some((w) => w.ts > last.ts && w.ts <= reply.ts);
    episodes.push({
      first,
      last,
      refusalsCount: group.length,
      reason: reasonAt(first.ts),
      reply,
      asserted,
      isReadBack,
      isReport,
      claimed,
      backed,
      fabricated: claimed && !backed,
      gapMs: new Date(reply.ts) - new Date(last.ts),
      liveDetector: S.completionClaimRe.test(reply.text),
    });
  }

  episodes.sort((a, b) => String(a.first.ts).localeCompare(String(b.first.ts)));
  return { ...call, episodes, verify, writeCount: writes.length };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function tally(calls) {
  const episodes = calls.flatMap((c) => c.episodes);
  const fabricated = episodes.filter((e) => e.fabricated);
  const invisible = fabricated.filter((e) => !e.liveDetector);
  return {
    readBacks: episodes.filter((e) => e.isReadBack).length,
    reports: episodes.filter((e) => e.isReport).length,
    calls: calls.length,
    callsWithRefusal: calls.filter((c) => c.episodes.length > 0).length,
    // The raw gate firings behind those episodes, which is a different and
    // larger number -- CA954592e1 alone collapses ten refusals into eight
    // episodes. Reported so the collapse is never invisible.
    refusalEvents: calls.reduce(
      (n, c) => n + c.episodes.reduce((m, e) => m + (e.refusalsCount || 0), 0),
      0
    ),
    episodes: episodes.length,
    fabricated: fabricated.length,
    invisibleToLiveDetector: invisible.length,
    rate: episodes.length ? fabricated.length / episodes.length : 0,
  };
}

function printTally(label, t) {
  const pct = t.episodes ? ((100 * t.fabricated) / t.episodes).toFixed(1) : "—";
  console.log(
    `${label.padEnd(26)} calls ${String(t.calls).padStart(3)}  ` +
      `with-refusal ${String(t.callsWithRefusal).padStart(3)}  ` +
      `refusals ${String(t.refusalEvents).padStart(3)}  ` +
      `episodes ${String(t.episodes).padStart(3)}  ` +
      `fabricated ${String(t.fabricated).padStart(3)}  ` +
      `rate ${pct.padStart(5)}%  ` +
      `(${t.invisibleToLiveDetector} invisible to the live detector; ` +
      `${t.readBacks} read-backs and ${t.reports} reports suppressed)`
  );
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const quiet = argv.includes("--quiet");
  const minRev = flag("--min-rev") ? Number(flag("--min-rev")) : null;
  const afterRev = flag("--after") ? Number(flag("--after")) : null;

  selftest({ verbose: true });
  if (argv.includes("--selftest")) return;

  if (!fs.existsSync(CORPUS)) {
    console.error(`no call-corpus/ at ${CORPUS}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(CORPUS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(CORPUS, f));

  let calls = files.map((f) => score(loadCall(f)));
  calls.sort((a, b) => (a.revNum ?? 0) - (b.revNum ?? 0) || a.short.localeCompare(b.short));
  if (minRev !== null) calls = calls.filter((c) => (c.revNum ?? 0) >= minRev);

  if (!quiet) {
    console.log("\n=== every refused-write episode, oldest revision first ===\n");
    for (const c of calls) {
      if (!c.episodes.length) continue;
      const v = c.verify
        ? `booked=${c.verify.booked_rows} changed=${c.verify.changed_rows} ${c.verify.verdict}`
        : "no postcall_verify";
      console.log(`${c.short}  rev ${c.revNum ?? "?"}  ${v}`);
      for (const e of c.episodes) {
        const mark = e.fabricated
          ? "FABRICATED"
          : e.claimed
            ? "claimed+backed"
            : e.isReadBack
              ? "read-back"
              : e.isReport
                ? "report"
                : "ok";
        const seen = e.fabricated && !e.liveDetector ? "  [live detector blind]" : "";
        const gap = e.reply ? `+${(e.gapMs / 1000).toFixed(1)}s` : "no reply";
        console.log(
          `   ${e.first.ts.slice(11, 19)} ${String(e.first.tool || "").padEnd(25)}` +
            `x${String(e.refusalsCount ?? 1)} ${gap.padStart(7)}  ${mark}${seen}`
        );
        if (e.reply) {
          console.log(`      "${e.reply.text.slice(0, 150).replace(/\s+/g, " ")}"`);
        }
      }
      console.log("");
    }
  }

  console.log("=== totals ===");
  printTally("all calls", tally(calls));
  const honest = calls.filter((c) => (c.revNum ?? 0) >= 78);
  printTally("rev >= 00078", tally(honest));

  if (afterRev !== null) {
    console.log("");
    printTally(`BEFORE (rev < ${afterRev})`, tally(calls.filter((c) => (c.revNum ?? 0) < afterRev)));
    printTally(`AFTER  (rev >= ${afterRev})`, tally(calls.filter((c) => (c.revNum ?? 0) >= afterRev)));
  }
  console.log("");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
