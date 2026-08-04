/**
 * Explicit Gemini context caching — a COST lever, not a latency one.
 *
 * Every turn re-sends the same large block: who the business is, its knowledge
 * base, the rules, and the tool declarations. Measured on this codebase's own
 * prompt snapshots that block is >95% of the request (8,000-11,000 chars of
 * static prefix plus 2,000-8,600 of tools, against a 500-1,000 char per-turn
 * tail), and a ~10-turn call pays for it ten times over.
 *
 * Implicit caching does NOT engage on gemini-3.6-flash — measured 2026-08-04,
 * three byte-identical 4,186-token requests produced no cachedContentTokenCount
 * from systemInstruction OR from contents, and two days of billing read
 * "includes $0.00 in savings" with input tokens at ~93% of the bill. Explicit
 * caching works on the same model: verified 3,174 of 3,214 prompt tokens cached
 * (scripts/verify-explicit-cache.js). Cache reads bill at 10% of input price.
 *
 * TTFT is flat in prompt size, so none of this makes a call faster.
 *
 * ---------------------------------------------------------------------------
 * The design decision that removes an entire failure class: resolveCachedContent
 * is SYNCHRONOUS and never blocks a turn.
 *
 * Creating a cache is a 200-500ms round trip. Awaiting it would put that on
 * TTFT — on a path where 140ms was fought for and won. Instead this returns a
 * live handle or null, and SCHEDULES creation in the background. The cache is
 * created during turn 1 and used from turn 2 onward. A call is ~10 turns, so at
 * worst one turn per business per TTL goes uncached, and in exchange caching can
 * never make a call slower and never make one fail.
 * ---------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { log } from "../lib/logger.js";

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/**
 * Gemini rejects a cache under 1,024 tokens outright:
 *   "Cached content is too small. total_token_count=742, min_total_token_count=1024"
 * (measured, scripts/verify-explicit-cache.js).
 *
 * 6,000 chars is a deliberately conservative stand-in for that floor — the
 * chars-per-token ratio varies with content, and paying one wasted API call per
 * business to discover a prompt was 20 tokens short is worse than skipping a
 * cache that would have saved little anyway. This codebase's SMALLEST business
 * shape (messages-only: ~7,993 prefix + ~2,068 tools) is ~10,000 chars, so every
 * real business clears it.
 */
const MIN_CHARS = envInt("GEMINI_CACHE_MIN_CHARS", 6000);
const TTL_S = envInt("GEMINI_CACHE_TTL_S", 3600, { min: 60, max: 86_400 });
/** Treat a cache as dead slightly before it expires, so a name is never sent as it dies. */
const EXPIRY_MARGIN_MS = envInt("GEMINI_CACHE_EXPIRY_MARGIN_MS", 60_000);
/** After a transient create failure, wait this long before trying again — a quota
 *  outage must not mean one failed API call per turn per call. */
const RETRY_COOLDOWN_MS = envInt("GEMINI_CACHE_RETRY_COOLDOWN_MS", 600_000);
const MAX_ENTRIES = 200;

/** @type {Map<string, {key: string, name: string|null, businessId: string|null, state: string, createdAtMs: number, expiresAtMs: number, tokens: number|null, retryAtMs: number, lastError: string|null}>} */
const registry = new Map();

const stats = {
  creates: 0,
  reuses: 0,
  createErrors: 0,
  staleOnUse: 0,
  skippedTooSmall: 0,
  unsupported: 0,
  lastError: null,
};

/**
 * Kill-switch, mirroring intentMarkerEnabled in services/gemini.js. Ships OFF:
 * under a cache the dynamic tail stops being a system instruction and becomes
 * user-role content, which is a real prompt-behavior change that unit tests
 * cannot detect. It must clear the eval suite before it goes on in production.
 *
 * @param {object} [extras]
 * @returns {boolean}
 */
export function explicitCacheEnabled(extras = {}) {
  if (typeof extras?.explicitCache === "boolean") return extras.explicitCache;
  return process.env.GEMINI_EXPLICIT_CACHE === "true";
}

/**
 * Content-addressed cache key.
 *
 * Deliberately a hash of the PROMPT CONTENT, not of businessId. Two consequences,
 * both wanted:
 *
 *  - Multi-tenant safety is structural rather than conventional. Two businesses
 *    differ in businessName at minimum, so they hash differently and can never
 *    share a cache. Keying on businessId instead would make that safety depend
 *    on a field being threaded correctly through every call site.
 *  - A config change in the dashboard changes the prefix bytes, which changes
 *    the key, which creates a new cache in the background while the old one ages
 *    out on its TTL. No invalidation code is needed at all.
 *
 * @param {{model: string, markerMode: boolean, staticPrefix: string, toolsConfig: Array}} spec
 * @returns {string}
 */
export function computeCacheKey({ model, markerMode, staticPrefix, toolsConfig }) {
  return createHash("sha256")
    .update(String(model))
    .update("\0")
    .update(markerMode ? "1" : "0")
    .update("\0")
    .update(String(staticPrefix))
    .update("\0")
    .update(canonicalizeTools(toolsConfig))
    .digest("hex");
}

/**
 * Serialize tool declarations to a form the Gemini SDK cannot perturb.
 *
 * The SDK normalizes JSON-Schema `type` values to upper case IN PLACE
 * ("object" -> "OBJECT", "string" -> "STRING") when a request is sent, and the
 * declaration objects are module-level and shared by reference. So the exact
 * same business produces one tools JSON before its first request of the process
 * and a different one after — which silently created a second, never-reused
 * cache per process and threw away the first one's storage. Observed live, not
 * theorised: keys d83268… on turn 1 then f0475f… on turn 2, with turn 3 reusing
 * the second.
 *
 * Lower-casing every `type` makes the key indifferent to that rewrite. Nothing
 * else about the declarations is touched, so two genuinely different tool sets
 * still hash differently.
 *
 * @param {Array} toolsConfig
 * @returns {string}
 */
function canonicalizeTools(toolsConfig) {
  return JSON.stringify(toolsConfig ?? [], (key, value) =>
    key === "type" && typeof value === "string" ? value.toLowerCase() : value
  );
}

function sweep(nowMs) {
  if (registry.size <= MAX_ENTRIES) {
    for (const [k, e] of registry) {
      if (e.state === "live" && nowMs - e.expiresAtMs > 300_000) registry.delete(k);
    }
    return;
  }
  const oldest = [...registry.entries()].sort((a, b) => a[1].createdAtMs - b[1].createdAtMs);
  for (const [k] of oldest.slice(0, registry.size - MAX_ENTRIES)) registry.delete(k);
}

function scheduleCreate(entry, { client, model, staticPrefix, toolsConfig }, nowMs) {
  entry.state = "pending";
  entry.createdAtMs = nowMs;

  const config = {
    systemInstruction: staticPrefix,
    ttl: `${TTL_S}s`,
    displayName: `vetra:${entry.businessId ?? "anon"}:${entry.key.slice(0, 12)}`,
  };
  // Tools go INTO the cache: cachedContent is mutually exclusive with `tools` on
  // a request. Verified that function calling still works from a cached tool
  // list (scripts/verify-explicit-cache.js) — this was the hard gate.
  if (Array.isArray(toolsConfig) && toolsConfig.length > 0) config.tools = toolsConfig;

  Promise.resolve()
    .then(() => client.caches.create({ model, config }))
    .then((cache) => {
      entry.name = cache?.name ?? null;
      entry.tokens = cache?.usageMetadata?.totalTokenCount ?? null;
      entry.state = entry.name ? "live" : "cooldown";
      entry.expiresAtMs = Date.now() + TTL_S * 1000;
      entry.retryAtMs = entry.state === "cooldown" ? Date.now() + RETRY_COOLDOWN_MS : 0;
      stats.creates++;
      log.info("gemini_cache_created", {
        key: entry.key.slice(0, 12),
        businessId: entry.businessId,
        tokens: entry.tokens,
        ttlS: TTL_S,
      });
    })
    .catch((err) => {
      const message = err?.message || String(err);
      // "Cached content is too small" is PERMANENT for this prompt shape —
      // retrying it every ten minutes forever would be pure waste.
      const permanent = /too small|min_total_token_count|not supported|INVALID_ARGUMENT/i.test(message);
      entry.state = permanent ? "unsupported" : "cooldown";
      entry.retryAtMs = permanent ? Number.MAX_SAFE_INTEGER : Date.now() + RETRY_COOLDOWN_MS;
      entry.lastError = message;
      stats.createErrors++;
      if (permanent) stats.unsupported++;
      stats.lastError = message;
      log.error("gemini_cache_create_failed", {
        key: entry.key.slice(0, 12),
        businessId: entry.businessId,
        permanent,
        reason: message,
        severity: "warn",
      });
    });
}

/**
 * The live cache for this exact prompt shape, or null.
 *
 * SYNCHRONOUS. Never throws, never awaits, never rejects. May schedule a
 * background create as a side effect. Returning null always means "run this
 * turn exactly as it ran before caching existed".
 *
 * @param {object} spec
 * @param {object} spec.client - the GoogleGenAI singleton
 * @param {string} spec.model
 * @param {boolean} spec.markerMode
 * @param {string} spec.staticPrefix
 * @param {Array} spec.toolsConfig
 * @param {string|null} [spec.businessId] - telemetry/displayName ONLY, never keyed on
 * @param {boolean} spec.enabled
 * @param {function(): number} [spec.now]
 * @returns {{name: string, key: string, tokens: number|null}|null}
 */
export function resolveCachedContent(spec) {
  try {
    const { client, model, markerMode, staticPrefix, toolsConfig, businessId = null, enabled } = spec;
    if (!enabled || !client?.caches?.create) return null;

    const sizeChars = (staticPrefix?.length || 0) + JSON.stringify(toolsConfig ?? []).length;
    const nowMs = spec.now ? spec.now() : Date.now();

    const key = computeCacheKey({ model, markerMode, staticPrefix, toolsConfig });
    let entry = registry.get(key);

    if (!entry) {
      // Below Gemini's hard floor — never worth an API call that will 400.
      if (sizeChars < MIN_CHARS) {
        stats.skippedTooSmall++;
        log.debug("gemini_cache_skipped_small", { key: key.slice(0, 12), chars: sizeChars });
        registry.set(key, {
          key, name: null, businessId, state: "unsupported",
          createdAtMs: nowMs, expiresAtMs: 0, tokens: null,
          retryAtMs: Number.MAX_SAFE_INTEGER, lastError: "too_small",
        });
        return null;
      }
      entry = {
        key, name: null, businessId, state: "idle",
        createdAtMs: nowMs, expiresAtMs: 0, tokens: null, retryAtMs: 0, lastError: null,
      };
      registry.set(key, entry);
      sweep(nowMs);
    }

    if (entry.state === "unsupported") return null;
    if (entry.state === "pending") return null; // a create is already in flight — never start a second
    if (entry.state === "cooldown") {
      if (nowMs < entry.retryAtMs) return null;
      scheduleCreate(entry, { client, model, staticPrefix, toolsConfig }, nowMs);
      return null;
    }
    if (entry.state === "live") {
      if (nowMs < entry.expiresAtMs - EXPIRY_MARGIN_MS) {
        stats.reuses++;
        return { name: entry.name, key: entry.key, tokens: entry.tokens };
      }
      // Within the safety margin of expiry: treat as gone and rebuild.
      scheduleCreate(entry, { client, model, staticPrefix, toolsConfig }, nowMs);
      return null;
    }

    scheduleCreate(entry, { client, model, staticPrefix, toolsConfig }, nowMs);
    return null;
  } catch (err) {
    // A caching bug must never cost a call.
    log.error("gemini_cache_resolve_error", { reason: err?.message, severity: "warn" });
    return null;
  }
}

/**
 * Mark an entry dead so the next resolve rebuilds it.
 * @param {string} key
 * @param {string} reason
 */
export function invalidateCache(key, reason) {
  const entry = registry.get(key);
  if (!entry) return;
  entry.state = "idle";
  entry.name = null;
  entry.expiresAtMs = 0;
  entry.retryAtMs = 0;
  entry.lastError = reason;
  stats.staleOnUse++;
  log.info("gemini_cache_invalidated", { key: key.slice(0, 12), reason });
}

/**
 * Is this error "the cache is unusable", as opposed to a real model error?
 *
 * Conservative on purpose. Misclassifying a genuine model failure as a cache
 * failure would silently retry — and therefore DOUBLE the cost of — every
 * failing turn.
 *
 * Measured shape of a deleted/expired cache (scripts/verify-explicit-cache.js):
 *   name: "ApiError", status: 403,
 *   message: '{"error":{"code":403,"message":"CachedContent not found (or permission denied)","status":"PERMISSION_DENIED"}}'
 * Note 403, not the 404 one might reasonably expect.
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isCacheUnusableError(err) {
  // An aborted turn (barge-in, caller hung up) is never a cache problem, and
  // retrying it would speak over somebody.
  if (err?.name === "AbortError") return false;

  const status = err?.status ?? err?.code ?? null;
  const message = String(err?.message || "");
  if (!/cachedcontent|cached_content/i.test(message)) return false;
  return status === 403 || status === 404 || status === 400;
}

/** Registry-level truth for GET /api/debug/latency. */
export function getCacheStats() {
  let live = 0;
  for (const e of registry.values()) if (e.state === "live") live++;
  return { entries: registry.size, live, ...stats };
}

/** Test seam. */
export function _resetForTests() {
  registry.clear();
  Object.assign(stats, {
    creates: 0, reuses: 0, createErrors: 0, staleOnUse: 0,
    skippedTooSmall: 0, unsupported: 0, lastError: null,
  });
}
