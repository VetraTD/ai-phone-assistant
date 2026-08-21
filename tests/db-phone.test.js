import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pg, resetPg, sql, params, allSql, setDbEnv, restoreDbEnv } from "./helpers/pgMock.js";

// Ported from supabase-phone.test.js. The old version asserted on recorded
// PostgREST filters (`["eq", "phone_number", ...]`); this asserts on the SQL
// predicate and the bound parameter. Every case, and every reason for it,
// carried across unchanged.

vi.mock("pg", async () => (await import("./helpers/pgMock.js")).pgModuleMock());

const mockLogError = vi.fn();
vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: (...args) => mockLogError(...args) },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

/** Queue one result per statement, in the order the statements run. */
function queue(...results) {
  let i = 0;
  pg.respond = () => {
    const r = results[i++] ?? { rows: [] };
    return r;
  };
}

beforeEach(() => {
  vi.resetModules();
  resetPg();
  setDbEnv();
  mockLogError.mockClear();
});

afterEach(() => {
  restoreDbEnv();
});

describe("updateBusinessPhoneNumber", () => {
  it("returns true when update succeeds", async () => {
    const { updateBusinessPhoneNumber } = await import("../services/db.js");

    const result = await updateBusinessPhoneNumber("business-uuid-123", "+15551234567");

    expect(result).toBe(true);
    expect(sql()).toBe("UPDATE businesses SET phone_number = $2 WHERE id = $1");
    expect(params()).toEqual(["business-uuid-123", "+15551234567"]);
  });

  it("returns false when update returns error", async () => {
    pg.respond = () => new Error("DB error");
    const { updateBusinessPhoneNumber } = await import("../services/db.js");

    await expect(updateBusinessPhoneNumber("business-uuid-123", "+15551234567")).resolves.toBe(false);
  });

  it("returns false when businessId is missing", async () => {
    const { updateBusinessPhoneNumber } = await import("../services/db.js");

    await expect(updateBusinessPhoneNumber("", "+15551234567")).resolves.toBe(false);
    expect(pg.queries).toEqual([]);
  });

  it("refuses a number that is not E.164 rather than storing it", async () => {
    const { updateBusinessPhoneNumber } = await import("../services/db.js");

    await expect(updateBusinessPhoneNumber("business-uuid-123", "not-a-number")).resolves.toBe(false);
    expect(pg.queries).toEqual([]);
    expect(mockLogError).toHaveBeenCalledWith("business_phone_rejected", expect.anything());
  });
});

describe("lookupBusinessByPhone", () => {
  it("matches on the first exact query and issues no recovery query", async () => {
    queue({ rows: [{ id: "biz-1", phone_number: "+442079460958" }] });
    const { lookupBusinessByPhone } = await import("../services/db.js");

    const biz = await lookupBusinessByPhone("+442079460958");

    expect(biz).toMatchObject({ id: "biz-1", phone_number: "+442079460958" });
    expect(pg.queries).toHaveLength(1);
    // Through app_lookup_business_by_phone (migration 029), not a direct
    // select: this read happens BEFORE a tenant is known — it is how the tenant
    // becomes known — so under row-level security a plain select returns
    // nothing and the call cannot be answered.
    expect(sql()).toContain("app_lookup_business_by_phone($1)");
    expect(params()).toEqual(["+442079460958"]);
  });

  // The PostgREST embed `.select("*, business_capabilities(*)")` became a
  // correlated subquery. Capability rows still arrive on the SAME round trip,
  // because they decide which tools exist before turn one and the pickup path
  // is latency-critical.
  it("fetches capability rows in the same statement", async () => {
    queue({ rows: [{ id: "biz-1", business_capabilities: [] }] });
    const { lookupBusinessByPhone } = await import("../services/db.js");

    await lookupBusinessByPhone("+442079460958");

    // ONE round trip, still. Capability rows decide which tools exist before
    // turn one, and this is the latency-critical pickup path — a second query
    // here is a regression even though it would be simpler to write.
    //
    // Both halves go through bootstrap functions because both tables are
    // RLS-protected and no tenant is set yet. `b.*` rather than a JSON blob so
    // column types survive: a date arriving as a string would be a silent
    // behaviour change downstream.
    expect(pg.queries).toHaveLength(1);
    expect(sql()).toContain("app_business_capabilities(b.id)");
    expect(sql()).toContain("app_lookup_business_by_phone($1)");
    expect(sql()).toContain("b.*");
  });

  // An un-migrated database has no business_capabilities table, and the
  // subquery makes the whole statement fail rather than returning the business
  // without it. Falling back keeps calls answerable during a partial deploy.
  it("falls back to a plain select when the capability subquery fails", async () => {
    let n = 0;
    pg.respond = () => {
      n += 1;
      if (n === 1) return new Error('relation "business_capabilities" does not exist');
      return { rows: [{ id: "biz-1", phone_number: "+442079460958" }] };
    };
    const { lookupBusinessByPhone } = await import("../services/db.js");

    const biz = await lookupBusinessByPhone("+442079460958");

    expect(biz).toMatchObject({ id: "biz-1" });
    expect(allSql()[1]).toBe("SELECT * FROM app_lookup_business_by_phone($1)");
  });

  it("normalizes a damaged incoming value before querying", async () => {
    queue({ rows: [{ id: "biz-1" }] });
    const { lookupBusinessByPhone } = await import("../services/db.js");

    await lookupBusinessByPhone("  +44 20 7946 0958\n");

    expect(params()).toEqual(["+442079460958"]);
  });

  // THE PRODUCTION BUG: Twilio sends a clean "+442079460958" but the row was
  // stored as "\n+442079460958" by a paste into the Supabase table editor, so
  // the equality match finds nothing and the call falls through to the
  // "our office" default config. Migration 024 fixes the data; this is the
  // safety net for a database where it has not run yet.
  it("recovers a business whose stored number carries paste damage", async () => {
    queue(
      { rows: [] }, // exact match misses — the damaged row is invisible
      { rows: [{ id: "biz-uk", phone_number: "\n+442079460958" }] }
    );
    const { lookupBusinessByPhone } = await import("../services/db.js");

    const biz = await lookupBusinessByPhone("+442079460958");

    expect(biz).toMatchObject({ id: "biz-uk" });
    expect(pg.queries).toHaveLength(2);
    expect(allSql()[1]).toContain("phone_number LIKE $1");
  });

  it("recovers a row damaged by interior spaces, which a substring match would miss", async () => {
    queue({ rows: [] }, { rows: [{ id: "biz-uk", phone_number: "+44 20 7946 0958" }] });
    const { lookupBusinessByPhone } = await import("../services/db.js");

    const biz = await lookupBusinessByPhone("+442079460958");
    expect(biz?.id).toBe("biz-uk");
  });

  // The LIKE pattern only narrows candidates; the match is confirmed in JS, so
  // a longer number containing the same digits in order is never returned.
  it("rejects a candidate that is not the same number after normalization", async () => {
    queue({ rows: [] }, { rows: [{ id: "biz-other", phone_number: "+4420794609581" }] });
    const { lookupBusinessByPhone } = await import("../services/db.js");

    expect(await lookupBusinessByPhone("+442079460958")).toBeNull();
  });

  it("returns null rather than guessing when two damaged rows both match", async () => {
    queue(
      { rows: [] },
      {
        rows: [
          { id: "biz-a", phone_number: "\n+442079460958" },
          { id: "biz-b", phone_number: "+44 20 7946 0958" },
        ],
      }
    );
    const { lookupBusinessByPhone } = await import("../services/db.js");

    expect(await lookupBusinessByPhone("+442079460958")).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith("business_phone_ambiguous", expect.anything());
  });

  it("skips recovery entirely when the dialed number is not valid E.164", async () => {
    queue({ rows: [] });
    const { lookupBusinessByPhone } = await import("../services/db.js");

    expect(await lookupBusinessByPhone("not-a-number")).toBeNull();
    expect(pg.queries).toHaveLength(1);
  });

  it("returns null for empty input without querying", async () => {
    const { lookupBusinessByPhone } = await import("../services/db.js");

    expect(await lookupBusinessByPhone("")).toBeNull();
    expect(pg.queries).toHaveLength(0);
  });
});
