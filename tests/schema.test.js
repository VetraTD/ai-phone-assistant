import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// database/schema.sql is the FRESH-INSTALL path: it must already represent
// the fully-migrated state, because nothing runs the numbered migrations
// after it. Historically it drifted — migrations 006 (notification columns),
// 009 (the partial unique index that makes double-booking detection work),
// 015, 016 and 017 all added things schema.sql never grew, so a fresh install
// hit "column does not exist" at runtime on features that worked fine on the
// developers' already-migrated databases.
//
// These tests derive the expectation from the migration files themselves, so
// a NEW migration that isn't folded into schema.sql fails here rather than in
// production.
// ---------------------------------------------------------------------------

const DB_DIR = path.resolve(fileURLToPath(new URL("../database", import.meta.url)));
const schemaSql = fs.readFileSync(path.join(DB_DIR, "schema.sql"), "utf8");

const migrationFiles = fs
  .readdirSync(DB_DIR)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();

/** Strip `-- line comments` so commentary never counts as a definition. */
function stripComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Walk the migrations in order and reduce them to the FINAL expected shape:
 * columns per table (added minus later-dropped), dropped tables, and the
 * index/table names that must exist.
 */
function expectedFromMigrations() {
  const columns = new Map(); // table -> Set(column)
  const droppedTables = new Set();
  const tables = new Set();
  const indexes = new Set();

  for (const file of migrationFiles) {
    const sql = stripComments(fs.readFileSync(path.join(DB_DIR, file), "utf8"));

    // ALTER TABLE <t> ... ADD COLUMN [IF NOT EXISTS] <c> / DROP COLUMN ...
    const alterRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)([\s\S]*?);/gi;
    let m;
    while ((m = alterRe.exec(sql)) !== null) {
      const table = m[1].toLowerCase();
      const body = m[2];
      if (!columns.has(table)) columns.set(table, new Set());
      const set = columns.get(table);
      for (const add of body.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
        set.add(add[1].toLowerCase());
      }
      for (const drop of body.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
        set.delete(drop[1].toLowerCase());
      }
    }

    for (const t of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      tables.add(t[1].toLowerCase());
      droppedTables.delete(t[1].toLowerCase());
    }
    for (const t of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      droppedTables.add(t[1].toLowerCase());
      tables.delete(t[1].toLowerCase());
    }
    for (const i of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      indexes.add(i[1].toLowerCase());
    }
  }

  return { columns, tables, indexes, droppedTables };
}

/** Extract the column names declared in schema.sql's CREATE TABLE <t> (...). */
function schemaColumns(table) {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i");
  const m = re.exec(stripComments(schemaSql));
  if (!m) return null;
  return new Set(
    m[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.match(/^([a-z_][a-z0-9_]*)\s/i) || [])[1])
      .filter(Boolean)
      .map((c) => c.toLowerCase())
      // table-level constraints (UNIQUE (...), PRIMARY KEY (...)) are not columns
      .filter((c) => !["unique", "primary", "foreign", "constraint", "check"].includes(c))
  );
}

const expected = expectedFromMigrations();

describe("database/schema.sql represents the fully-migrated state", () => {
  it("has at least one migration to check against", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  for (const [table, cols] of expected.columns) {
    if (expected.droppedTables.has(table) || cols.size === 0) continue;
    it(`includes every surviving migration-added column on "${table}"`, () => {
      const actual = schemaColumns(table);
      expect(actual, `schema.sql has no CREATE TABLE ${table}`).not.toBeNull();
      const missing = [...cols].filter((c) => !actual.has(c));
      expect(missing, `missing from schema.sql's ${table}: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("creates every table the migrations create and none they drop", () => {
    const stripped = stripComments(schemaSql);
    for (const t of expected.tables) {
      expect(stripped, `schema.sql is missing CREATE TABLE ${t}`).toMatch(
        new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${t}\\b`, "i")
      );
    }
    for (const t of expected.droppedTables) {
      expect(stripped, `schema.sql recreates dropped table ${t}`).not.toMatch(
        new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${t}\\b`, "i")
      );
    }
  });

  it("creates every index the migrations create", () => {
    const stripped = stripComments(schemaSql);
    for (const i of expected.indexes) {
      expect(stripped, `schema.sql is missing index ${i}`).toMatch(new RegExp(`\\b${i}\\b`, "i"));
    }
  });

  it("keeps the double-booking guard: a partial unique index on (business_id, scheduled_at) WHERE status = 'scheduled'", () => {
    // services/tools.js book_appointment relies on Postgres 23505 from this
    // index to tell the caller a slot is taken.
    expect(stripComments(schemaSql)).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+uniq_appointments_business_scheduled_at_active[\s\S]*?ON\s+appointments\s*\(business_id,\s*scheduled_at\)[\s\S]*?WHERE\s+status\s*=\s*'scheduled'/i
    );
  });

  it("defaults allowed_tasks to the post-013 modules-only shape and business_hours to the post-014 weekly shape", () => {
    const stripped = stripComments(schemaSql);
    expect(stripped).toMatch(/allowed_tasks\s+jsonb\s+DEFAULT\s+'\["book_appointment"\]'/i);
    expect(stripped).not.toMatch(/allowed_tasks[^\n]*general_question/i);
    expect(stripped).toMatch(/business_hours\s+jsonb\s+DEFAULT\s+'\{"mon":/i);
    expect(stripped).not.toMatch(/business_hours[^\n]*open_time/i);
  });
});
