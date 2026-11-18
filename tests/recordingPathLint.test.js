import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// O28's erasure deletes the recordings named by URLs stored in
// customer_requests.message. That is only complete if the degraded voicemail
// path is the ONLY thing in this system that asks Twilio to record.
//
// It is today. The value of this file is that it stays true: a second <Record>
// somewhere else would create audio at Twilio that nothing points at, and an
// Art. 17 erasure would go on reporting success while missing it entirely —
// silently, and in the same shape as the bug O28 exists to fix.
//
// Same trick as tests/logPhiLint.test.js. A source scan is the only mechanism
// that can catch a path nobody has written yet.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files that are allowed to emit a TwiML <Record> verb, and why. */
const ALLOWED = new Map([
  [
    path.join("lib", "twiml.js"),
    "buildDegradedVoicemailTwiml and buildUnroutedVoicemailTwiml — the two voicemail fallbacks. Their recordingStatusCallback is /twilio/voicemail, which files the URL into customer_requests.message, which is what erasure reads.",
  ],
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "latency-runs",
  "eval",
  "tests",
  "infra",
  "docs",
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".jsx")) out.push(full);
  }
  return out;
}

describe("only the voicemail path records audio at Twilio", () => {
  it("emits a TwiML <Record> verb from exactly one file", () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      // The opening tag only. `<Record` in a COMMENT still counts — a comment
      // describing a recording path is a hint that one exists, and the two
      // minutes spent adding an entry here is the point.
      if (/<Record[\s/>]/.test(src)) offenders.push(rel);
    }

    expect(
      offenders,
      "A new TwiML <Record> creates audio at Twilio that nothing points at, so " +
        "eraseCallerData cannot reach it. Either route its recordingStatusCallback " +
        "through /twilio/voicemail so the URL lands in customer_requests.message, " +
        "or extend services/twilioRecordings.js to enumerate the new source — then " +
        "add the file to ALLOWED here with the reason."
    ).toEqual([]);
  });

  it("keeps the allowed file honest", () => {
    // A stale allowance is its own failure: it says a recording path exists
    // where one no longer does, and the next person trusts it.
    for (const [rel] of ALLOWED) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(/<Record[\s/>]/.test(src), `${rel} no longer records; drop it from ALLOWED`).toBe(true);
    }
  });

  it("routes every recording it does make back to /twilio/voicemail", () => {
    // The callback URL is what turns a recording into a row we can find later.
    // A <Record> with a different callback would be invisible to erasure even
    // from the allowed file.
    const src = fs.readFileSync(path.join(ROOT, "lib", "twiml.js"), "utf8");
    const records = src.match(/<Record[^>]*>/g) || [];
    expect(records.length).toBeGreaterThan(0);
    for (const tag of records) {
      expect(tag).toContain("recordingStatusCallback");
    }
  });
});
