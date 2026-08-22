import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pg, resetPg, sql, params, setDbEnv, restoreDbEnv } from "./helpers/pgMock.js";

// ---------------------------------------------------------------------------
// addTranscriptEntry's DB-error path.
//
// Regression guard for the bug where the error branch logged a `callSid`
// identifier that is neither a parameter of addTranscriptEntry nor a
// module-level binding. Under ESM (always strict mode) that is a
// ReferenceError, which *replaced* the real DB error and then got swallowed
// by the `.catch()` wrappers at every call site (lib/voice/session.js and
// lib/mediaStream.js) — so a transcript that failed to persist looked
// identical to one that succeeded, and the real Postgres message was lost.
//
// Ported from supabase-transcripts.test.js: the insert payload is now the
// bound parameter list rather than a PostgREST object.
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

describe("addTranscriptEntry", () => {
  it("inserts the transcript row and logs nothing on success", async () => {
    const { addTranscriptEntry } = await import("../services/db.js");

    await addTranscriptEntry("call-uuid-1", "caller", "hello there", 4);

    expect(sql()).toContain("INSERT INTO call_transcripts (call_id, speaker, message, sequence)");
    expect(params()).toEqual(["call-uuid-1", "caller", "hello there", 4]);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("logs the REAL database error (not a ReferenceError) and does not throw", async () => {
    pg.respond = () => new Error('null value in column "message" violates not-null constraint');
    const { addTranscriptEntry } = await import("../services/db.js");

    await expect(
      addTranscriptEntry("call-uuid-1", "ai", "reply text", 5)
    ).resolves.toBeUndefined();

    expect(mockLogError).toHaveBeenCalledTimes(1);
    const [event, fields] = mockLogError.mock.calls[0];
    expect(event).toBe("db_error");
    // The real Postgres message must survive to the log line.
    expect(fields.error).toBe('null value in column "message" violates not-null constraint');
    expect(fields.operation).toBe("addTranscriptEntry");
    // Identified by the DB call UUID — the only identifier actually in scope.
    expect(fields.callId).toBe("call-uuid-1");
    expect(fields).not.toHaveProperty("callSid");
  });
});

describe("fetchCallTranscript", () => {
  it("orders by sequence, so a replay is in the order it was spoken", async () => {
    pg.respond = () => ({ rows: [{ speaker: "caller", message: "hi", sequence: 1 }] });
    const { fetchCallTranscript } = await import("../services/db.js");

    await expect(fetchCallTranscript("call-uuid-1")).resolves.toEqual([
      { speaker: "caller", message: "hi", sequence: 1 },
    ]);
    expect(sql()).toContain("ORDER BY sequence ASC");
  });

  it("returns [] on error, never null — every caller iterates the result", async () => {
    pg.respond = () => new Error("boom");
    const { fetchCallTranscript } = await import("../services/db.js");

    await expect(fetchCallTranscript("call-uuid-1")).resolves.toEqual([]);
  });
});
