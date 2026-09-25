import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimsRecording, TRANSCRIPTION_DISCLOSURE } from "../lib/voice/disclosure.js";

// No call is recorded (tests/recordingPathLint.test.js proves the only <Record>
// is the degraded voicemail), so no source file may put "this call is
// recorded" in front of a caller -- or in front of an operator as a default
// they will copy into their greeting, which is how Digile's line came to say it.
//
// Spec D4 removed every such sentence on 2026-09-24. This keeps it removed: a
// source scan is the only mechanism that catches a sentence nobody has written
// yet. Same trick as recordingPathLint and logPhiLint.
//
// It scans the whole tree, not a list of "caller-facing" directories, because
// the sentence that shipped lived in the dashboard frontend, a directory nobody
// would have listed.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files allowed to contain a matching sentence, and why. */
const ALLOWED = new Map([
  [
    path.join("lib", "voice", "disclosure.js"),
    "defines the patterns; its comments quote the sentences it exists to forbid",
  ],
  [
    path.join("lib", "harness", "fakeDeps.js"),
    "a comment about FUNCTION calls being recorded by the fake db ('db calls are recorded, never sent'), not phone calls",
  ],
  [
    path.join("scripts", "voice-compare.js"),
    "a TTS measurement script; its sample text is the old Digile greeting because that is what production spoke when it was measured",
  ],
]);

/** Directories never scanned. The first group matches recordingPathLint. */
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
  // Probe scripts and their results are the record of what was pushed into a
  // model during a measurement, including the old recording line. Rewriting
  // them would falsify the measurement.
  "probes",
  "call-corpus",
]);

const EXTENSIONS = /\.(js|jsx|mjs|cjs|ts|tsx|html)$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no source file tells a caller the call is recorded", () => {
  it("finds no recording claim outside the named exceptions", () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (claimsRecording(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("still needs every exception, so a stale one cannot hide a new claim", () => {
    // An exception exempts the WHOLE file. If the line that earned it is
    // reworded, the exemption must go too, or the next real claim written in
    // that file passes unseen. Same rule as recordingPathLint.
    const stale = [];
    for (const rel of ALLOWED.keys()) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) { stale.push(`${rel}: file is gone`); continue; }
      const stillMatches = fs.readFileSync(full, "utf8").split(/\r?\n/).some((l) => claimsRecording(l));
      if (!stillMatches) stale.push(`${rel}: no longer contains a matching line -- drop it from ALLOWED`);
    }
    expect(stale).toEqual([]);
  });

  it("offers operators the D4 sentence as the dashboard placeholder, not a hand copy that can drift", () => {
    const src = fs.readFileSync(path.join(ROOT, "AI-phone-dashboard", "frontend", "src", "settings", "LanguagesSection.jsx"), "utf8");
    expect(src).toContain(`placeholder="${TRANSCRIPTION_DISCLOSURE}"`);
  });

  it("scans the dashboard frontend, where the shipped default lived", () => {
    const scanned = walk(ROOT).map((f) => path.relative(ROOT, f));
    expect(scanned).toContain(path.join("AI-phone-dashboard", "frontend", "src", "settings", "LanguagesSection.jsx"));
    expect(scanned).toContain(path.join("lib", "voice", "greeting.js"));
  });
});
