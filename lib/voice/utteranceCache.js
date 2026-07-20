import crypto from "crypto";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// utteranceCache.js — module-wide LRU cache of pre-synthesized mulaw audio
// for short, high-repeat "micro-utterances" (greeting, fillers, silence
// nudges, goodbye lines) so a later call (or a later moment in the same
// call) can play them with zero synthesis latency instead of waiting on a
// live TTS round-trip.
//
// The cache itself (`cache` below) is intentionally module-level, not
// per-instance: createUtteranceCache({ synthesize }) returns a small object
// bound to a particular synthesize function, but every instance reads/writes
// the SAME shared Map — that's what lets one call's warm() benefit a later
// call (e.g. the second caller to a business gets the greeting for free).
//
// key = sha256(voiceKey + "|" + text) — "kind" (filler/nudge/goodbye/...) is
// purely a caller-side label for warm() entries; it is not part of the
// cache key, since only voiceKey+text determine what audio would be
// produced.
// ---------------------------------------------------------------------------

const CACHE_CAP = 100;

/** @type {Map<string, Buffer>} Insertion order doubles as LRU recency order. */
const cache = new Map();

function makeKey(voiceKey, text) {
  return crypto.createHash("sha256").update(`${voiceKey}|${text}`).digest("hex");
}

function setEntry(voiceKey, text, buf) {
  const key = makeKey(voiceKey, text);
  if (cache.has(key)) cache.delete(key); // re-insert to bump recency
  cache.set(key, buf);
  while (cache.size > CACHE_CAP) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

/**
 * @param {object} opts
 * @param {function(string, string): Promise<Buffer>} opts.synthesize -
 *   async (text, voiceKey) => mulaw Buffer, used only by warm().
 * @returns {{get: function(string,string,string): Buffer|null, warm: function(string, Array<{kind?:string,text:string}|string>): Promise<void>}}
 */
export function createUtteranceCache({ synthesize } = {}) {
  /**
   * @param {string} voiceKey
   * @param {string|null} _kind - caller-side label only, not part of the key
   * @param {string} text
   * @returns {Buffer|null}
   */
  function get(voiceKey, _kind, text) {
    if (!text) return null;
    const key = makeKey(voiceKey, text);
    if (!cache.has(key)) return null;
    const buf = cache.get(key);
    cache.delete(key); // bump recency (LRU)
    cache.set(key, buf);
    return buf;
  }

  /**
   * Fill the cache for `voiceKey` with the given entries. Best-effort and
   * idempotent: entries already cached are skipped (no re-synthesis), and a
   * single entry's synthesis failure doesn't abort the rest.
   * @param {string} voiceKey
   * @param {Array<{kind?: string, text: string}|string>} entries
   */
  async function warm(voiceKey, entries) {
    if (typeof synthesize !== "function" || !Array.isArray(entries)) return;
    for (const entry of entries) {
      const text = typeof entry === "string" ? entry : entry?.text;
      if (!text) continue;
      const key = makeKey(voiceKey, text);
      if (cache.has(key)) continue; // idempotent — already warmed
      try {
        const buf = await synthesize(text, voiceKey);
        if (buf) setEntry(voiceKey, text, buf);
      } catch (err) {
        log.error("utterance_cache_warm_failed", { voiceKey, text: text.slice(0, 40), reason: err?.message });
      }
    }
  }

  return { get, warm };
}

/** Test-only: clear the shared module-level cache between test cases. */
export function _resetForTests() {
  cache.clear();
}
