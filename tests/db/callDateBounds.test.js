// tests/db/callDateBounds.test.js
/**
 * The Calls-list date bounds evaluated by real Postgres. Pure SELECT
 * expressions over literal timestamps: no tables, no migrations. Mocks cannot
 * evaluate SQL, and the bug was entirely in what `::date` means in a session
 * whose timezone is UTC.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import pg from "pg";

const require = createRequire(import.meta.url);
const { callDateClauses } = require("../../AI-phone-dashboard/backend/src/callDateBounds.js");

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let client;
beforeAll(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`SET TIME ZONE 'UTC'`); // what Cloud SQL runs
});
afterAll(async () => { await client?.end(); });

// Builds the helper's real clauses with `started_at` replaced by a literal.
async function inside(ts, { from, to, tz = "America/Chicago" }) {
  const params = [];
  const addParam = (v) => { params.push(v); return `$${params.length}`; };
  const clauses = callDateClauses({ from, to, tz, addParam });
  const expr = clauses.map((c) => c.replace(/started_at/g, `'${ts}'::timestamptz`)).join(" AND ");
  const r = await client.query(`SELECT (${expr}) AS ok`, params);
  return r.rows[0].ok;
}

describeDb("calls date bounds in the business timezone (real Postgres)", () => {
  const day = { from: "2026-10-15", to: "2026-10-15" };
  it("21:30 CDT Oct 15 (02:30Z Oct 16) is inside Oct 15", async () => {
    expect(await inside("2026-10-16T02:30:00Z", day)).toBe(true);
  });
  it("00:30 CDT Oct 15 (05:30Z) is inside", async () => {
    expect(await inside("2026-10-15T05:30:00Z", day)).toBe(true);
  });
  it("23:30 CDT Oct 14 (04:30Z Oct 15) is outside", async () => {
    expect(await inside("2026-10-15T04:30:00Z", day)).toBe(false);
  });
  it("00:30 CDT Oct 16 (05:30Z Oct 16) is outside", async () => {
    expect(await inside("2026-10-16T05:30:00Z", day)).toBe(false);
  });
  it("a London business: 23:30 BST Oct 15 (22:30Z) is inside, 00:30 BST Oct 16 is not", async () => {
    const d = { ...day, tz: "Europe/London" };
    expect(await inside("2026-10-15T22:30:00Z", d)).toBe(true);
    expect(await inside("2026-10-15T23:30:00Z", d)).toBe(false);
  });
});
