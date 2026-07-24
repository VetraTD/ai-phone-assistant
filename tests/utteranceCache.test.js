import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUtteranceCache, _resetForTests } from "../lib/voice/utteranceCache.js";

describe("lib/voice/utteranceCache.js — pre-cached micro-utterances", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("1. get() is a miss for anything never warmed", () => {
    const cache = createUtteranceCache({ synthesize: vi.fn() });
    expect(cache.get("voiceA", "filler", "One moment.")).toBeNull();
  });

  it("2. warm() synthesizes each entry and get() then hits", async () => {
    const buf = Buffer.from([1, 2, 3]);
    const synthesize = vi.fn(async () => buf);
    const cache = createUtteranceCache({ synthesize });

    await cache.warm("voiceA", [{ kind: "filler", text: "One moment." }]);

    expect(synthesize).toHaveBeenCalledWith("One moment.", "voiceA");
    expect(cache.get("voiceA", "filler", "One moment.")).toEqual(buf);
  });

  it("3. get() is scoped per voiceKey — a hit for one voice is a miss for another", async () => {
    const buf = Buffer.from([9]);
    const synthesize = vi.fn(async () => buf);
    const cache = createUtteranceCache({ synthesize });

    await cache.warm("voiceA", [{ text: "Hello there." }]);

    expect(cache.get("voiceA", null, "Hello there.")).toEqual(buf);
    expect(cache.get("voiceB", null, "Hello there.")).toBeNull();
  });

  it("4. warm() is idempotent — re-warming an already-cached entry does not re-synthesize", async () => {
    const synthesize = vi.fn(async () => Buffer.from([1]));
    const cache = createUtteranceCache({ synthesize });

    await cache.warm("voiceA", [{ text: "Goodbye!" }]);
    expect(synthesize).toHaveBeenCalledTimes(1);

    await cache.warm("voiceA", [{ text: "Goodbye!" }]);
    expect(synthesize).toHaveBeenCalledTimes(1); // still 1 — not re-synthesized
  });

  it("5. warm() entries are shared module-wide across separate createUtteranceCache instances", async () => {
    const buf = Buffer.from([5]);
    const cacheA = createUtteranceCache({ synthesize: vi.fn(async () => buf) });
    await cacheA.warm("voiceA", [{ text: "Hi." }]);

    // A second instance (e.g. a different call's session) with a different
    // (or no) synthesize function still sees the warmed entry.
    const cacheB = createUtteranceCache({ synthesize: vi.fn() });
    expect(cacheB.get("voiceA", null, "Hi.")).toEqual(buf);
  });

  it("6. warm() swallows per-entry synthesis failures and continues with the rest", async () => {
    const buf = Buffer.from([2]);
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new Error("tts down"))
      .mockResolvedValueOnce(buf);
    const cache = createUtteranceCache({ synthesize });

    await expect(
      cache.warm("voiceA", [{ text: "fails" }, { text: "succeeds" }])
    ).resolves.not.toThrow();

    expect(cache.get("voiceA", null, "fails")).toBeNull();
    expect(cache.get("voiceA", null, "succeeds")).toEqual(buf);
  });

  it("7. LRU eviction: the 101st distinct entry evicts the least-recently-used one", async () => {
    const synthesize = vi.fn(async (text) => Buffer.from(text));
    const cache = createUtteranceCache({ synthesize });

    const entries = Array.from({ length: 100 }, (_, i) => ({ text: `phrase-${i}` }));
    await cache.warm("voiceA", entries);

    await cache.warm("voiceA", [{ text: "phrase-100" }]);

    // Cache was full at 100; adding a 101st evicts the oldest (phrase-0,
    // never re-accessed after being warmed).
    expect(cache.get("voiceA", null, "phrase-0")).toBeNull();
    expect(cache.get("voiceA", null, "phrase-100")).not.toBeNull();
  });

  it("8. LRU: a get() bumps recency, protecting that entry from the next eviction", async () => {
    const synthesize = vi.fn(async (text) => Buffer.from(text));
    const cache = createUtteranceCache({ synthesize });

    const entries = Array.from({ length: 100 }, (_, i) => ({ text: `p-${i}` }));
    await cache.warm("voiceA", entries);

    // Touch p-0 so it's now the most-recently-used, not the oldest.
    cache.get("voiceA", null, "p-0");

    await cache.warm("voiceA", [{ text: "p-100" }]);

    // p-1 (never touched) is now the oldest and gets evicted instead of p-0.
    expect(cache.get("voiceA", null, "p-0")).not.toBeNull();
    expect(cache.get("voiceA", null, "p-1")).toBeNull();
  });

  it("9. get() with empty/missing text is a safe miss, not a throw", () => {
    const cache = createUtteranceCache({ synthesize: vi.fn() });
    expect(() => cache.get("voiceA", "filler", "")).not.toThrow();
    expect(cache.get("voiceA", "filler", "")).toBeNull();
  });

  it("10. warm() with a non-function synthesize or non-array entries is a no-op, never throws", async () => {
    const cache = createUtteranceCache({});
    await expect(cache.warm("voiceA", [{ text: "x" }])).resolves.not.toThrow();
    await expect(cache.warm("voiceA", null)).resolves.not.toThrow();
    expect(cache.get("voiceA", null, "x")).toBeNull();
  });

  it("11. warm() accepts a per-call synthesize override, keying the result under that voice", async () => {
    const defaultSynth = vi.fn(async () => Buffer.from([1]));
    const elSynth = vi.fn(async () => Buffer.from([2]));
    const cache = createUtteranceCache({ synthesize: defaultSynth });

    // A Google business warms its Google voice with the default backend.
    await cache.warm("google-voice", [{ text: "One moment." }]);
    // An ElevenLabs business warms its EL voice with an EL backend override —
    // the SAME shared LRU, distinct key.
    await cache.warm("el-voice-id", [{ text: "One moment." }], { synthesize: elSynth });

    expect(defaultSynth).toHaveBeenCalledWith("One moment.", "google-voice");
    expect(elSynth).toHaveBeenCalledWith("One moment.", "el-voice-id");
    expect(cache.get("google-voice", null, "One moment.")).toEqual(Buffer.from([1]));
    expect(cache.get("el-voice-id", null, "One moment.")).toEqual(Buffer.from([2]));
  });

  it("12. warm() does not cache an empty/zero-length synthesis result", async () => {
    const cache = createUtteranceCache({ synthesize: vi.fn(async () => Buffer.alloc(0)) });
    await cache.warm("voiceA", [{ text: "silent" }]);
    expect(cache.get("voiceA", null, "silent")).toBeNull();
  });
});
