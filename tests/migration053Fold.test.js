import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Static pin (no DB): migration 053 is folded into schema.sql exactly.
// The 053 file itself is never edited once applied (checksum recorded).

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const schema = read("database/schema.sql");
const mig = read("database/053_allow_pricier_numbers.sql");

const tableBody = (sql, table) => {
  const m = new RegExp(String.raw`CREATE TABLE (?:IF NOT EXISTS )?${table}\s*\(([\s\S]*?)\n\);`).exec(sql);
  expect(m, `CREATE TABLE ${table} not found`).not.toBeNull();
  return m[1];
};
const norm = (s) => s.replace(/ADD COLUMN IF NOT EXISTS\s+/gi, "").replace(/\s+/g, " ").trim();
const COL_RE = /allow_pricier_numbers\s+boolean\s+NOT NULL\s+DEFAULT\s+false/;
const EXPECTED = "allow_pricier_numbers boolean NOT NULL DEFAULT false";

describe("migration 053 is folded into schema.sql exactly", () => {
  it("allow_pricier_numbers: same type and DEFAULT in both", () => {
    const inSchema = COL_RE.exec(tableBody(schema, "businesses"));
    const inMig = COL_RE.exec(mig);
    expect(inSchema, "allow_pricier_numbers missing from schema.sql businesses").not.toBeNull();
    expect(inMig, "allow_pricier_numbers missing from 053").not.toBeNull();
    expect(norm(inSchema[0])).toBe(EXPECTED);
    expect(norm(inMig[0])).toBe(EXPECTED);
  });

  it("blocked_destination is in the outreach.close_reason CHECK in both", () => {
    const body = tableBody(schema, "outreach");
    const check = /close_reason\s+text CHECK[^;]*?\)\),/.exec(body);
    expect(check, "close_reason CHECK not found in schema.sql").not.toBeNull();
    expect(check[0]).toContain("'blocked_destination'");
    expect(check[0]).toContain("'held_for_review'");
    expect(mig).toContain("'blocked_destination'");
  });

  it("schema.sql carries no lock_timeout", () => {
    expect(schema).not.toMatch(/lock_timeout/);
  });
});
