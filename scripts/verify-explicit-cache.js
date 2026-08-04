/**
 * A0 — the verification gate for explicit Gemini context caching.
 *
 * Three unknowns block writing the real implementation correctly, and all three
 * are cheaper to answer here than to discover after a refactor:
 *
 *   1. What is the MINIMUM token count for an explicit cache on this model?
 *      The smallest business shape in this codebase (messages-only) is roughly
 *      3,000 tokens and may fall under it. That decides whether the cache
 *      module needs a skip-if-too-small guard and what the threshold is.
 *
 *   2. Does FUNCTION CALLING still work when `tools` live only in the cache?
 *      This is a hard gate. cachedContent is mutually exclusive with both
 *      systemInstruction and tools, so a cached request has to carry its tool
 *      declarations inside the cache. If the model stops calling tools, explicit
 *      caching is dead for every tool-bearing business and the whole plan stops.
 *
 *   3. What EXACTLY does an expired/deleted cache name look like when used?
 *      The fallback path has to recognise "this cache is unusable" and retry
 *      uncached, without swallowing genuine model errors — misclassifying a real
 *      error as a cache error would silently double a failing turn's cost.
 *
 * Read-only with respect to the product: creates and deletes its own caches,
 * touches no application state.
 *
 *   node scripts/verify-explicit-cache.js
 */

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("GEMINI_API_KEY is not set. Nothing to verify.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

/** Roughly `tokens` worth of stable, prose-shaped filler. ~4 chars per token. */
function filler(tokens) {
  const sentence =
    "The front desk answers every call politely and confirms the caller's details before booking. ";
  return sentence.repeat(Math.ceil((tokens * 4) / sentence.length)).slice(0, tokens * 4);
}

const created = [];

async function tryCreate(label, tokens, extraConfig = {}) {
  const systemInstruction = `You are a receptionist for Acme Dental.\n\n${filler(tokens)}`;
  try {
    const cache = await ai.caches.create({
      model: MODEL,
      config: { systemInstruction, ttl: "300s", displayName: `verify-${label}`, ...extraConfig },
    });
    created.push(cache.name);
    const total = cache.usageMetadata?.totalTokenCount ?? null;
    console.log(`  ✓ ${label.padEnd(14)} ~${tokens} tokens -> CREATED (cached total: ${total})`);
    return { ok: true, cache, total };
  } catch (err) {
    const status = err?.status ?? err?.code ?? "";
    console.log(`  ✗ ${label.padEnd(14)} ~${tokens} tokens -> REJECTED [${status}] ${err?.message}`);
    return { ok: false, err };
  }
}

// ---------------------------------------------------------------------------
// Question 1 — minimum cacheable size
// ---------------------------------------------------------------------------
console.log(`\nModel: ${MODEL}`);
console.log("\n=== 1. Minimum token count for an explicit cache ===");
console.log("   (messages-only, this repo's smallest business shape, is ~3,000 tokens)\n");

const sizes = [500, 1000, 1500, 2000, 3000, 4200];
const sizeResults = [];
for (const t of sizes) {
  sizeResults.push({ tokens: t, ...(await tryCreate(`size-${t}`, t)) });
}

const smallestOk = sizeResults.find((r) => r.ok);
const largestFail = [...sizeResults].reverse().find((r) => !r.ok);
console.log(
  `\n   -> smallest that CREATED: ${smallestOk ? `~${smallestOk.tokens}` : "none"}; ` +
    `largest that FAILED: ${largestFail ? `~${largestFail.tokens}` : "none"}`
);
console.log("   -> set GEMINI_CACHE_MIN_CHARS to roughly 4x the smallest working token count.");

// ---------------------------------------------------------------------------
// Question 2 — does function calling survive when tools live in the cache?
// THE HARD GATE.
// ---------------------------------------------------------------------------
console.log("\n=== 2. Function calling with tools ONLY in the cache (hard gate) ===\n");

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "book_appointment",
        description: "Book an appointment for the caller at a specific date and time.",
        parameters: {
          type: "object",
          properties: {
            client_name: { type: "string", description: "The caller's full name" },
            scheduled_at: { type: "string", description: "ISO 8601 datetime" },
          },
          required: ["client_name", "scheduled_at"],
        },
      },
    ],
  },
];

let toolVerdict = "not run";
const toolCache = await tryCreate("with-tools", 4200, { tools: TOOLS });

if (toolCache.ok) {
  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents:
        "My name is Jordan Lee. Book me for Tuesday the 12th of August 2026 at 10am. " +
        "Call the tool, do not just say you will.",
      config: { cachedContent: toolCache.cache.name, temperature: 0 },
    });
    const calls = res.functionCalls || [];
    const cachedTokens = res.usageMetadata?.cachedContentTokenCount ?? null;
    console.log(`   functionCalls: ${JSON.stringify(calls)}`);
    console.log(`   cachedContentTokenCount: ${cachedTokens}`);
    console.log(`   promptTokenCount: ${res.usageMetadata?.promptTokenCount ?? null}`);
    toolVerdict = calls.length > 0 ? "WORKS" : "BROKEN — model did not call the tool";
  } catch (err) {
    toolVerdict = `ERROR — ${err?.message}`;
    console.log(`   request failed: ${err?.message}`);
  }
}
console.log(`\n   -> VERDICT: ${toolVerdict}`);
if (toolVerdict !== "WORKS") {
  console.log("   -> If this is not WORKS, explicit caching is dead for tool-bearing businesses.");
}

// ---------------------------------------------------------------------------
// Question 3 — the error shape for a dead cache name
// ---------------------------------------------------------------------------
console.log("\n=== 3. Error shape when a cache is deleted, then used ===\n");

let deadShape = "not run";
const doomed = await tryCreate("to-delete", 4200);
if (doomed.ok) {
  await ai.caches.delete({ name: doomed.cache.name });
  created.splice(created.indexOf(doomed.cache.name), 1);
  try {
    await ai.models.generateContent({
      model: MODEL,
      contents: "Hello?",
      config: { cachedContent: doomed.cache.name },
    });
    deadShape = "NO ERROR — a deleted cache was accepted";
  } catch (err) {
    deadShape = JSON.stringify(
      { name: err?.name, status: err?.status ?? err?.code ?? null, message: err?.message },
      null,
      2
    );
  }
}
console.log(`   ${deadShape}`);
console.log("   -> isCacheUnusableError() must match this, and NOTHING broader.");

// ---------------------------------------------------------------------------
for (const name of created) {
  try {
    await ai.caches.delete({ name });
  } catch {
    /* best effort — everything here has a short TTL anyway */
  }
}
console.log(`\nCleaned up ${created.length} cache(s).\n`);
