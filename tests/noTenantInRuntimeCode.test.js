import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Guard: running code must not name a business, a tenant ID or a client's
// number. The product is generic; per-business facts live in data, never in
// source. A hit here fails the build.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A string item matches literally; a RegExp item matches by test().
// The label is what a failure reports, lowercased.
const FORBIDDEN = [
  /digile/i,
  /ilija/i,
  /brightwork/i,
  "55c7c8c4-2c33-463c-875a-7f16d6bcc17e",
  "2083c6a4-46da-4d82-bb69-93592b464030",
  "+441372656055",
  "+18176011171",
  "+18175803291",
  "07426704500",
];

const labelOf = (item) => (typeof item === "string" ? item : item.source).toLowerCase();
const matches = (item, line) => (typeof item === "string" ? line.includes(item) : item.test(line));

const SCAN_ROOTS = [
  "server.js",
  "lib",
  "services",
  "capabilities",
  "adapters",
  "config",
  "middleware",
  "integrations",
  "AI-phone-dashboard/backend/src",
  "AI-phone-dashboard/frontend/src",
];
const SOURCE_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".html", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__tests__"]);
const SKIP_PREFIXES = ["lib/probe/", "lib/harness/"];

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// Returns the lowercase label of each forbidden item found in running code.
// Comment lines are ignored.
function findTenantNames(sourceText) {
  const found = [];
  for (const line of sourceText.split(/\r?\n/)) {
    if (isCommentLine(line)) continue;
    for (const item of FORBIDDEN) {
      const label = labelOf(item);
      if (!found.includes(label) && matches(item, line)) found.push(label);
    }
  }
  return found;
}

function walk(absPath, relPath, files) {
  const rel = relPath.split(sep).join("/");
  if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) return;
  const st = statSync(absPath);
  if (st.isFile()) {
    if (SOURCE_EXTS.has(extname(absPath))) files.push({ abs: absPath, rel });
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(absPath)) {
    if (SKIP_DIRS.has(name)) continue;
    walk(join(absPath, name), relative(ROOT, join(absPath, name)), files);
  }
}

// Walks the runtime source roots. Returns how many files were read and every
// hit with its file and 1-based line number.
function scanRuntime() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    walk(abs, relative(ROOT, abs), files);
  }
  const hits = [];
  for (const { abs, rel } of files) {
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const label of findTenantNames(line)) {
        hits.push({ file: rel, line: i + 1, label, text: line.trim().slice(0, 160) });
      }
    });
  }
  return { filesRead: files.length, hits };
}

function scanAll() {
  return scanRuntime().hits;
}

describe("no business names in running code", () => {
  it("can fail", () => {
    expect(findTenantNames('const x = "Digile Media";')).toEqual(["digile"]);
    expect(findTenantNames("// Digile Media")).toEqual([]);
  });

  it("walks enough files to mean something", () => {
    expect(scanRuntime().filesRead).toBeGreaterThan(100);
  });

  it("running code names no business", () => {
    expect(scanAll()).toEqual([]);
  });
});
