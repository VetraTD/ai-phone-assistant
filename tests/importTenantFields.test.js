import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// The tenant importer names columns. The schema is 38 migration files. Nothing
// connected the two, and the drift cost Phase 5's Gate 3 its first run:
//
//   BUSINESS_FIELDS included `voice_style`; migration 002 added that column and
//   migration 012 DROPPED it. Every INSERT therefore named a column the table
//   does not have, and the whole import failed — not one field, all of it.
//
// This is the class of bug that only appears when somebody migrates a real
// tenant, which is the worst possible moment to find it. So the list is checked
// against the migration history here instead, for free, on every run.
//
// Deliberately derived from the .sql files rather than from a live database:
// it has to work with no DATABASE_URL, in CI, and on a laptop.
// ---------------------------------------------------------------------------

const DB_DIR = path.join(process.cwd(), "database");

/** Final add/drop state of every column the migrations touch. */
function columnHistory() {
  const state = {};
  for (const f of fs.readdirSync(DB_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(DB_DIR, f), "utf8");
    for (const m of sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) state[m[1]] = { act: "add", file: f };
    for (const m of sql.matchAll(/DROP COLUMN IF EXISTS\s+(\w+)/g)) state[m[1]] = { act: "drop", file: f };
  }
  return state;
}

function importerFields() {
  const src = fs.readFileSync(path.join(process.cwd(), "scripts", "import-tenant.js"), "utf8");
  const block = src.match(/const BUSINESS_FIELDS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("BUSINESS_FIELDS not found in scripts/import-tenant.js");
  return block[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())          // strip comments
    .map((l) => l.replace(/[",]/g, "").trim())
    .filter(Boolean);
}

describe("import-tenant BUSINESS_FIELDS vs the migration history", () => {
  it("names no column that a migration dropped", () => {
    const history = columnHistory();
    const stale = importerFields()
      .filter((c) => history[c]?.act === "drop")
      .map((c) => `${c} (dropped by ${history[c].file})`);

    expect(stale).toEqual([]);
  });

  it("can actually detect a dropped column — the detector is not vacuous", () => {
    // Proves the test above would fail if the bug came back. Without this, a
    // regex that silently stopped matching would leave the check green forever.
    const history = columnHistory();
    expect(history.voice_style).toBeDefined();
    expect(history.voice_style.act).toBe("drop");
    expect(importerFields()).not.toContain("voice_style");
  });

  it("parses a plausible field list, so a broken regex cannot pass by finding nothing", () => {
    const fields = importerFields();
    expect(fields.length).toBeGreaterThan(15);
    expect(fields).toContain("name");
    expect(fields).toContain("phone_number");
  });
});
