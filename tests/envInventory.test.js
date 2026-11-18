import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// D1's code half, as a check rather than a one-off list.
//
// The ledger recorded "95 process.env names in code vs 81 documented" and left
// reconciling them to cutover. Doing it once by hand produces a number that is
// stale the next week — this repository has added and retired a dozen
// variables in the last few days alone. So the deliverable is the guard, not
// the list.
//
// THE MEASUREMENT ITSELF WAS WRONG, which is the first thing this found. A
// grep for `process.env.X` misses every module that takes an injected env
// object and reads `env.X` — lib/bootChecks.js, lib/compliance.js,
// lib/deploymentMode.js, services/gemini.js's vertexConfig, and
// deepgramEnvironment all do exactly that, deliberately, so they can be tested
// without mutating the process. Nine names were invisible to the old count,
// including DEEPGRAM_REGION, VERTEX_ENABLED and GOOGLE_CLOUD_PROJECT — three
// variables that decide data residency and which LLM backend serves patient
// speech.
//
// Two failure directions, and both matter:
//
//   UNDOCUMENTED  a variable the code reads that nobody deploying this could
//                 know to set. That is how a stack boots "successfully" with a
//                 feature silently off — the class A1.2's boot checks exist for.
//   DEAD          a variable documented but no longer read. Someone sets it,
//                 believes it did something, and it did not.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "tests",
  "AI-phone-dashboard", // its own app, its own env, its own .env.example
  "latency-runs",
  "docs",
  "infra",
  ".superpowers",
  "dist",
]);

/**
 * Provided by the platform, not by us.
 *
 * The bar for this list is "a deployment cannot fail to have it, and no
 * operator sets it deliberately for THIS app". NODE_ENV and PORT come from
 * Cloud Run; CI comes from the runner. Anything an operator would have to
 * decide a value for belongs in .env.example instead, which is why this list
 * is short and stays short.
 */
const PLATFORM_PROVIDED = new Set(["NODE_ENV", "PORT", "TZ", "NO_COLOR", "CI", "HOME", "APPDATA"]);

/** Frontend build-time vars. Vite's, injected at build, documented in the frontend. */
const isViteVar = (name) => name.startsWith("VITE_");

function sourceFiles(dir = ROOT) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
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
 * Every environment variable the source reads.
 *
 * Matches BOTH `process.env.X` and `env.X`, because this codebase deliberately
 * uses the second form in the modules that need to be testable without
 * mutating the process. Requiring at least two characters and an underscore-or-
 * uppercase shape keeps out `env.F`-style false positives from unrelated
 * single-letter identifiers.
 */
function envNamesInSource() {
  const names = new Set();
  const patterns = [
    // process.env.NAME
    /process\.env\.([A-Z][A-Z0-9_]{2,})\b/g,
    // env.NAME — an injected env object, which every module that needs to be
    // testable without mutating the process uses deliberately.
    /\benv\.([A-Z][A-Z0-9_]{2,})\b/g,
    // envInt("NAME", …) and friends. FOUR separate local copies of an envInt
    // helper exist (echoGuard, llmTurn, turnManager, geminiCache), and a scan
    // that only looked for property access missed every variable read through
    // one of them — including the LLM hard timeout and the echo-guard tuning.
    /\benv(?:Int|Bool|Str|Num|Flag)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
  ];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, "utf8");
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) names.add(m[1]);
    }
  }
  return names;
}

/** Every variable named in .env.example, commented-out lines included. */
function documentedNames() {
  const src = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const names = new Set();
  for (const line of src.split("\n")) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

describe("environment variables are documented", () => {
  const inCode = envNamesInSource();
  const documented = documentedNames();

  it("finds a plausible number of variables, so a broken scan cannot pass silently", () => {
    // The tripwire for this file's own regex. A pattern change that quietly
    // matched nothing would make every assertion below pass.
    expect(inCode.size).toBeGreaterThan(80);
    expect(documented.size).toBeGreaterThan(80);
  });

  it("every variable the code reads is in .env.example", () => {
    const missing = [...inCode]
      .filter((n) => !documented.has(n))
      .filter((n) => !PLATFORM_PROVIDED.has(n))
      .filter((n) => !isViteVar(n))
      .sort();

    expect(missing, `undocumented: nobody deploying this could know to set these`).toEqual([]);
  });

  it("every variable in .env.example is still read by the code", () => {
    const dead = [...documented].filter((n) => !inCode.has(n)).sort();

    expect(dead, "documented but never read: setting these does nothing").toEqual([]);
  });
});
