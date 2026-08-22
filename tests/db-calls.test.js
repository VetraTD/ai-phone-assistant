import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pg, resetPg, allSql, params, setDbEnv, restoreDbEnv } from "./helpers/pgMock.js";

// ---------------------------------------------------------------------------
// completeCall / markCallTransferred — the SHAPE of the statements.
//
// The predecessor of this file (supabase-calls.test.js) simulated Postgres
// UPDATE semantics inside its own mock so it could prove that the guarded
// status update prevents a transfer being clobbered. That proved something
// about the mock. Whether Postgres actually behaves that way is now asserted
// against a real PostgreSQL in tests/db/callStatusRace.test.js.
//
// What stays here is what a mock CAN answer honestly: how many statements are
// issued, that the guard predicate is present, which columns are written, and
// that the error paths log rather than throw.
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
  mockLogError.mockClear();
});

afterEach(() => {
  restoreDbEnv();
});

describe("markCallTransferred", () => {
  it("issues one unconditional update keyed by the call sid", async () => {
    const { markCallTransferred } = await import("../services/db.js");

    await markCallTransferred("CA123");

    expect(allSql()).toEqual([
      "UPDATE calls SET status = 'transferred' WHERE twilio_call_sid = $1",
    ]);
    expect(params()).toEqual(["CA123"]);
  });

  it("logs but does not throw on DB error", async () => {
    pg.respond = () => new Error("boom");
    const { markCallTransferred } = await import("../services/db.js");

    await expect(markCallTransferred("CA123")).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe("completeCall — atomic status update (no read-then-write race)", () => {
  it("writes timing and status as two statements, and never reads first", async () => {
    const { completeCall } = await import("../services/db.js");

    await completeCall("CA123", "completed", 42);

    const stmts = allSql();
    expect(stmts).toHaveLength(2);
    // The absence of a SELECT is the point. A read-then-write had a window in
    // which a markCallTransferred() could land and then be clobbered.
    expect(stmts.some((s) => s.startsWith("SELECT"))).toBe(false);
    expect(stmts[0]).toContain("SET ended_at = now(), duration_seconds = $2");
    expect(stmts[1]).toContain("status IS DISTINCT FROM 'transferred'");
  });

  it("always writes ended_at/duration_seconds regardless of status", async () => {
    const { completeCall } = await import("../services/db.js");

    await completeCall("CA123", "completed", 42);

    expect(params(0)).toEqual(["CA123", 42]);
  });

  it("does not write duration_seconds when not provided", async () => {
    const { completeCall } = await import("../services/db.js");

    await completeCall("CA123", "failed", null);

    expect(allSql()[0]).toBe("UPDATE calls SET ended_at = now() WHERE twilio_call_sid = $1");
    expect(params(0)).toEqual(["CA123"]);
  });

  // `IS DISTINCT FROM`, not `<>`. The two are equivalent while `calls.status`
  // is NOT NULL — see tests/db/callStatusRace.test.js, which pins that
  // constraint — and stop being equivalent if it is ever dropped.
  it("guards with IS DISTINCT FROM rather than <>", async () => {
    const { completeCall } = await import("../services/db.js");

    await completeCall("CA123", "completed", 10);

    expect(allSql()[1]).not.toMatch(/status\s*<>/);
    expect(allSql()[1]).toContain("IS DISTINCT FROM");
  });

  it("logs but does not throw when a DB error occurs", async () => {
    pg.respond = () => new Error("boom");
    const { completeCall } = await import("../services/db.js");

    await expect(completeCall("CA123", "completed", 10)).resolves.toBeUndefined();
    // Both statements fail independently; neither takes the process with it.
    expect(mockLogError).toHaveBeenCalledTimes(2);
  });
});

describe("createCall", () => {
  it("returns the new id", async () => {
    pg.respond = () => ({ rows: [{ id: "call-uuid-1" }] });
    const { createCall } = await import("../services/db.js");

    await expect(createCall("biz-1", "CA123", "+15551110000", "+15552220000")).resolves.toBe("call-uuid-1");
    expect(params()).toEqual(["biz-1", "CA123", "+15551110000", "+15552220000"]);
  });

  it("returns null on error rather than throwing — a failed insert must not drop the call", async () => {
    pg.respond = () => new Error("boom");
    const { createCall } = await import("../services/db.js");

    await expect(createCall("biz-1", "CA123", "+1", "+2")).resolves.toBeNull();
  });
});
