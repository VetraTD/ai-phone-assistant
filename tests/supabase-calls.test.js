import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal fake `calls` row + a mock query builder that actually honors
// Postgres UPDATE ... WHERE semantics (unconditional vs. .neq()-guarded) —
// good enough to prove the *shape* of the atomicity fix (single filtered
// UPDATE, not a separate SELECT-then-UPDATE) actually prevents the clobber
// race, without spinning up a real DB. See services/supabase.js's
// completeCall()/markCallTransferred() for what's under test.
let fakeRow;
/** @type {{message: string} | null} */
let forcedError = null;

function makeEqResult(payload) {
  return {
    // Awaited directly (no .neq() chained) -> unconditional apply.
    // Used by: markCallTransferred's status update, and completeCall's
    // timing (ended_at/duration_seconds) update.
    then: (resolve) => {
      if (forcedError) return resolve({ error: forcedError });
      Object.assign(fakeRow, payload);
      resolve({ error: null });
    },
    // .neq() chained -> apply only if the current row's column differs
    // from the guard value (mirrors a real UPDATE ... WHERE col <> val
    // matching zero rows and no-op'ing, rather than erroring).
    // Used by: completeCall's status update.
    neq: (col, val) => ({
      then: (resolve) => {
        if (forcedError) return resolve({ error: forcedError });
        if (fakeRow[col] !== val) {
          Object.assign(fakeRow, payload);
        }
        resolve({ error: null });
      },
    }),
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      update: (payload) => ({
        eq: (_col, _val) => makeEqResult(payload),
      }),
    }),
  })),
}));

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "test-key";
  fakeRow = { status: "in-progress" };
  forcedError = null;
});

describe("markCallTransferred", () => {
  it("updates status to transferred for the given callSid", async () => {
    const { markCallTransferred } = await import("../services/supabase.js");

    await markCallTransferred("CA123");

    expect(fakeRow.status).toBe("transferred");
  });

  it("logs but does not throw on DB error", async () => {
    forcedError = { message: "boom" };
    const { markCallTransferred } = await import("../services/supabase.js");

    await expect(markCallTransferred("CA123")).resolves.toBeUndefined();
  });
});

describe("completeCall — atomic status update (no read-then-write race)", () => {
  it("always writes ended_at/duration_seconds regardless of status", async () => {
    const { completeCall } = await import("../services/supabase.js");

    await completeCall("CA123", "completed", 42);

    expect(fakeRow.ended_at).toBeDefined();
    expect(fakeRow.duration_seconds).toBe(42);
    expect(fakeRow.status).toBe("completed");
  });

  it("does not write duration_seconds when not provided", async () => {
    const { completeCall } = await import("../services/supabase.js");

    await completeCall("CA123", "failed", null);

    expect(fakeRow.ended_at).toBeDefined();
    expect(fakeRow.duration_seconds).toBeUndefined();
  });

  describe("both orderings vs. markCallTransferred", () => {
    it("transfer THEN completeCall: the neq('status','transferred') guard prevents the clobber", async () => {
      const { completeCall, markCallTransferred } = await import("../services/supabase.js");

      await markCallTransferred("CA123");
      expect(fakeRow.status).toBe("transferred");

      // The Twilio "completed" status callback for the same (now-redialed)
      // call leg lands after the transfer — must NOT overwrite it back to
      // 'completed'. Timing fields still get written either way.
      await completeCall("CA123", "completed", 42);

      expect(fakeRow.status).toBe("transferred");
      expect(fakeRow.ended_at).toBeDefined();
      expect(fakeRow.duration_seconds).toBe(42);
    });

    it("completeCall THEN transfer: status ends up transferred (markCallTransferred has no reason to guard — a transfer landing after is a real, later event)", async () => {
      const { completeCall, markCallTransferred } = await import("../services/supabase.js");

      await completeCall("CA123", "completed", 10);
      expect(fakeRow.status).toBe("completed");

      await markCallTransferred("CA123");

      expect(fakeRow.status).toBe("transferred");
    });
  });

  it("sets status normally when the call was never transferred", async () => {
    const { completeCall } = await import("../services/supabase.js");

    await completeCall("CA123", "completed", 10);

    expect(fakeRow.status).toBe("completed");
  });

  it("logs but does not throw when a DB error occurs", async () => {
    forcedError = { message: "boom" };
    const { completeCall } = await import("../services/supabase.js");

    await expect(completeCall("CA123", "completed", 10)).resolves.toBeUndefined();
  });
});
