// tests/outboundMigrationsStatic.test.js
/**
 * Properties of the outbound migrations (042-044) that a database test CANNOT
 * see, so they are pinned by reading the SQL as text.
 *
 * F1 (Checkpoint 2a, owner-approved): 042 grants its nine tables to vetra_app
 * EXPLICITLY. Locally 029's ALTER DEFAULT PRIVILEGES already grants the same
 * four privileges, so a DB test is green with or without the statement -- and
 * whether those default privileges hold on Cloud SQL (they belong to whichever
 * role ran 029) is exactly what nobody has proven. 030:127 and 037:148 are the
 * precedent: grant what the application needs by name.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DB_DIR = path.resolve(fileURLToPath(new URL("../database", import.meta.url)));
const read = (f) => fs.readFileSync(path.join(DB_DIR, f), "utf8");

/** Strip `-- line comments`, so commentary never counts as a statement. */
const stripComments = (sql) => sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const OUTBOUND_TABLES = [
  "campaigns", "campaign_versions", "contacts", "consents", "suppressions",
  "outreach", "call_attempts", "webhook_endpoints", "outbox",
];

/** Every table named by a `GRANT SELECT, INSERT, UPDATE, DELETE ON <list> TO vetra_app;` in `sql`. */
function dmlGrantTables(sql) {
  const out = new Set();
  const re = /GRANT\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+(?:TABLE\s+)?([\s\S]*?)\s+TO\s+vetra_app\s*;/gi;
  for (const m of stripComments(sql).matchAll(re)) {
    for (const t of m[1].split(",")) out.add(t.trim().toLowerCase());
  }
  return out;
}

/** schema.sql's fold of migration 042: from its banner to 043's. */
function schemaFoldOf042() {
  const schema = read("schema.sql");
  const start = schema.indexOf("-- Migration 042: outbound calling -- the tables");
  const end = schema.indexOf("-- Migration 043: outbound calling -- FK constraints on calls");
  expect(start, "042 banner in schema.sql").toBeGreaterThan(-1);
  expect(end, "043 banner after it").toBeGreaterThan(start);
  return schema.slice(start, end);
}

describe("F1: 042 grants its nine tables to vetra_app explicitly", () => {
  const inFile = dmlGrantTables(read("042_outbound_core.sql"));
  const inFold = dmlGrantTables(schemaFoldOf042());

  it.each(OUTBOUND_TABLES)("042_outbound_core.sql grants %s", (t) => {
    expect(inFile.has(t)).toBe(true);
  });

  it.each(OUTBOUND_TABLES)("schema.sql's fold of 042 grants %s", (t) => {
    expect(inFold.has(t)).toBe(true);
  });
});
