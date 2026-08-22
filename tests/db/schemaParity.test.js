import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

// ---------------------------------------------------------------------------
// database/schema.sql is the FRESH-INSTALL path. Nothing runs the numbered
// migrations after it — `npm run db:reset` applies it and then records every
// migration as already applied, and `scripts/migrate.js --init-if-empty` does
// the same on an empty Cloud SQL instance. So a migration that is not folded
// back into schema.sql does not fail: it produces a database that is silently a
// version behind, on the one path that matters most (D3, the restore).
//
// tests/schema.test.js already derives tables, columns and indexes from the
// migration files by reading them as TEXT. That catches a new table. It cannot
// catch a CHANGED FUNCTION BODY, which is exactly what migrations 032, 033 and
// 034 are — each one replaces a bootstrap function whose old body returns zero
// rows under FORCE row-level security. A fresh install carrying the old body
// would authenticate nobody, and every text-level check would still be green.
//
// So this compares two real databases instead of two strings: a scratch one
// built from schema.sql alone, against the developer's migrated one. Postgres
// normalises both, so formatting differences cannot cause a false failure and
// a semantic difference cannot hide behind one.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const SCHEMA_SQL = path.resolve(fileURLToPath(new URL("../../database/schema.sql", import.meta.url)));
const SCRATCH_DB = "vetra_schema_parity_probe";

// Objects that exist only because of HOW a database was built, not what it is.
const IGNORED_TABLES = new Set(["schema_migrations"]);

let migrated;
let fresh;

/** Connect to a sibling database on the same server as DATABASE_URL. */
function siblingUrl(database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function objects(client) {
  const tables = await client.query(`
    SELECT c.relname AS name, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY 1`);

  const columns = await client.query(`
    SELECT table_name || '.' || column_name || ' ' || data_type ||
           CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END AS sig
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY 1`);

  // pg_get_functiondef renders the function as Postgres itself understands it,
  // so whitespace and comment differences are gone and a changed body is not.
  const functions = await client.query(`
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY 1, 2`);

  const triggers = await client.query(`
    SELECT c.relname || '.' || t.tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY 1`);

  const policies = await client.query(`
    SELECT tablename || '.' || policyname AS name,
           coalesce(qual, '') || ' | ' || coalesce(with_check, '') AS def
      FROM pg_policies WHERE schemaname = 'public'
     ORDER BY 1`);

  const grants = await client.query(`
    SELECT table_name || ' ' || privilege_type AS sig
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = 'vetra_app'
     ORDER BY 1`);

  const keep = (n) => !IGNORED_TABLES.has(n.split(/[. ]/)[0]);

  return {
    tables: tables.rows.filter((r) => keep(r.name)),
    columns: columns.rows.map((r) => r.sig).filter(keep),
    functions: new Map(functions.rows.map((r) => [r.name, r.def])),
    triggers: new Map(triggers.rows.filter((r) => keep(r.name)).map((r) => [r.name, r.def])),
    policies: new Map(policies.rows.filter((r) => keep(r.name)).map((r) => [r.name, r.def])),
    grants: grants.rows.map((r) => r.sig).filter(keep),
  };
}

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  // Terminate first: a previous crashed run can leave a connection holding the
  // scratch database open, and DROP DATABASE then fails for a reason that has
  // nothing to do with the schema.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SCRATCH_DB]
  ).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  fresh = new pg.Client({ connectionString: siblingUrl(SCRATCH_DB) });
  await fresh.connect();
  // Run as one statement, exactly as --init-if-empty does. If schema.sql cannot
  // apply to an empty database on its own, that is the first thing to know.
  await fresh.query(fs.readFileSync(SCHEMA_SQL, "utf8"));

  migrated = new pg.Client({ connectionString: url });
  await migrated.connect();
});

afterAll(async () => {
  if (!url) return;
  await fresh?.end().catch(() => {});
  await migrated?.end().catch(() => {});
  const admin = new pg.Client({ connectionString: url });
  await admin.connect().catch(() => {});
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SCRATCH_DB]
  ).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`).catch(() => {});
  await admin.end().catch(() => {});
});

describeDb("schema.sql produces the same database the migrations do", () => {
  let a; // fresh install
  let b; // migrated

  beforeAll(async () => {
    if (!url) return;
    a = await objects(fresh);
    b = await objects(migrated);
  });

  it("applies to an empty database on its own", () => {
    // Proven by beforeAll not throwing. Named so the evidence is visible in the
    // report rather than implied by the other tests happening to run.
    expect(a.tables.length).toBeGreaterThan(0);
  });

  it("has the same tables, with the same row-level security flags", () => {
    expect(a.tables).toEqual(b.tables);
  });

  it("has the same columns", () => {
    expect(a.columns).toEqual(b.columns);
  });

  it("has the same functions, BODY INCLUDED", () => {
    // The assertion migrations 032, 033 and 034 need. A fresh install carrying
    // 029's `app_lookup_user_by_email` authenticates nobody, and no text-level
    // check of schema.sql notices.
    expect([...a.functions.keys()]).toEqual([...b.functions.keys()]);
    for (const [name, def] of b.functions) {
      expect(a.functions.get(name), `function ${name} differs`).toBe(def);
    }
  });

  it("has the same triggers", () => {
    expect([...a.triggers.keys()]).toEqual([...b.triggers.keys()]);
    for (const [name, def] of b.triggers) {
      expect(a.triggers.get(name), `trigger ${name} differs`).toBe(def);
    }
  });

  it("has the same row-level security policies", () => {
    expect([...a.policies.keys()]).toEqual([...b.policies.keys()]);
    for (const [name, def] of b.policies) {
      expect(a.policies.get(name), `policy ${name} differs`).toBe(def);
    }
  });

  it("grants vetra_app the same table privileges", () => {
    expect(a.grants).toEqual(b.grants);
  });
});
