import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// D7 cancels the Supabase subscription. That is only a clean cancellation if
// nothing in this repo can still reach for it — and "nothing does today" is a
// fact with a shelf life, which is what this file gives it.
//
// Two independent assertions, because either alone is a false negative:
//
//   the package is not a dependency  — so an import would fail at install time
//                                      rather than at 3am on a call
//   nothing imports it               — so it cannot come back by someone
//                                      re-adding the dependency and a line
//
// Same mechanism as tests/recordingPathLint.test.js and
// tests/logPhiLint.test.js: a source scan is the only thing that can catch a
// path nobody has written yet.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const PACKAGE_JSONS = ["package.json", path.join("AI-phone-dashboard", "backend", "package.json"), path.join("AI-phone-dashboard", "frontend", "package.json")];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "latency-runs",
  "voice-previews",
  "test-audio",
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the Supabase client is gone", () => {
  it("is not a dependency of any package in this repo", () => {
    for (const rel of PACKAGE_JSONS) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) continue;
      const pkg = require(full);
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys(pkg[field] || {}), `${rel} ${field}`).not.toContain("@supabase/supabase-js");
      }
    }
  });

  // The scan is for the STRING, not for a parsed import, because the two ways
  // it appeared in this repo were `await import("@supabase/supabase-js")`
  // inside a function and `vi.mock("@supabase/supabase-js", ...)` in a test.
  // Neither is a top-level import statement and neither would be caught by
  // looking for one.
  it("is named by no source file, this one excepted", () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
      if (file === fileURLToPath(import.meta.url)) continue;
      if (fs.readFileSync(file, "utf8").includes("@supabase/supabase-js")) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  // The scan has to be able to fail, or it is a test that passes because it
  // looks at nothing. This proves it reads real files and would see the string.
  it("the scan actually reads the repo", () => {
    const files = walk(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join("services", "db.js")))).toBe(true);
    expect(fs.readFileSync(path.join(ROOT, "services", "db.js"), "utf8")).toContain("withTenant");
  });
});
