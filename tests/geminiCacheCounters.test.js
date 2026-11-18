import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// llm_cache_hits / llm_cache_misses.
//
// These exist because the expensive failure of explicit caching is SILENT. If a
// provider refuses to create the cache — the open question on Vertex, where a
// "not supported" reply is classified as permanent and parks the registry entry
// forever — every call keeps working, sounds identical, and quietly costs ten
// times the input price until a bill arrives a month later. `llm_cache_hits`
// flat at zero with the flag on is the only alarm there is.
//
// Counted from Google's own usageMetadata rather than from this process's
// intent, so the number reports what was BILLED. The SDK is faked at the module
// boundary, so these are real runs of the generator.
// ---------------------------------------------------------------------------

const H = { chunks: [], usage: null };

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {
      this.chats = {
        create: () => ({
          async sendMessageStream() {
            const round = H.chunks.shift() ?? [];
            const usage = H.usage;
            return (async function* () {
              for (const c of round) yield c;
              if (usage) yield { usageMetadata: usage, candidates: [{ finishReason: "STOP" }] };
            })();
          },
        }),
      };
    }
  },
}));

const { getReplyStreaming } = await import("../services/gemini.js");
const { getLatencyStats, clearStats } = await import("../lib/voice/metrics.js");
const { FIXTURES } = await import("./fixtures/businessConfigs.js");

const CONFIG = FIXTURES["appointments-db"].config;
const text = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });

async function runTurn(extras) {
  const it = getReplyStreaming([], "hello", "identify_intent", null, CONFIG, extras);
  // eslint-disable-next-line no-empty
  for await (const _ of it) {}
}

const counters = () => getLatencyStats().turnTaking;

beforeEach(() => {
  clearStats();
  H.chunks = [[text("Sure, I can help with that.")]];
  H.usage = { promptTokenCount: 4200, candidatesTokenCount: 20, cachedContentTokenCount: 4000 };
});

afterEach(() => {
  delete process.env.GEMINI_EXPLICIT_CACHE;
});

describe("explicit cache hit/miss counters", () => {
  it("counts a hit when Google reports cached tokens", async () => {
    await runTurn({ explicitCache: true });
    expect(counters().llm_cache_hits).toBe(1);
    expect(counters().llm_cache_misses).toBe(0);
  });

  it("counts a miss when the turn was billed at full price", async () => {
    // The shape of a cache that was never created: the request succeeds, the
    // reply is identical, and cachedContentTokenCount is 0. Indistinguishable
    // from a hit without this counter.
    H.usage = { promptTokenCount: 4200, candidatesTokenCount: 20, cachedContentTokenCount: 0 };
    await runTurn({ explicitCache: true });
    expect(counters().llm_cache_hits).toBe(0);
    expect(counters().llm_cache_misses).toBe(1);
  });

  it("counts a miss when the provider reports no cache field at all", async () => {
    H.usage = { promptTokenCount: 4200, candidatesTokenCount: 20 };
    await runTurn({ explicitCache: true });
    expect(counters().llm_cache_misses).toBe(1);
  });

  it("counts nothing while the flag is off, so the counters mean what they say", async () => {
    await runTurn({ explicitCache: false });
    expect(counters().llm_cache_hits).toBe(0);
    expect(counters().llm_cache_misses).toBe(0);
  });
});
