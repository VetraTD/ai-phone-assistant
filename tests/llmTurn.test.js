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
