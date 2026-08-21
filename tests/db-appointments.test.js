import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pg, resetPg, sql, params, setDbEnv, restoreDbEnv } from "./helpers/pgMock.js";

// ---------------------------------------------------------------------------
// Tenant scoping on the three appointment functions that mutate/read a single
// row by id. They used to apply the business filter only `if (businessId)` —
// and services/tools.js passed `ctx?.businessId || null`, so after a
// "no_business_found" call the queries ran UNSCOPED across every tenant: an
// appointment UUID from any business could be read or cancelled.
//
// The filter is now unconditional and businessId is required; a missing one
// fails closed (no query is issued at all).
//
// Ported from supabase-appointments.test.js. The old version asserted the
// PostgREST builder recorded `.eq("business_id", ...)`; this asserts the SQL
// carries the predicate and the parameter. Same question, current vocabulary.
// ---------------------------------------------------------------------------

vi.mock("pg", async () => (await import("./helpers/pgMock.js")).pgModuleMock());

const mockLogError = vi.fn();
vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: (...args) => mockLogError(...args) },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  resetPg();
  setDbEnv();
  pg.respond = () => ({ rows: [{ id: "appt-1" }] });
  mockLogError.mockClear();
});

afterEach(() => {
  restoreDbEnv();
});

describe("getAppointmentById", () => {
  it("always filters on business_id", async () => {
    const { getAppointmentById } = await import("../services/db.js");

    await getAppointmentById("appt-1", "biz-1");

    expect(sql()).toContain("WHERE id = $1 AND business_id = $2");
    expect(params()).toEqual(["appt-1", "biz-1"]);
  });

  it("issues no query at all when businessId is missing (fails closed, never unscoped)", async () => {
    const { getAppointmentById } = await import("../services/db.js");

    await expect(getAppointmentById("appt-1", null)).resolves.toBeNull();

    expect(pg.queries).toEqual([]);
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe("updateAppointmentStatus", () => {
  it("always filters on business_id", async () => {
    const { updateAppointmentStatus } = await import("../services/db.js");

    await updateAppointmentStatus("appt-1", "cancelled", "biz-1");

    expect(sql()).toContain("WHERE id = $1 AND business_id = $2");
    expect(params()).toEqual(["appt-1", "biz-1", "cancelled"]);
  });

  it("refuses to run unscoped when businessId is missing", async () => {
    const { updateAppointmentStatus } = await import("../services/db.js");

    await expect(updateAppointmentStatus("appt-1", "cancelled", undefined)).resolves.toBe(false);

    expect(pg.queries).toEqual([]);
    expect(mockLogError).toHaveBeenCalled();
  });

  it("reports false when the row was not there to update", async () => {
    // RETURNING id gives back nothing when the WHERE matched no row — which is
    // exactly what a cross-tenant id looks like. `false`, not a throw.
    pg.respond = () => ({ rows: [] });
    const { updateAppointmentStatus } = await import("../services/db.js");

    await expect(updateAppointmentStatus("appt-1", "cancelled", "biz-1")).resolves.toBe(false);
  });
});

describe("updateAppointment", () => {
  it("always filters on business_id", async () => {
    const { updateAppointment } = await import("../services/db.js");

    await updateAppointment("appt-1", { scheduled_at: "2026-08-02T10:00:00Z" }, "biz-1");

    expect(sql()).toContain("WHERE id = $1 AND business_id = $2");
    expect(params()).toEqual(["appt-1", "biz-1", "2026-08-02T10:00:00Z"]);
  });

  it("refuses to run unscoped when businessId is missing", async () => {
    const { updateAppointment } = await import("../services/db.js");

    await expect(
      updateAppointment("appt-1", { scheduled_at: "2026-08-02T10:00:00Z" }, "")
    ).resolves.toBe(false);

    expect(pg.queries).toEqual([]);
    expect(mockLogError).toHaveBeenCalled();
  });

  // New with the rewrite, and the reason it exists: a column name cannot be a
  // bound parameter, so `updates` is the one caller-supplied thing that reaches
  // the SQL text. An allowlist is what stops that being an injection point.
  it("drops a column that is not on the allowlist, and says so", async () => {
    const { updateAppointment } = await import("../services/db.js");

    await updateAppointment("appt-1", { "status = 'x'; DROP TABLE calls; --": 1 }, "biz-1");

    expect(pg.queries).toEqual([]);
    expect(mockLogError).toHaveBeenCalledWith(
      "db_update_column_refused",
      expect.objectContaining({ operation: "updateAppointment" })
    );
  });

  it("keeps the allowed columns when an unknown one is mixed in", async () => {
    const { updateAppointment } = await import("../services/db.js");

    await updateAppointment("appt-1", { scheduled_at: "2026-08-02T10:00:00Z", nonsense: 1 }, "biz-1");

    expect(sql()).toContain("SET scheduled_at = $3");
    expect(sql()).not.toContain("nonsense");
  });
});
