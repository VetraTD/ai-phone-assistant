import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetReplyStreaming } = vi.hoisted(() => ({ mockGetReplyStreaming: vi.fn() }));

vi.mock("../services/gemini.js", () => ({
  getReplyStreaming: mockGetReplyStreaming,
}));

import { runLlmTurn } from "../lib/voice/llmTurn.js";

/** Wrap a plain array of chunk objects as an async generator, capturing the signal passed in. */
function fixedStream(chunks, onCall) {
  return (history, userText, step, intent, config, extras, opts) => {
    onCall?.(opts);
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  };
}

describe("llmTurn.js — runLlmTurn timeout/abort wrapper", () => {
  beforeEach(() => {
    mockGetReplyStreaming.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1. passes through deltas and the final done chunk, preserving extra fields", async () => {
    let capturedSignal = null;
    mockGetReplyStreaming.mockImplementation(
      fixedStream(
        [
          { delta: "Hello " },
          { delta: "world" },
          { done: true, reply: { text: "Hello world" }, toolResults: [] },
        ],
        (opts) => {
          capturedSignal = opts.signal;
        }
      )
    );

    const events = [];
    for await (const evt of runLlmTurn({
      history: [],
      userText: "hi",
      step: "gather_details",
      intent: "general_question",
      config: {},
      extras: {},
    })) {
      events.push(evt);
    }

    expect(events).toEqual([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "world" },
      { type: "done", done: true, reply: { text: "Hello world" }, toolResults: [] },
    ]);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal.aborted).toBe(false); // completed normally — never aborted
  });

  it("2. yields exactly one { type: 'slow' } when the first chunk is late, then resumes normal flow", async () => {
    vi.useFakeTimers();
    let releaseFirstChunk;
    const gate = new Promise((resolve) => {
      releaseFirstChunk = resolve;
    });
    mockGetReplyStreaming.mockImplementation(() =>
      (async function* () {
        await gate;
        yield { delta: "Hi" };
        yield { done: true, reply: { text: "Hi" } };
      })()
    );

    const gen = runLlmTurn({
      history: [],
      userText: "hi",
      step: "gather_details",
      intent: null,
      config: {},
      extras: {},
      firstChunkTimeoutMs: 100,
      totalTimeoutMs: 5000,
    });

    const p1 = gen.next();
    await vi.advanceTimersByTimeAsync(100); // fire the slow timer
    const r1 = await p1;
    expect(r1.value).toEqual({ type: "slow" });
    expect(r1.done).toBe(false);

    releaseFirstChunk();
    const r2 = await gen.next();
    expect(r2.value).toEqual({ type: "delta", text: "Hi" });

    const r3 = await gen.next();
    expect(r3.value).toEqual({ type: "done", done: true, reply: { text: "Hi" } });

    // Advance well past the slow threshold again — no second "slow" event should ever appear.
    await vi.advanceTimersByTimeAsync(10000);
    const r4 = await gen.next();
    expect(r4.done).toBe(true);
  });

  it("3. throws LLM_TIMEOUT and aborts the signal when the turn exceeds totalTimeoutMs", async () => {
    vi.useFakeTimers();
    let capturedSignal = null;
    mockGetReplyStreaming.mockImplementation((history, userText, step, intent, config, extras, opts) => {
      capturedSignal = opts.signal;
      return (async function* () {
        // Never yields on its own; only settles if the caller aborts it.
        await new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      })();
    });

    const gen = runLlmTurn({
      history: [],
      userText: "hi",
      step: "gather_details",
      intent: null,
      config: {},
      extras: {},
      firstChunkTimeoutMs: 10000,
      totalTimeoutMs: 200,
    });

    const p = gen.next();
    p.catch(() => {}); // attach a handler synchronously so advancing timers below can't trip an unhandled-rejection warning before the real assertion runs
    await vi.advanceTimersByTimeAsync(200);

    await expect(p).rejects.toMatchObject({ message: "LLM turn timeout", code: "LLM_TIMEOUT" });
    expect(capturedSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("4. aborts the signal and leaves no dangling timers when the consumer returns early (barge-in)", async () => {
    vi.useFakeTimers();
    let capturedSignal = null;
    mockGetReplyStreaming.mockImplementation(
      fixedStream([{ delta: "Hello" }, { delta: "World" }], (opts) => {
        capturedSignal = opts.signal;
      })
    );

    const gen = runLlmTurn({
      history: [],
      userText: "hi",
      step: "gather_details",
      intent: null,
      config: {},
      extras: {},
      firstChunkTimeoutMs: 2500,
      totalTimeoutMs: 8000,
    });

    const r1 = await gen.next();
    expect(r1.value).toEqual({ type: "delta", text: "Hello" });

    expect(vi.getTimerCount()).toBeGreaterThan(0); // slow + total timers still armed

    await gen.return();

    expect(capturedSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // no leaked timers
  });
});

describe("llmTurn.js — single pre-stream transient retry", () => {
  beforeEach(() => {
    mockGetReplyStreaming.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A retriable, network-ish/5xx error. */
  const transient = (msg = "503 Service Unavailable") =>
    Object.assign(new Error(msg), { status: 503 });

  /** Drive a runLlmTurn generator to completion, collecting its events. */
  async function drain(gen, sink = []) {
    for await (const evt of gen) sink.push(evt);
    return sink;
  }

  it("B1. transient error BEFORE the first chunk → recreates the iterator once → events flow", async () => {
    let calls = 0;
    mockGetReplyStreaming.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return (async function* () {
          throw transient();
        })();
      }
      return (async function* () {
        yield { delta: "Hi" };
        yield { done: true, reply: { text: "Hi" } };
      })();
    });

    const events = await drain(
      runLlmTurn({ history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {} })
    );

    expect(calls).toBe(2); // exactly one retry
    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      { type: "done", done: true, reply: { text: "Hi" }, retried: true },
    ]);
  });

  it("B2. transient error AFTER a delta was yielded → NO retry, error propagates", async () => {
    let calls = 0;
    mockGetReplyStreaming.mockImplementation(() => {
      calls++;
      return (async function* () {
        yield { delta: "Hi" };
        throw transient();
      })();
    });

    const events = [];
    await expect(
      drain(
        runLlmTurn({ history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {} }),
        events
      )
    ).rejects.toThrow("503");

    expect(calls).toBe(1); // never recreated after a chunk was consumed
    expect(events).toEqual([{ type: "delta", text: "Hi" }]);
  });

  it("B3. non-transient error (HTTP 400) before the first chunk → NO retry", async () => {
    let calls = 0;
    mockGetReplyStreaming.mockImplementation(() => {
      calls++;
      return (async function* () {
        throw Object.assign(new Error("400 Bad Request"), { status: 400 });
      })();
    });

    await expect(
      drain(runLlmTurn({ history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {} }))
    ).rejects.toThrow("400");
    expect(calls).toBe(1);
  });

  it("B4. transient error with <3s remaining in the total budget → NO retry", async () => {
    let calls = 0;
    mockGetReplyStreaming.mockImplementation(() => {
      calls++;
      return (async function* () {
        throw transient();
      })();
    });

    await expect(
      drain(
        runLlmTurn({
          history: [],
          userText: "hi",
          step: "gather_details",
          intent: null,
          config: {},
          extras: {},
          totalTimeoutMs: 2000, // <3000ms remaining from the very start
        })
      )
    ).rejects.toThrow("503");
    expect(calls).toBe(1);
  });

  it("B5. two transient failures → the SECOND error propagates (retry happens at most once)", async () => {
    let calls = 0;
    mockGetReplyStreaming.mockImplementation(() => {
      calls++;
      return (async function* () {
        throw transient(calls === 1 ? "503 first" : "503 second");
      })();
    });

    await expect(
      drain(runLlmTurn({ history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {} }))
    ).rejects.toThrow("503 second");
    expect(calls).toBe(2);
  });

  it("B6. barge-in after a retry still aborts the signal and leaves no dangling timers", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let capturedSignal = null;
    mockGetReplyStreaming.mockImplementation((history, userText, step, intent, config, extras, opts) => {
      calls++;
      if (calls === 1) {
        return (async function* () {
          throw transient();
        })();
      }
      capturedSignal = opts.signal;
      return (async function* () {
        yield { delta: "Hello" };
        yield { delta: "World" };
      })();
    });

    const gen = runLlmTurn({
      history: [],
      userText: "hi",
      step: "gather_details",
      intent: null,
      config: {},
      extras: {},
      firstChunkTimeoutMs: 2500,
      totalTimeoutMs: 8000,
    });

    const r1 = await gen.next();
    expect(r1.value).toEqual({ type: "delta", text: "Hello" }); // retry succeeded, first delta flowed
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // slow + total timers armed

    await gen.return();

    expect(capturedSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // no leaked timers after a retry+barge-in
  });

  // ---------------------------------------------------------------------------
  // Stall watchdog + tool-extended budget
  //
  // The dead-air case these exist for: the prompt has the model say "one
  // moment while I check that" in the SAME response as the tool call, so by
  // the time a lookup runs the turn has already produced text — which
  // permanently disarms the one-shot "slow" signal — and the caller then hears
  // nothing at all until the tool comes back.
  // ---------------------------------------------------------------------------
  describe("stall watchdog", () => {
    /** A stream that yields a delta, then hangs until released. */
    function stallingStream() {
      let release;
      const gate = new Promise((r) => { release = r; });
      mockGetReplyStreaming.mockImplementation(() =>
        (async function* () {
          yield { delta: "Let me check that. " };
          await gate;
          yield { done: true, reply: { text: "Let me check that. Thursday works." } };
        })()
      );
      return () => release();
    }

    it("yields { type: 'stalled' } when the model goes quiet AFTER its first chunk", async () => {
      vi.useFakeTimers();
      const release = stallingStream();

      const gen = runLlmTurn({
        history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {},
        firstChunkTimeoutMs: 10_000, totalTimeoutMs: 30_000, stallTimeoutMs: 500,
      });

      expect((await gen.next()).value).toEqual({ type: "delta", text: "Let me check that. " });

      const p = gen.next();
      await vi.advanceTimersByTimeAsync(500);
      const stalled = await p;
      expect(stalled.value.type).toBe("stalled");
      expect(stalled.value.sinceLastChunkMs).toBeGreaterThanOrEqual(500);

      release();
      expect((await gen.next()).value.type).toBe("done");
    });

    it("re-arms, unlike 'slow' — a long tool round can stall more than once", async () => {
      vi.useFakeTimers();
      const release = stallingStream();

      const gen = runLlmTurn({
        history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {},
        firstChunkTimeoutMs: 10_000, totalTimeoutMs: 30_000, stallTimeoutMs: 500, stallMaxYields: 2,
      });
      await gen.next(); // delta

      const p1 = gen.next();
      await vi.advanceTimersByTimeAsync(500);
      expect((await p1).value.type).toBe("stalled");

      const p2 = gen.next();
      await vi.advanceTimersByTimeAsync(500);
      expect((await p2).value.type).toBe("stalled");

      // Capped: no third one, however long the tool takes.
      const p3 = gen.next();
      await vi.advanceTimersByTimeAsync(5_000);
      release();
      expect((await p3).value.type).toBe("done");
    });

    it("never yields 'stalled' before the first chunk — that window belongs to 'slow'", async () => {
      vi.useFakeTimers();
      let release;
      const gate = new Promise((r) => { release = r; });
      mockGetReplyStreaming.mockImplementation(() =>
        (async function* () {
          await gate;
          yield { done: true, reply: { text: "hi" } };
        })()
      );

      const gen = runLlmTurn({
        history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {},
        firstChunkTimeoutMs: 300, totalTimeoutMs: 30_000, stallTimeoutMs: 100,
      });

      const p = gen.next();
      await vi.advanceTimersByTimeAsync(300);
      expect((await p).value).toEqual({ type: "slow" }); // not "stalled"

      release();
      expect((await gen.next()).value.type).toBe("done");
    });

    it("stallTimeoutMs=0 disables the signal entirely", async () => {
      vi.useFakeTimers();
      const release = stallingStream();

      const gen = runLlmTurn({
        history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {},
        firstChunkTimeoutMs: 10_000, totalTimeoutMs: 30_000, stallTimeoutMs: 0,
      });
      await gen.next(); // delta

      const p = gen.next();
      await vi.advanceTimersByTimeAsync(10_000);
      release();
      expect((await p).value.type).toBe("done");
    });

    it("leaves no dangling stall timer when the consumer bails out mid-stall", async () => {
      vi.useFakeTimers();
      stallingStream();

      const gen = runLlmTurn({
        history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {},
        firstChunkTimeoutMs: 10_000, totalTimeoutMs: 30_000, stallTimeoutMs: 500,
      });
      await gen.next();
      await gen.return();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("tool-extended turn budget", () => {
    it("a tool outcome buys more time, so a slow lookup does not kill its own turn", async () => {
      vi.useFakeTimers();
      let release;
      const gate = new Promise((r) => { release = r; });
      mockGetReplyStreaming.mockImplementation(() =>
        (async function* () {
          yield { delta: "One moment while I check. " };
          yield { toolEffect: { success: true } };
          await gate; // the follow-up round runs past the BASE budget
          yield { done: true, reply: { text: "Thursday at three works." } };
        })()
      );

      const gen = runLlmTurn({
        history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {},
        firstChunkTimeoutMs: 10_000,
        totalTimeoutMs: 1_000,
        stallTimeoutMs: 0,
        toolGraceMs: 4_000,
        hardTimeoutMs: 20_000,
      });

      await gen.next(); // delta
      await gen.next(); // toolEffect -> extends the deadline

      const p = gen.next();
      await vi.advanceTimersByTimeAsync(1_500); // past the ORIGINAL 1s budget
      release();
      expect((await p).value.type).toBe("done");
    });

    it("an extension can never push past the hard ceiling", async () => {
      // toolGraceMs (5s) would otherwise buy far more time than hardTimeoutMs
      // (800ms) allows. The ceiling is what stops a turn that looks busy from
      // holding the caller indefinitely.
      vi.useFakeTimers();
      let capturedSignal = null;
      mockGetReplyStreaming.mockImplementation((h, u, s, i, c, e, opts) => {
        capturedSignal = opts.signal;
        return (async function* () {
          yield { delta: "working " };
          yield { toolEffect: { success: true } };
          await new Promise((_, reject) => {
            opts.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            );
          });
        })();
      });

      const gen = runLlmTurn({
        history: [], userText: "hi", step: "gather_details", intent: null, config: {}, extras: {},
        firstChunkTimeoutMs: 10_000,
        totalTimeoutMs: 500,
        stallTimeoutMs: 0,
        toolGraceMs: 5_000,
        hardTimeoutMs: 800,
      });

      await gen.next(); // delta
      await gen.next(); // toolEffect -> tries to extend by 5s

      const p = gen.next();
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000); // past the 800ms ceiling

      await expect(p).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
      expect(capturedSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
