import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// fetchCallerContext — the block that tells the receptionist a caller already
// has an appointment.
//
// It used to match appointments with `.eq("client_phone", callerNumber)` while
// the get_caller_appointments_from_db tool matched the last ten digits. Two
// rules for one question: the tool found the row, the prompt did not, and the
// assistant offered to book a caller a second appointment it had no idea they
// already had. Both paths now go through listAppointmentsByCaller.
// ---------------------------------------------------------------------------

/** Rows the mocked client returns, per table. */
let tables = { calls: [], appointments: [] };
/** Every table name `.from()` was called with. */
let fromCalls = [];

/**
 * A chainable, awaitable query stub. Real enough for the two shapes under test:
 * the calls query (eq/order/limit) and listAppointmentsByCaller (eq/order,
 * awaited directly). Filters are NOT simulated — these tests are about which
 * rows survive the JS-side matching, so the stub returns the table verbatim and
 * lets the function under test do the filtering it actually does.
 */
function makeQuery(table) {
  const rows = tables[table] || [];
  const q = {
    select: () => q,
    eq: () => q,
    gte: () => q,
    ilike: () => q,
    order: () => q,
    limit: () => q,
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table) => {
      fromCalls.push(table);
      return makeQuery(table);
    },
  })),
}));

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

const soon = (days = 3) => new Date(Date.now() + days * 86_400_000).toISOString();
const past = () => new Date(Date.now() - 3 * 86_400_000).toISOString();

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "test-key";
  tables = { calls: [], appointments: [] };
  fromCalls = [];
});

async function load() {
  return import("../services/supabase.js");
}

describe("fetchCallerContext", () => {
  it("finds an appointment stored in a human-typed format, not just exact E.164", () => {
    // The bug in one line. Migration 026 cannot fix every such row either — it
    // will not guess a country code — so the LOOKUP has to be the forgiving
    // part, and it has to be forgiving in the same way the tool is.
    return load().then(async ({ fetchCallerContext }) => {
      tables.appointments = [
        { id: "a1", client_name: "Jane", client_phone: "(555) 111-2222", scheduled_at: soon(), status: "scheduled", notes: null },
      ];

      const ctx = await fetchCallerContext("biz-1", "+15551112222");

      expect(ctx.upcomingAppointments).toHaveLength(1);
      expect(ctx.upcomingAppointments[0].id).toBe("a1");
    });
  });

  it("excludes an appointment that has already passed", async () => {
    const { fetchCallerContext } = await load();
    tables.appointments = [
      { id: "old", client_name: "Jane", client_phone: "+15551112222", scheduled_at: past(), status: "scheduled", notes: null },
    ];

    const ctx = await fetchCallerContext("biz-1", "+15551112222");
    expect(ctx.upcomingAppointments).toEqual([]);
  });

  it("ignores a row belonging to a different caller", async () => {
    const { fetchCallerContext } = await load();
    tables.appointments = [
      { id: "other", client_name: "Bob", client_phone: "+15559998888", scheduled_at: soon(), status: "scheduled", notes: null },
    ];

    const ctx = await fetchCallerContext("biz-1", "+15551112222");
    expect(ctx.upcomingAppointments).toEqual([]);
  });

  it("never returns client_phone — the result reaches the prompt and an HTTP response", async () => {
    const { fetchCallerContext } = await load();
    tables.appointments = [
      { id: "a1", client_name: "Jane", client_phone: "+15551112222", scheduled_at: soon(), status: "scheduled", notes: "x" },
    ];

    const ctx = await fetchCallerContext("biz-1", "+15551112222");
    expect(ctx.upcomingAppointments[0]).not.toHaveProperty("client_phone");
    expect(ctx.upcomingAppointments[0]).not.toHaveProperty("status");
    expect(Object.keys(ctx.upcomingAppointments[0]).sort()).toEqual([
      "client_name",
      "id",
      "notes",
      "scheduled_at",
    ]);
  });

  it("caps the list at five", async () => {
    const { fetchCallerContext } = await load();
    tables.appointments = Array.from({ length: 9 }, (_, i) => ({
      id: `a${i}`,
      client_name: "Jane",
      client_phone: "+15551112222",
      scheduled_at: soon(i + 1),
      status: "scheduled",
      notes: null,
    }));

    const ctx = await fetchCallerContext("biz-1", "+15551112222");
    expect(ctx.upcomingAppointments).toHaveLength(5);
  });

  it("returns the empty shape without querying when the caller number is missing", async () => {
    const { fetchCallerContext } = await load();

    const ctx = await fetchCallerContext("biz-1", null);

    expect(ctx).toEqual({ callCount: 0, lastCallSummary: null, upcomingAppointments: [] });
    expect(fromCalls).toEqual([]);
  });
});

describe("listAppointmentsByCaller — upcomingOnly", () => {
  it("keeps past appointments by default, so the tool's answer does not move", async () => {
    // "Your appointments" legitimately includes one earlier today; the caller
    // asking to cancel it must still be able to find it.
    const { listAppointmentsByCaller } = await load();
    tables.appointments = [
      { id: "old", client_name: "Jane", client_phone: "+15551112222", scheduled_at: past(), status: "scheduled", notes: null },
    ];

    const list = await listAppointmentsByCaller("biz-1", { clientPhone: "+15551112222" });
    expect(list).toHaveLength(1);
  });

  it("drops them when asked", async () => {
    const { listAppointmentsByCaller } = await load();
    tables.appointments = [
      { id: "old", client_name: "Jane", client_phone: "+15551112222", scheduled_at: past(), status: "scheduled", notes: null },
      { id: "new", client_name: "Jane", client_phone: "+15551112222", scheduled_at: soon(), status: "scheduled", notes: null },
    ];

    const list = await listAppointmentsByCaller("biz-1", {
      clientPhone: "+15551112222",
      upcomingOnly: true,
    });
    expect(list.map((r) => r.id)).toEqual(["new"]);
  });
});
