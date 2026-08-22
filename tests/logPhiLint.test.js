import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PHI_FIELD_NAMES } from "../lib/phiFields.js";

// A1.7's gate, and the half that does the work: the BUILD fails when a
// PHI-typed field can reach a logger or the error tracker.
//
// lib/logger.js redacts these at emit time too, so a leak that ships is inert.
// That is a safety net, and the trouble with a safety net is that people start
// standing on it. This is the part that tells the author, at the moment they
// write it, rather than telling a log sink six months later.
//
// It is a lint, not a proof. It reads source text and it can be defeated by
// anyone determined — `const k = "callerPhone"; log.info(e, { [k]: v })` sails
// through. It is aimed at the accident, which is what actually happened twice:
// `log.info("media_stream_start", { callSid, streamSid, businessPhone,
// callerPhone })` and `log.info("degraded_voicemail_received", { callSid,
// callerNumber })`. Nobody was being clever. They were passing along the
// variables that were in scope.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "tests", // asserts ON the leak shapes, so it necessarily contains them
  "eval", // scenario fixtures carry synthetic caller data by design
  "AI-phone-dashboard", // a separate app with its own suite; uses console, not log
  "latency-runs",
  "docs",
  ".superpowers",
  "infra",
]);

function sourceFiles(dir = ROOT) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The argument text of every `log.<level>(...)` and `captureException(...)`
 * call in `src`, found by scanning forward from the opening paren and counting
 * brackets. Cheap, and enough: these calls are single expressions, not nested
 * program text.
 */
function loggerCallArgs(src) {
  const calls = [];
  const re = /\b(?:log\.(?:info|error|debug)|captureException)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      i++;
    }
    calls.push({ text: src.slice(re.lastIndex, i - 1), index: m.index });
  }
  return calls;
}

/**
 * Whether `name` appears as an object KEY or a shorthand property in `text`.
 *
 * The distinction is the whole reason this is not a bare substring search:
 * `{ channel: "email" }` is a literal value and fine, `{ count: notes.length }`
 * is a derived number and fine, `{ email }` and `{ email: x }` are not.
 *
 * Only text INSIDE braces counts, which rules out the other false positive:
 * `log.info("probe_script_installed", summary)` passes an already-built fields
 * object whose local variable happens to be named `summary`. The name of a
 * variable at the call site is not a field name.
 */
function usedAsKey(text, name) {
  const re = new RegExp(`(^|[{,\\s])${name}\\s*(?::|,|\\}|$)`);
  return braceSegments(text).some((seg) => re.test(seg));
}

/** The contents of every `{...}` in `text`, outermost first. */
function braceSegments(text) {
  const segs = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 1;
    let j = i + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    segs.push(text.slice(i + 1, j - 1));
    i = j - 1;
  }
  return segs;
}

/** @returns {Array<{file: string, line: number, field: string, snippet: string}>} */
function findLeaks() {
  const leaks = [];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, "utf8");
    if (!/\blog\.(info|error|debug)\s*\(|\bcaptureException\s*\(/.test(src)) continue;
    for (const call of loggerCallArgs(src)) {
      for (const field of PHI_FIELD_NAMES) {
        if (!usedAsKey(call.text, field)) continue;
        leaks.push({
          file: path.relative(ROOT, file).replace(/\\/g, "/"),
          line: src.slice(0, call.index).split("\n").length,
          field,
          snippet: call.text.replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
  }
  return leaks;
}

describe("no PHI-typed field reaches a logger or the error tracker", () => {
  it("finds none", () => {
    const leaks = findLeaks();
    const report = leaks.map((l) => `${l.file}:${l.line} passes "${l.field}" — ${l.snippet}`);
    expect(report).toEqual([]);
  });

  // A lint that cannot demonstrate a catch is a lint nobody trusts. These pin
  // the matcher itself, so a later "simplification" that quietly stops matching
  // anything fails here instead of passing silently.
  it.each([
    ['log.info("e", { callSid, callerPhone })', "callerPhone", true],
    ['log.error("e", { callSid, callerNumber })', "callerNumber", true],
    ['captureException(err, { to, subject })', "subject", true],
    ['log.info("e", { clientName: appt.client_name })', "clientName", true],
  ])("%s is caught", (code, field, expected) => {
    const args = loggerCallArgs(code)[0].text;
    expect(usedAsKey(args, field)).toBe(expected);
  });

  // The rule is decidable by NAME alone: a PHI-typed name is not allowed as a
  // log key, whatever the value. `{ phone: !!collected }` is harmless and still
  // rejected, because a lint that has to judge values has to evaluate them, and
  // the fix — calling it `hasPhone` — makes the line clearer anyway.
  it.each([
    ['log.error("e", { channel: "email" })', "email"],
    ['log.info("e", { count: notes.length })', "notes"],
    ['log.info("e", { message: err?.message })', "message"],
    ['log.info("e", { businessPhone })', "businessPhone"],
    ['log.info("probe_script_installed", summary)', "summary"],
    ['log.info("e", { slots: { hasName: !!x, hasPhone: !!y } })', "phone"],
  ])("%s is not a false positive", (code, field) => {
    const args = loggerCallArgs(code)[0].text;
    // `message` and `businessPhone` are deliberately absent from the list; the
    // other two are present but not used as keys.
    const flagged = PHI_FIELD_NAMES.includes(field) && usedAsKey(args, field);
    expect(flagged).toBe(false);
  });

  it("actually scans a meaningful number of files", () => {
    // A path bug that silently scanned nothing would make the check above pass
    // forever. This is the tripwire for that.
    expect(sourceFiles().length).toBeGreaterThan(30);
  });
});
