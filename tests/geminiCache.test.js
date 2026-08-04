import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeCacheKey,
  resolveCachedContent,
  invalidateCache,
  isCacheUnusableError,
  explicitCacheEnabled,
  getCacheStats,
  _resetForTests,
} from "../services/geminiCache.js";

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
