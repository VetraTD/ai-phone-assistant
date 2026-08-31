import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The Vertex floor warning is a LOG LINE and nothing else — there is no counter
// for "this backend will never cache anything" — so the log has to be the thing
// under test.
vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));
import { log } from "../lib/logger.js";

import {
  computeCacheKey,
  resolveCachedContent,
  invalidateCache,
  isCacheUnusableError,
  explicitCacheEnabled,
  getCacheStats,
  _resetForTests,
} from "../services/geminiCache.js";
import { buildCacheSpec, warmPromptCache, getClient } from "../services/gemini.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

// ---------------------------------------------------------------------------
// Explicit Gemini context caching.
//
// Implicit caching does not engage on gemini-3.6-flash at all (measured: three
// byte-identical 4,186-token requests, no cachedContentTokenCount, and two days
// of billing reading "$0.00 in savings" with input at ~93% of the bill).
// Explicit caching does work on the same model — 3,174 of 3,214 prompt tokens
// cached in scripts/verify-explicit-cache.js.
//
// The load-bearing property under test: resolveCachedContent is SYNCHRONOUS and
// never blocks a turn. It returns a handle or null and schedules creation in the
// background, so caching can never make a call slower and never make one fail.
// ---------------------------------------------------------------------------

const PREFIX = "You are a receptionist for Acme Dental. ".repeat(200); // ~8,000 chars
const TOOLS = [{ functionDeclarations: [{ name: "book_appointment", description: "Book." }] }];

function makeClient({ create } = {}) {
  return {
    caches: {
      create: create || vi.fn(async () => ({ name: "cachedContents/abc123", usageMetadata: { totalTokenCount: 2048 } })),
    },
  };
}

function spec(overrides = {}) {
  return {
    client: makeClient(),
    model: "gemini-3.6-flash",
    markerMode: false,
    staticPrefix: PREFIX,
    toolsConfig: TOOLS,
    businessId: "biz-1",
    enabled: true,
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetForTests();
  delete process.env.GEMINI_EXPLICIT_CACHE;
});

describe("explicitCacheEnabled", () => {
  it("is OFF unless explicitly turned on", () => {
    expect(explicitCacheEnabled()).toBe(false);
    process.env.GEMINI_EXPLICIT_CACHE = "false";
    expect(explicitCacheEnabled()).toBe(false);
    process.env.GEMINI_EXPLICIT_CACHE = "true";
    expect(explicitCacheEnabled()).toBe(true);
  });

  it("lets extras override the env, for the eval/text harness", () => {
    process.env.GEMINI_EXPLICIT_CACHE = "true";
    expect(explicitCacheEnabled({ explicitCache: false })).toBe(false);
  });
});

describe("computeCacheKey", () => {
  const base = { model: "gemini-3.6-flash", markerMode: false, staticPrefix: PREFIX, toolsConfig: TOOLS };

  it("is stable for identical input", () => {
    expect(computeCacheKey(base)).toBe(computeCacheKey({ ...base }));
  });

  it("changes with the model, marker mode, prefix, and tools", () => {
    const k = computeCacheKey(base);
    expect(computeCacheKey({ ...base, model: "gemini-3.6-pro" })).not.toBe(k);
    expect(computeCacheKey({ ...base, markerMode: true })).not.toBe(k);
    expect(computeCacheKey({ ...base, staticPrefix: `${PREFIX}x` })).not.toBe(k);
    expect(computeCacheKey({ ...base, toolsConfig: [] })).not.toBe(k);
  });

  // Multi-tenant safety is structural, not conventional: the key is a hash of
  // the prompt CONTENT, and two businesses differ in businessName at minimum.
  // Keying on businessId would make that safety depend on a field being
  // threaded correctly through every call site instead.
  it("separates two businesses by their prompt content, not by an id field", () => {
    const acme = computeCacheKey({ ...base, staticPrefix: "You answer for Acme Dental." });
    const riverside = computeCacheKey({ ...base, staticPrefix: "You answer for Riverside Clinic." });
    expect(acme).not.toBe(riverside);
  });
});

describe("resolveCachedContent — never blocks, never throws", () => {
  it("returns null and touches nothing when disabled", () => {
    const s = spec({ enabled: false });
    expect(resolveCachedContent(s)).toBeNull();
    expect(s.client.caches.create).not.toHaveBeenCalled();
  });

  it("returns null on the FIRST turn and schedules a create in the background", async () => {
    const s = spec();
    expect(resolveCachedContent(s)).toBeNull(); // turn 1 runs uncached, full speed
    await flush();
    expect(s.client.caches.create).toHaveBeenCalledTimes(1);

    const { config } = s.client.caches.create.mock.calls[0][0];
    expect(config.systemInstruction).toBe(PREFIX);
    expect(config.tools).toEqual(TOOLS); // tools MUST be in the cache — verified to still allow function calling
    expect(config.ttl).toMatch(/^\d+s$/);
  });

  it("returns the handle once the create resolves, and reuses it", async () => {
    const s = spec();
    resolveCachedContent(s);
    await flush();

    const first = resolveCachedContent(s);
    expect(first?.name).toBe("cachedContents/abc123");
    expect(first?.tokens).toBe(2048);

    resolveCachedContent(s);
    expect(s.client.caches.create).toHaveBeenCalledTimes(1); // reused, not recreated
  });

  // Two concurrent calls for the same business must not each create a cache.
  it("dedupes a create that is already in flight", async () => {
    const s = spec();
    resolveCachedContent(s);
    resolveCachedContent(s);
    resolveCachedContent(s);
    await flush();
    expect(s.client.caches.create).toHaveBeenCalledTimes(1);
  });

  it("never lets one business receive another's cache name", async () => {
    const acme = spec({ staticPrefix: `Acme Dental. ${PREFIX}` });
    const riverside = spec({
      staticPrefix: `Riverside Clinic. ${PREFIX}`,
      client: makeClient({
        create: vi.fn(async () => ({ name: "cachedContents/riverside", usageMetadata: { totalTokenCount: 2048 } })),
      }),
    });

    resolveCachedContent(acme);
    resolveCachedContent(riverside);
    await flush();

    expect(resolveCachedContent(acme)?.name).toBe("cachedContents/abc123");
    expect(resolveCachedContent(riverside)?.name).toBe("cachedContents/riverside");
  });

  // Gemini rejects a cache under 1,024 tokens outright. Paying an API call per
  // business to rediscover that is pure waste.
  it("skips a prompt too small to be cacheable, permanently", async () => {
    const s = spec({ staticPrefix: "tiny", toolsConfig: [] });
    expect(resolveCachedContent(s)).toBeNull();
    await flush();
    expect(s.client.caches.create).not.toHaveBeenCalled();
    expect(getCacheStats().skippedTooSmall).toBe(1);

    resolveCachedContent(s);
    await flush();
    expect(s.client.caches.create).not.toHaveBeenCalled(); // never retried
  });

  it("degrades silently when create fails, then backs off instead of retrying every turn", async () => {
    const create = vi.fn(async () => {
      throw new Error("429 quota exceeded");
    });
    const s = spec({ client: makeClient({ create }) });

    expect(resolveCachedContent(s)).toBeNull();
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(getCacheStats().createErrors).toBe(1);

    // Every subsequent turn during the cooldown runs uncached and issues no call.
    for (let i = 0; i < 5; i++) expect(resolveCachedContent(s)).toBeNull();
    await flush();
    expect(create).toHaveBeenCalledTimes(1);

    // After the cooldown lapses it tries again.
    const later = Date.now() + 60 * 60 * 1000;
    resolveCachedContent({ ...s, now: () => later });
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("never retries a permanently-unsupported prompt shape", async () => {
    const create = vi.fn(async () => {
      throw new Error("Cached content is too small. total_token_count=742, min_total_token_count=1024");
    });
    const s = spec({ client: makeClient({ create }) });

    resolveCachedContent(s);
    await flush();
    expect(getCacheStats().unsupported).toBe(1);

    const later = Date.now() + 24 * 60 * 60 * 1000;
    resolveCachedContent({ ...s, now: () => later });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rebuilds rather than handing out a cache about to expire", async () => {
    const s = spec();
    resolveCachedContent(s);
    await flush();
    expect(resolveCachedContent(s)).not.toBeNull();

    // Inside the expiry safety margin: treated as gone.
    const nearExpiry = Date.now() + 3600 * 1000 - 30_000;
    expect(resolveCachedContent({ ...s, now: () => nearExpiry })).toBeNull();
    await flush();
    expect(s.client.caches.create).toHaveBeenCalledTimes(2);
  });

  it("returns null instead of throwing when the client is unusable", () => {
    expect(resolveCachedContent(spec({ client: {} }))).toBeNull();
    expect(resolveCachedContent(spec({ client: null }))).toBeNull();
  });
});

describe("invalidateCache", () => {
  it("forces the next resolve to rebuild", async () => {
    const s = spec();
    resolveCachedContent(s);
    await flush();
    const live = resolveCachedContent(s);
    expect(live).not.toBeNull();

    invalidateCache(live.key, "stale_on_use");
    expect(resolveCachedContent(s)).toBeNull();
    await flush();
    expect(s.client.caches.create).toHaveBeenCalledTimes(2);
    expect(getCacheStats().staleOnUse).toBe(1);
  });

  it("is a no-op for an unknown key", () => {
    expect(() => invalidateCache("nope", "x")).not.toThrow();
  });
});

// Misclassifying a real model error as a cache error would silently retry — and
// therefore DOUBLE the cost of — every failing turn.
describe("isCacheUnusableError", () => {
  // The measured shape of a deleted cache. Note 403, not the 404 one might expect.
  const dead = Object.assign(new Error(
    '{"error":{"code":403,"message":"CachedContent not found (or permission denied)","status":"PERMISSION_DENIED"}}'
  ), { name: "ApiError", status: 403 });

  it("recognises the real deleted-cache error", () => {
    expect(isCacheUnusableError(dead)).toBe(true);
  });

  it("never treats an abort as a cache problem", () => {
    const abort = Object.assign(new Error("The operation was aborted. CachedContent"), { name: "AbortError", status: 403 });
    expect(isCacheUnusableError(abort)).toBe(false);
  });

  it("ignores errors that are not about the cache", () => {
    expect(isCacheUnusableError(Object.assign(new Error("429 quota exceeded"), { status: 429 }))).toBe(false);
    expect(isCacheUnusableError(Object.assign(new Error("500 internal"), { status: 500 }))).toBe(false);
    expect(isCacheUnusableError(Object.assign(new Error("403 permission denied on model"), { status: 403 }))).toBe(false);
    expect(isCacheUnusableError(null)).toBe(false);
    expect(isCacheUnusableError(undefined)).toBe(false);
  });
});

describe("getCacheStats", () => {
  it("reports live entries — a cache never created and one created but ignored both read as 0% hit rate", async () => {
    expect(getCacheStats().live).toBe(0);
    const s = spec();
    resolveCachedContent(s);
    await flush();
    expect(getCacheStats().live).toBe(1);
    expect(getCacheStats().creates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The SDK mutates what you hand it.
//
// @google/genai normalizes JSON-Schema `type` values to upper case IN PLACE
// when a request is sent ("object" -> "OBJECT"), and the declaration objects
// are module-level and shared by reference. So the same business hashed one way
// before its first request of the process and another way after — creating a
// second cache that was never reused and abandoning the first one's storage.
//
// Observed live before the fix: key d83268… on turn 1, f0475f… on turn 2, turn
// 3 reusing the second. After: one cache, 94% of input cached from turn 2 on.
// ---------------------------------------------------------------------------
describe("computeCacheKey — indifferent to the SDK's in-place schema rewrite", () => {
  const lower = [
    {
      functionDeclarations: [
        {
          name: "record_customer_request",
          description: "Take a message.",
          parameters: {
            type: "object",
            properties: {
              request_type: { type: "string", enum: ["message", "callback"] },
              details: { type: "object", properties: { note: { type: "string" } } },
            },
          },
        },
      ],
    },
  ];
  const upper = JSON.parse(
    JSON.stringify(lower).replace(/"type":"(object|string|array|number|boolean|integer)"/g, (_, t) => `"type":"${t.toUpperCase()}"`)
  );

  it("hashes the pre- and post-mutation tool lists identically", () => {
    const base = { model: "gemini-3.6-flash", markerMode: false, staticPrefix: PREFIX };
    expect(computeCacheKey({ ...base, toolsConfig: upper })).toBe(
      computeCacheKey({ ...base, toolsConfig: lower })
    );
  });

  it("still distinguishes genuinely different tool sets", () => {
    const base = { model: "gemini-3.6-flash", markerMode: false, staticPrefix: PREFIX };
    const renamed = JSON.parse(JSON.stringify(lower));
    renamed[0].functionDeclarations[0].name = "something_else";
    expect(computeCacheKey({ ...base, toolsConfig: renamed })).not.toBe(
      computeCacheKey({ ...base, toolsConfig: lower })
    );

    // A capability change that alters a parameter must still bust the cache —
    // the tool the model sees really is different.
    const extraParam = JSON.parse(JSON.stringify(lower));
    extraParam[0].functionDeclarations[0].parameters.properties.urgency = { type: "string" };
    expect(computeCacheKey({ ...base, toolsConfig: extraParam })).not.toBe(
      computeCacheKey({ ...base, toolsConfig: lower })
    );
  });

  it("creates exactly ONE cache across repeated turns, mutation and all", async () => {
    const s = spec({ toolsConfig: lower });
    resolveCachedContent(s);
    await flush();

    // The SDK has now rewritten the shared declarations in place.
    resolveCachedContent(spec({ client: s.client, toolsConfig: upper }));
    resolveCachedContent(spec({ client: s.client, toolsConfig: upper }));
    await flush();

    expect(s.client.caches.create).toHaveBeenCalledTimes(1);
    expect(getCacheStats().creates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The TTL is an economic decision, not a tuning knob, so it is asserted.
//
// Reads bill at $0.075/M against $0.75/M for fresh input, but STORAGE bills at
// $0.50 per million tokens per hour whether or not a call comes in. A ~4,200
// token prefix on the old 1h TTL is ~$1.53/month/business and needs ~49
// calls/month to break even — paid once per process on a multi-instance
// deploy, since the registry is a per-process Map. At 900s it is ~$0.0005 per
// call and breaks even at any volume. Nothing warns you if this silently goes
// back up; the bill arrives a month later.
// ---------------------------------------------------------------------------
describe("cache lifetime", () => {
  it("creates per-call caches (900s), not per-business ones", async () => {
    const s = spec();
    resolveCachedContent(s);
    await flush();

    expect(s.client.caches.create).toHaveBeenCalledTimes(1);
    const { config } = s.client.caches.create.mock.calls[0][0];
    expect(config.ttl).toBe("900s");
  });
});

// ---------------------------------------------------------------------------
// The warm path and the turn path must agree on the key, or warming is worse
// than useless: it builds a cache no turn ever reads, pays storage for it, and
// every turn still misses at full price — with nothing in the logs to say so.
//
// Asserted end-to-end (warm, then resolve exactly as a turn would) rather than
// by comparing two hashes, because the failure mode is the two paths CONSTRUCTING
// the prefix differently, which a hash comparison of one construction cannot see.
// ---------------------------------------------------------------------------
describe("warmPromptCache <-> turn path agreement", () => {
  // Deliberately a fixture with NON-EMPTY knowledge and integrations. Those two
  // are the fields that only arrive on state.contextPromise, so they are the
  // ones a warm fired at the wrong moment would get wrong — a fixture whose
  // extras are all empty cannot tell a correct warm from a premature one.
  const base = FIXTURES["appointments-db"];
  const fixture = {
    config: base.config,
    extras: {
      ...base.extras,
      knowledge: [{ question: "Do you take walk-ins?", answer: "Yes, before 3pm." }],
    },
  };
  let client;
  let createSpy;

  beforeEach(() => {
    process.env.GEMINI_EXPLICIT_CACHE = "true";
    client = getClient();
    createSpy = vi
      .spyOn(client.caches, "create")
      .mockResolvedValue({ name: "cachedContents/warm1", usageMetadata: { totalTokenCount: 4200 } });
  });

  afterEach(() => {
    createSpy.mockRestore();
    delete process.env.GEMINI_EXPLICIT_CACHE;
  });

  it("warms a cache the turn path then finds", async () => {
    warmPromptCache(fixture.config, fixture.extras);
    await flush();
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Exactly what getReplyStreaming does on the next turn.
    const s = buildCacheSpec(fixture.config, fixture.extras);
    const hit = resolveCachedContent({
      client,
      model: s.model,
      markerMode: s.markerMode,
      staticPrefix: s.staticPrefix,
      toolsConfig: s.toolsConfig,
      enabled: true,
    });

    expect(hit).not.toBeNull();
    expect(hit.name).toBe("cachedContents/warm1");
    // The turn must REUSE, never create a second cache for the same call.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("still agrees after the SDK rewrites the shared tool declarations in place", async () => {
    // buildAllDeclarations returns module-level objects by reference, and the
    // SDK upper-cases JSON-Schema `type` on them when a request is sent. This
    // once produced a second, never-reused cache per process.
    const first = buildCacheSpec(fixture.config, fixture.extras);
    const upper = (v) => {
      if (Array.isArray(v)) return v.forEach(upper);
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          if (k === "type" && typeof val === "string") v[k] = val.toUpperCase();
          else upper(val);
        }
      }
    };
    upper(first.toolsConfig);

    warmPromptCache(fixture.config, fixture.extras);
    await flush();

    const s = buildCacheSpec(fixture.config, fixture.extras);
    const hit = resolveCachedContent({
      client,
      model: s.model,
      markerMode: s.markerMode,
      staticPrefix: s.staticPrefix,
      toolsConfig: s.toolsConfig,
      enabled: true,
    });
    expect(hit?.name).toBe("cachedContents/warm1");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when the flag is off", async () => {
    delete process.env.GEMINI_EXPLICIT_CACHE;
    warmPromptCache(fixture.config, fixture.extras);
    await flush();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("never throws, whatever the config", () => {
    expect(() => warmPromptCache(null, undefined)).not.toThrow();
    expect(() => warmPromptCache(undefined, { explicitCache: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Vertex has a FOUR TIMES higher floor than the AI Studio API, and not one
// business shape in this repo clears it.
//
// Measured 2026-08-30 on gemini-3.6-flash at `global`: "The cached content is
// of 3078 tokens. The minimum token count to start explicit caching is 4096."
// countTokens over every fixture's real cache unit put the LARGEST shape at
// 3,967 tokens — 129 short. So the same flag that saves ~19% of a call today
// saves nothing at all after the GCP cutover, and the only native symptom of
// that is a bill.
//
// The floor is read off the SDK client's own `vertexai` flag rather than an env
// var, so the rule travels with the deployment instead of being something
// somebody has to remember to set.
// ---------------------------------------------------------------------------
describe("backend-aware size floor", () => {
  const vertexClient = (create) => ({ vertexai: true, caches: { create: create || vi.fn() } });

  it("caches a real-sized prompt on the API-key backend", async () => {
    const s = spec(); // PREFIX is ~8,000 chars — over the 6,000 AI Studio floor
    resolveCachedContent(s);
    await flush();
    expect(s.client.caches.create).toHaveBeenCalledTimes(1);
  });

  it("does not even attempt the same prompt on Vertex, where it would 400", async () => {
    const client = vertexClient();
    const hit = resolveCachedContent(spec({ client }));
    await flush();
    expect(hit).toBeNull();
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(getCacheStats().skippedTooSmall).toBe(1);
  });

  it("still caches on Vertex once a prompt is genuinely big enough", async () => {
    const client = vertexClient(
      vi.fn(async () => ({ name: "cachedContents/v1", usageMetadata: { totalTokenCount: 6588 } }))
    );
    // ~24,000 chars, comfortably past the ~19,850 that 4,096 tokens costs.
    resolveCachedContent(spec({ client, staticPrefix: "You are a receptionist. ".repeat(1000) }));
    await flush();
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it("says so loudly when Vertex is the reason nothing is being cached", async () => {
    const client = vertexClient();
    resolveCachedContent(spec({ client }));
    expect(log.error).toHaveBeenCalledWith(
      "gemini_cache_below_vertex_floor",
      expect.objectContaining({ severity: "warn", floor: 19_000 })
    );
  });
});
