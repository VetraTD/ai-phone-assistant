import { describe, it, expect, vi, beforeEach } from "vitest";

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
// ---------------------------------------------------------------------------

/** @type {{message: string} | null} */
let forcedError = null;
let insertPayload = null;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      insert: (payload) => {
        insertPayload = payload;
        return Promise.resolve({ error: forcedError });
      },
    }),
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
  forcedError = null;
  insertPayload = null;
  mockLogError.mockClear();
});

describe("addTranscriptEntry", () => {
  it("inserts the transcript row and logs nothing on success", async () => {
    const { addTranscriptEntry } = await import("../services/supabase.js");

    await addTranscriptEntry("call-uuid-1", "caller", "hello there", 4);

    expect(insertPayload).toEqual({
      call_id: "call-uuid-1",
      speaker: "caller",
      message: "hello there",
      sequence: 4,
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("logs the REAL database error (not a ReferenceError) and does not throw", async () => {
    forcedError = { message: 'null value in column "message" violates not-null constraint' };
    const { addTranscriptEntry } = await import("../services/supabase.js");

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
