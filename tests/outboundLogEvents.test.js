// tests/outboundLogEvents.test.js
//
// TASK 21 (spec §14; session 2b additions). "A metric on a name nothing logs
// is a permanently green alert" -- this scans the REAL log.* call sites
// rather than trusting a hand-maintained list, so a name can never drift
// silently out of what is actually emitted.
//
// Two separate guards live in this file:
//
//   1. Every §14 event name that belongs to STAGE 2 must be emitted
//      SOMEWHERE in the scanned files. This is a SUBSET check, not equality:
//      the code legitimately logs extra diagnostics §14 never named
//      (outbound_backstop_render_failed, outbound_internal_routes_disabled,
//      ...), and equality would make every one of those a red build.
//      STAGE 3 names (outbound_optout_tool, outbound_webhook_delivery,
//      outbound_callback_recognized) are not emitted yet -- it.todo entries
//      below name the task that ships each one, so they stay visible without
//      ever reading as a passing assertion.
//
//   2. Every counter bumped anywhere in lib/outbound/** (or an outbound-only
//      "outbound_..." name bumped from the shared Live/tools files) must be
//      registered in lib/voice/metrics.js's COUNTER_NAMES, because
//      bumpCounter() drops an unknown name silently. `live_outbound_*` and
//      `outbound_sanitized` are EXCLUDED on purpose: they are the model-audio
//      leak guard's namespace (lib/voice/live/index.js "inspectOutbound",
//      lib/voice/speakableText.js), a naming collision recorded in this
//      session's own global constraints, not an outbound-CALLING metric.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLatencyStats } from "../lib/voice/metrics.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(
  ROOT,
  "docs/superpowers/specs/2026-09-24-outbound-calling-design.md"
);

/** Every .js file under a directory, recursively. */
function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Session 2b scope for the log-event scan: lib/outbound/**, lib/voice/live/
// index.js, and server.js -- everywhere the door or outbound code may log.
const LOG_SCAN_FILES = [
  ...jsFilesUnder(path.join(ROOT, "lib/outbound")),
  path.join(ROOT, "lib/voice/live/index.js"),
  path.join(ROOT, "server.js"),
];

/** Every "outbound_..." name passed to log.info/warn/error across a file set. */
function loggedOutboundEventNames(files) {
  const names = new Set();
  const re = /\blog\.(?:info|warn|error)\(\s*["'`](outbound_[a-zA-Z0-9_]+)["'`]/g;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  return names;
}

const SPEC_SRC = fs.readFileSync(SPEC_PATH, "utf8");

const STAGE_2_NAMES = [
  "outbound_dial",
  "outbound_dial_failed",
  "outbound_gate_refused",
  "outbound_answered",
  "outbound_amd",
  "outbound_first_audio",
  "outbound_backstop_played",
  "outbound_backstop_missing",
  "outbound_first_turn_incomplete",
  "outbound_silent_call",
  "outbound_voicemail",
  "outbound_attempt_result",
  "outbound_outreach_closed",
  "outbound_optout_detector_fired",
  "outbound_claimed_human",
  "outbound_context_missing",
];

/** name -> the stage-3 task that ships it (spec §14; not emitted yet). */
const STAGE_3_NAMES = {
  outbound_optout_tool: "Task 25",
  outbound_webhook_delivery: "Task 28",
  outbound_callback_recognized: "Task 26",
};

describe("outbound §14 log events are actually emitted (stage 2, subset)", () => {
  const logged = loggedOutboundEventNames(LOG_SCAN_FILES);

  it("finds a plausible number of events, so a broken scan cannot pass silently", () => {
    expect(logged.size).toBeGreaterThan(20);
  });

  it("every stage-2 AND stage-3 name is verbatim in spec §14's own list", () => {
    // Read from the spec text rather than hand-copied, so this file's list
    // cannot drift from the spec's without the test itself failing.
    const allNames = [...STAGE_2_NAMES, ...Object.keys(STAGE_3_NAMES)];
    const missing = allNames.filter((n) => !SPEC_SRC.includes(`\`${n}`));
    expect(missing, "not found verbatim in the spec's §14 'Log events:' line").toEqual([]);
  });

  it.each(STAGE_2_NAMES)("stage 2: %s is emitted somewhere", (name) => {
    expect(
      logged.has(name),
      `nothing logs "${name}" -- the alert this feeds would be permanently green`
    ).toBe(true);
  });

  // Extra diagnostics beyond §14 are expected and fine (the subset property
  // this whole file exists to protect) -- named here only as evidence the
  // scan is not accidentally checking an empty haystack.
  it("logs plenty of diagnostics §14 never named, on top of the stage-2 set", () => {
    expect(logged.has("outbound_backstop_render_failed")).toBe(true);
    expect(logged.has("outbound_internal_routes_disabled")).toBe(true);
  });

  for (const [name, task] of Object.entries(STAGE_3_NAMES)) {
    // eslint-disable-next-line vitest/valid-title -- the task name is the point
    it.todo(`stage 3: ${name} ships in ${task} and is not emitted yet`);
  }

  it("no stage-3 name has started being emitted without this file knowing", () => {
    // If one starts being logged, it should graduate off the it.todo list
    // above and into STAGE_2_NAMES with a real passing assertion -- not sit
    // silently either place.
    const early = Object.keys(STAGE_3_NAMES).filter((n) => logged.has(n));
    expect(early, "stage-3 name(s) already emitted — move to STAGE_2_NAMES above").toEqual([]);
  });
});

describe("every outbound counter bumped in code is registered in COUNTER_NAMES", () => {
  // COUNTER_NAMES itself is not exported (bumpCounter silently drops an
  // unknown name), but getLatencyStats().turnTaking is seeded from it 1:1
  // (metrics.js: `_counters = Object.fromEntries(COUNTER_NAMES.map(...))`),
  // so its keys ARE the registered set without needing a new export.
  const registered = new Set(Object.keys(getLatencyStats().turnTaking));

  // lib/voice/live/index.js and services/tools.js are scanned too (the
  // "outbound branches" the session brief asks for), filtered to the
  // "outbound_" naming convention this calling feature actually uses --
  // `live_outbound_*` there is the UNRELATED model-audio leak guard
  // namespace and must never be swept into this check.
  const COUNTER_SCAN_FILES = [
    ...jsFilesUnder(path.join(ROOT, "lib/outbound")),
    path.join(ROOT, "lib/voice/live/index.js"),
    path.join(ROOT, "services/tools.js"),
  ];

  function bumpedOutboundCounterNames() {
    const names = new Set();
    const re = /\bbumpCounter\(\s*["'`](outbound_[a-zA-Z0-9_]+)["'`]/g;
    for (const file of COUNTER_SCAN_FILES) {
      const src = fs.readFileSync(file, "utf8");
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) names.add(m[1]);
    }
    return names;
  }

  const bumped = bumpedOutboundCounterNames();

  it("finds a plausible number of counters, so a broken scan cannot pass silently", () => {
    expect(bumped.size).toBeGreaterThan(5);
  });

  it("never picks up the leak guard's live_outbound_*/outbound_sanitized namespace", () => {
    for (const name of bumped) {
      expect(name.startsWith("live_outbound_")).toBe(false);
      expect(name).not.toBe("outbound_sanitized");
    }
  });

  it.each([...bumped].sort())("%s is registered in COUNTER_NAMES", (name) => {
    expect(registered.has(name), `bumpCounter("${name}") silently drops on every call`).toBe(true);
  });
});
