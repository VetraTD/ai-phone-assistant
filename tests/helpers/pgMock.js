import { vi } from "vitest";

// A stand-in for `pg` that records what SQL was issued and answers with
// whatever the test queues up.
//
// These tests replaced a set that mocked the PostgREST query builder and
// asserted on `.eq("business_id", ...)` calls. The question each one asks is
// unchanged — "is this query scoped to the tenant", "does the error path log
// the real message" — but the vocabulary the data layer speaks is now SQL, so
// the assertions are about SQL.
//
// What deliberately did NOT come across: the old mock for calls.js simulated
// Postgres UPDATE semantics in JavaScript, so that the transferred-status
// clobber guard could be exercised without a database. A fake that reimplements
// `UPDATE ... WHERE status <> 'transferred'` proves something about the fake.
// Those cases moved to tests/db/callStatusRace.test.js and run against a real
// PostgreSQL, which is the only thing that can answer them.

// The recorder lives on globalThis, not in this module's scope, and that is
// load-bearing rather than lazy. `vi.resetModules()` — which every one of these
// tests needs, because services/db.js builds its pool at import time — gives the
// vi.mock factory a FRESH copy of this file. A module-scoped object would leave
// the test asserting on one recorder while the mocked Pool wrote to another,
// and the symptom is every query silently going missing.
const KEY = Symbol.for("vetra.test.pgMock");
if (!globalThis[KEY]) {
  globalThis[KEY] = { queries: [], respond: () => ({ rows: [] }) };
}

/** @type {{ queries: Array<{text: string, params: Array<unknown>}>, respond: (text: string, params: Array<unknown>) => unknown }} */
export const pg = globalThis[KEY];

/**
 * Factory for `vi.mock("pg", ...)`.
 *
 * Usage, in the test file (vi.mock is hoisted, so the import has to be inside):
 *
 *   vi.mock("pg", async () => (await import("./helpers/pgMock.js")).pgModuleMock());
 */
export function pgModuleMock() {
  class Pool {
    constructor(config) {
      this.config = config;
    }
    async query(text, params = []) {
      pg.queries.push({ text, params });
      const r = pg.respond(text, params);
      if (r instanceof Error) throw r;
      const rows = r?.rows ?? [];
      return { rows, rowCount: r?.rowCount ?? rows.length };
    }
    on() {}
    async end() {}
  }
  return { default: { Pool }, Pool };
}

/** Reset between tests. Call in beforeEach, before importing the data layer. */
export function resetPg() {
  pg.queries.length = 0;
  pg.respond = () => ({ rows: [] });
}

/** The SQL of the nth query, whitespace-collapsed so assertions can read normally. */
export function sql(n = 0) {
  return (pg.queries[n]?.text ?? "").replace(/\s+/g, " ").trim();
}

/** Params of the nth query. */
export function params(n = 0) {
  return pg.queries[n]?.params ?? [];
}

/** Every query's collapsed SQL, for "which statements ran, in what order". */
export function allSql() {
  return pg.queries.map((_, i) => sql(i));
}

/**
 * The env a fresh import of services/db.js needs in order to build a pool.
 * Without DATABASE_URL the module is inert and every function returns its
 * not-configured value, which would make these tests pass vacuously.
 *
 * PAIR IT WITH restoreDbEnv() in afterEach. process.env is process-wide, so a
 * file that sets DATABASE_URL and walks away leaves every later test file
 * importing services/db.js against a pool pointed at a host that does not
 * exist — a failure that appears in somebody else's file and looks like their
 * bug.
 */
let previousDatabaseUrl;

export function setDbEnv() {
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
}

/** Put DATABASE_URL back exactly as it was, including absent. */
export function restoreDbEnv() {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
}
