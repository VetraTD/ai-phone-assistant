import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Static pin (no DB): migration 063 is folded into schema.sql exactly.
// The 063 file itself is never edited once applied (checksum recorded).

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const schema = read("database/schema.sql");
const mig = read("database/063_transfer_screening.sql");

const tableBody = (sql, table) => {
  const m = new RegExp(String.raw`CREATE TABLE (?:IF NOT EXISTS )?${table}\s*\(([\s\S]*?)\n\);`).exec(sql);
  expect(m, `CREATE TABLE ${table} not found`).not.toBeNull();
  return m[1];
};
const norm = (s) => s.replace(/ADD COLUMN IF NOT EXISTS\s+/gi, "").replace(/\s+/g, " ").trim();

const COLS = [
  ["transfer_screening", /transfer_screening\s+boolean\s+NOT NULL\s+DEFAULT\s+false/, "transfer_screening boolean NOT NULL DEFAULT false", "businesses"],
  ["transfer_whisper", /transfer_whisper\s+text\s+CHECK\s*\(\s*char_length\(transfer_whisper\)\s*<=\s*200\s*\)/, "transfer_whisper text CHECK (char_length(transfer_whisper) <= 200)", "businesses"],
  ["screened", /screened\s+boolean\s+NOT NULL\s+DEFAULT\s+false/, "screened boolean NOT NULL DEFAULT false", "pending_dials"],
  ["accepted_at", /accepted_at\s+timestamptz/, "accepted_at timestamptz", "pending_dials"],
];
const FNS = ["app_record_screened_pending_dial", "app_pending_dial_business", "app_accept_pending_dial", "app_pending_dial_outcome"];

describe("migration 063 is folded into schema.sql exactly", () => {
  for (const [name, re, expected, table] of COLS) {
    it(`${name}: same definition in both`, () => {
      // The migration adds columns to two tables, so the schema side is read
      // from its own table body and the migration side from the whole file.
      const inSchema = re.exec(tableBody(schema, table));
      const inMig = re.exec(mig);
      expect(inSchema, `${name} missing from schema.sql ${table}`).not.toBeNull();
      expect(inMig, `${name} missing from 063`).not.toBeNull();
      expect(norm(inSchema[0])).toBe(expected);
      expect(norm(inMig[0])).toBe(expected);
    });
  }

  for (const fn of FNS) {
    it(`${fn}: defined, locked down and granted in the migration and the schema`, () => {
      for (const sql of [schema, mig]) {
        expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(`));
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\([^)]*\\) FROM PUBLIC`));
        expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${fn}\\([^)]*\\) TO vetra_app`));
      }
    });
  }

  it("the function bodies are identical in both", () => {
    const body = (sql, fn) =>
      new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\([\\s\\S]*?\\n(?:\\$\\$|END \\$\\$);`).exec(sql)?.[0];
    for (const fn of FNS) {
      const a = body(schema, fn);
      const b = body(mig, fn);
      expect(a, fn).toBeTruthy();
      expect(norm(a)).toBe(norm(b));
    }
  });

  it("schema.sql carries no lock_timeout", () => {
    expect(schema).not.toMatch(/lock_timeout/);
  });
});
