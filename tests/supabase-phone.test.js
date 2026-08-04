import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEq = vi.fn();

// Query recorder for the select path. Each `from("businesses").select(...)`
// starts a new chain; the terminal call (maybeSingle / limit-then-await)
// resolves from the queued results.
let selectChains = [];
let selectResults = [];

function makeSelectChain(selectArg) {
  const chain = { select: selectArg, filters: [], limit: null };
  selectChains.push(chain);
  const q = {
    eq: (col, val) => {
      chain.filters.push(["eq", col, val]);
      return q;
    },
    like: (col, val) => {
      chain.filters.push(["like", col, val]);
      return q;
    },
    limit: (n) => {
      chain.limit = n;
      // `.like(...).limit(n)` is awaited directly (no maybeSingle), so the
      // chain itself has to be thenable.
      const result = () => selectResults.shift() ?? { data: null, error: null };
      return {
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
      };
    },
  };
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      update: (data) => ({
        eq: (col, id) => mockEq(col, id, data),
      }),
      select: (arg) => makeSelectChain(arg),
    }),
  })),
}));

async function importDb() {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "test-key";
  return import("../services/supabase.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  selectChains = [];
  selectResults = [];
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "test-key";
});

describe("updateBusinessPhoneNumber", () => {
  it("returns true when update succeeds", async () => {
    mockEq.mockResolvedValue({ error: null });
    const { updateBusinessPhoneNumber } = await importDb();

    const result = await updateBusinessPhoneNumber("business-uuid-123", "+15551234567");

    expect(result).toBe(true);
    expect(mockEq).toHaveBeenCalledWith("id", "business-uuid-123", {
      phone_number: "+15551234567",
    });
  });

  it("returns false when update returns error", async () => {
    mockEq.mockResolvedValue({ error: { message: "DB error" } });
    const { updateBusinessPhoneNumber } = await importDb();

    const result = await updateBusinessPhoneNumber("business-uuid-123", "+15551234567");

    expect(result).toBe(false);
  });

  it("returns false when businessId is missing", async () => {
    mockEq.mockResolvedValue({ error: null });
    const { updateBusinessPhoneNumber } = await importDb();

    const result = await updateBusinessPhoneNumber("", "+15551234567");

    expect(result).toBe(false);
    expect(mockEq).not.toHaveBeenCalled();
  });
});

describe("lookupBusinessByPhone", () => {
  it("matches on the first exact query and issues no recovery query", async () => {
    selectResults = [{ data: { id: "biz-1", phone_number: "+442079460958" }, error: null }];
    const { lookupBusinessByPhone } = await importDb();

    const biz = await lookupBusinessByPhone("+442079460958");

    expect(biz).toEqual({ id: "biz-1", phone_number: "+442079460958" });
    expect(selectChains).toHaveLength(1);
    expect(selectChains[0].filters).toEqual([["eq", "phone_number", "+442079460958"]]);
  });

  it("normalizes a damaged incoming value before querying", async () => {
    selectResults = [{ data: { id: "biz-1" }, error: null }];
    const { lookupBusinessByPhone } = await importDb();

    await lookupBusinessByPhone("  +44 20 7946 0958\n");

    expect(selectChains[0].filters).toEqual([["eq", "phone_number", "+442079460958"]]);
  });

  // THE PRODUCTION BUG: Twilio sends a clean "+442079460958" but the row was
  // stored as "\n+442079460958" by a paste into the Supabase table editor, so
  // the equality match finds nothing and the call falls through to the
  // "our office" default config. Migration 024 fixes the data; this is the
  // safety net for a database where it has not run yet.
  it("recovers a business whose stored number carries paste damage", async () => {
    selectResults = [
      { data: null, error: null }, // exact match misses — the damaged row is invisible
      { data: [{ id: "biz-uk", phone_number: "\n+442079460958" }], error: null },
    ];
    const { lookupBusinessByPhone } = await importDb();

    const biz = await lookupBusinessByPhone("+442079460958");

    expect(biz).toEqual({ id: "biz-uk", phone_number: "\n+442079460958" });
    expect(selectChains).toHaveLength(2);
    expect(selectChains[1].filters[0][0]).toBe("like");
    expect(selectChains[1].filters[0][1]).toBe("phone_number");
  });

  it("recovers a row damaged by interior spaces, which a substring match would miss", async () => {
    selectResults = [
      { data: null, error: null },
      { data: [{ id: "biz-uk", phone_number: "+44 20 7946 0958" }], error: null },
    ];
    const { lookupBusinessByPhone } = await importDb();

    const biz = await lookupBusinessByPhone("+442079460958");
    expect(biz?.id).toBe("biz-uk");
  });

  // The LIKE pattern only narrows candidates; the match is confirmed in JS, so
  // a longer number containing the same digits in order is never returned.
  it("rejects a candidate that is not the same number after normalization", async () => {
    selectResults = [
      { data: null, error: null },
      { data: [{ id: "biz-other", phone_number: "+4420794609581" }], error: null },
    ];
    const { lookupBusinessByPhone } = await importDb();

    expect(await lookupBusinessByPhone("+442079460958")).toBeNull();
  });

  it("returns null rather than guessing when two damaged rows both match", async () => {
    selectResults = [
      { data: null, error: null },
      {
        data: [
          { id: "biz-a", phone_number: "\n+442079460958" },
          { id: "biz-b", phone_number: "+44 20 7946 0958" },
        ],
        error: null,
      },
    ];
    const { lookupBusinessByPhone } = await importDb();

    expect(await lookupBusinessByPhone("+442079460958")).toBeNull();
  });

  it("skips recovery entirely when the dialed number is not valid E.164", async () => {
    selectResults = [{ data: null, error: null }];
    const { lookupBusinessByPhone } = await importDb();

    expect(await lookupBusinessByPhone("not-a-number")).toBeNull();
    expect(selectChains).toHaveLength(1);
  });

  it("returns null for empty input without querying", async () => {
    const { lookupBusinessByPhone } = await importDb();

    expect(await lookupBusinessByPhone("")).toBeNull();
    expect(selectChains).toHaveLength(0);
  });
});
