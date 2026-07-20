import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Tenant scoping on the three appointment functions that mutate/read a single
// row by id. They used to apply `.eq("business_id", ...)` only `if
// (businessId)` — and services/tools.js passed `ctx?.businessId || null`, so
// after a "no_business_found" call the queries ran UNSCOPED across every
// tenant: an appointment UUID from any business could be read or cancelled.
//
// The filter is now unconditional and businessId is required; a missing one
// fails closed (no query is issued at all).
// ---------------------------------------------------------------------------

/** Every .eq(col, val) applied to the current query, in order. */
let eqCalls = [];
let fromCalls = [];
let selectResult = { data: { id: "appt-1" }, error: null };

function makeQuery() {
  const q = {
    eq: (col, val) => {
      eqCalls.push([col, val]);
      return q;
    },
    select: () => q,
    maybeSingle: () => Promise.resolve(selectResult),
  };
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table) => {
      fromCalls.push(table);
      return {
        select: () => makeQuery(),
        update: () => makeQuery(),
      };
    },
  })),
}));

const mockLogError = vi.fn();
vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: (...args) => mockLogError(...args) },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "test-key";
  eqCalls = [];
  fromCalls = [];
  selectResult = { data: { id: "appt-1" }, error: null };
  mockLogError.mockClear();
});

describe("getAppointmentById", () => {
  it("always filters on business_id", async () => {
    const { getAppointmentById } = await import("../services/supabase.js");

    await getAppointmentById("appt-1", "biz-1");

    expect(eqCalls).toEqual([
      ["id", "appt-1"],
      ["business_id", "biz-1"],
    ]);
  });

  it("issues no query at all when businessId is missing (fails closed, never unscoped)", async () => {
    const { getAppointmentById } = await import("../services/supabase.js");

    await expect(getAppointmentById("appt-1", null)).resolves.toBeNull();

    expect(fromCalls).toEqual([]);
    expect(eqCalls).toEqual([]);
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe("updateAppointmentStatus", () => {
  it("always filters on business_id", async () => {
    const { updateAppointmentStatus } = await import("../services/supabase.js");

    await updateAppointmentStatus("appt-1", "cancelled", "biz-1");

    expect(eqCalls).toEqual([
      ["id", "appt-1"],
      ["business_id", "biz-1"],
    ]);
  });

  it("refuses to run unscoped when businessId is missing", async () => {
    const { updateAppointmentStatus } = await import("../services/supabase.js");

    await expect(updateAppointmentStatus("appt-1", "cancelled", undefined)).resolves.toBe(false);

    expect(fromCalls).toEqual([]);
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe("updateAppointment", () => {
  it("always filters on business_id", async () => {
    const { updateAppointment } = await import("../services/supabase.js");

    await updateAppointment("appt-1", { scheduled_at: "2026-08-02T10:00:00Z" }, "biz-1");

    expect(eqCalls).toEqual([
      ["id", "appt-1"],
      ["business_id", "biz-1"],
    ]);
  });

  it("refuses to run unscoped when businessId is missing", async () => {
    const { updateAppointment } = await import("../services/supabase.js");

    await expect(
      updateAppointment("appt-1", { scheduled_at: "2026-08-02T10:00:00Z" }, "")
    ).resolves.toBe(false);

    expect(fromCalls).toEqual([]);
    expect(mockLogError).toHaveBeenCalled();
  });
});
