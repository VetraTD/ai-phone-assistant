import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// tests/db/schemaParity.test.js does not compare DEFAULT or CHECK, so the fold
// of migration 052 into schema.sql rested on a manual match. This pins it
// statically (no DB). The 052 file itself is never edited (checksum recorded).

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const schema = read("database/schema.sql");
const mig = read("database/052_transfer_no_answer_and_transferred_at.sql");

const tableBody = (sql, table) => {
  const m = new RegExp(String.raw`CREATE TABLE (?:IF NOT EXISTS )?${table}\s*\(([\s\S]*?)\n\);`).exec(sql);
  expect(m, `CREATE TABLE ${table} not found`).not.toBeNull();
  return m[1];
};
const norm = (s) => s.replace(/ADD COLUMN IF NOT EXISTS\s+/gi, "").replace(/\s+/g, " ").trim();
const COL_RE = /transfer_no_answer\s+text\s+NOT NULL\s+DEFAULT\s+'take_message'\s+CHECK\s*\(\s*transfer_no_answer\s+IN\s*\([^)]*\)\s*\)/;
const EXPECTED =
  "transfer_no_answer text NOT NULL DEFAULT 'take_message' CHECK (transfer_no_answer IN ('take_message', 'own_voicemail'))";

describe("migration 052 is folded into schema.sql exactly", () => {
  it("transfer_no_answer: same type, DEFAULT and CHECK in both", () => {
    const inSchema = COL_RE.exec(tableBody(schema, "businesses"));
    const inMig = COL_RE.exec(mig);
    expect(inSchema, "transfer_no_answer missing from schema.sql businesses").not.toBeNull();
    expect(inMig, "transfer_no_answer missing from 052").not.toBeNull();
    expect(norm(inSchema[0])).toBe(EXPECTED);
    expect(norm(inMig[0])).toBe(EXPECTED);
  });

  it("transferred_at timestamptz appears in calls (schema.sql) and in 052", () => {
    expect(norm(tableBody(schema, "calls"))).toMatch(/\btransferred_at timestamptz\b/);
    expect(norm(mig)).toMatch(/\btransferred_at timestamptz\b/);
  });
});
