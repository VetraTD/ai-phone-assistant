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
 *
 * ---------------------------------------------------------------------------
 * A FOURTH unknown, added 2026-08-30: does any of this survive Vertex?
 *
 * The GCP estate runs `new GoogleGenAI({ vertexai: true })`, and Vertex context
 * caching is a different, REGIONAL resource — while the deployment's
 * VERTEX_LOCATION is `global`. If create is refused there, geminiCache.js
 * classifies "not supported" as PERMANENT, parks the entry in `unsupported`,
 * and every call thereafter works perfectly and silently costs full price.
 * That is a failure nobody hears and nobody sees until a bill arrives, so it
 * gets answered here for ~$0.01 instead of in production.
 *
 * The same script covers both backends deliberately: a second script would
 * drift from this one, and the AI-Studio flow below is the measured one.
 *
 *   VERTEX_ENABLED=true GOOGLE_CLOUD_PROJECT=... VERTEX_LOCATION=global \
 *     node scripts/verify-explicit-cache.js
 */

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const apiKey = process.env.GEMINI_API_KEY;
const vertexEnabled = process.env.VERTEX_ENABLED === "true" || process.env.VERTEX_ENABLED === "1";

/**
 * Mirrors services/gemini.js getClient() on the GCP lineage, including the
 * baseUrl override. That override is not cosmetic: measured 2026-08-28,
 * global-aiplatform.googleapis.com returns 404, so `global`/`us`/`eu` must be
 * pointed at the plain host or every request fails for a reason that has
 * nothing to do with caching.
 */
const VERTEX_GLOBAL_HOST_LOCATIONS = ["us", "eu", "global"];

let ai;
let backend;
if (vertexEnabled) {
  const project = (process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = (process.env.VERTEX_LOCATION || "").trim();
  if (!project || !location) {
    console.error("VERTEX_ENABLED is set but GOOGLE_CLOUD_PROJECT and/or VERTEX_LOCATION are not.");
    process.exit(1);
  }
  const globalHost = VERTEX_GLOBAL_HOST_LOCATIONS.includes(location.toLowerCase());
  ai = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    ...(globalHost ? { httpOptions: { baseUrl: "https://aiplatform.googleapis.com" } } : {}),
  });
  backend = `vertex (project=${project}, location=${location})`;
} else {
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set, and VERTEX_ENABLED is not true. Nothing to verify.");
    process.exit(1);
  }
  ai = new GoogleGenAI({ apiKey });
  backend = "ai-studio (api key)";
}

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
console.log(`Backend: ${backend}`);
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

const ASK =
  "My name is Jordan Lee. Book me for Tuesday the 12th of August 2026 at 10am. " +
  "Call the tool, do not just say you will.";

const SYSTEM_FOR_CONTROL = `You are a receptionist for Acme Dental.\n\n${filler(4200)}`;

/**
 * THE CONTROL, and this probe was wrong without it.
 *
 * "The model did not call the tool" has two possible causes and they lead to
 * opposite decisions: the cache broke function calling (explicit caching is
 * dead for every tool-bearing business), or this prompt simply does not elicit
 * a tool call (the probe is broken and the feature is fine). One run of the
 * cached case cannot tell them apart, and the ledger already records a
 * measurement session that produced a fully wrong table for exactly this reason.
 *
 * So the identical tools and the identical message are sent BOTH ways. The
 * uncached arm MUST produce a tool call; if it does not, the verdict below is
 * about the question, not about caching.
 */
/**
 * N TRIALS PER ARM, not one, and this was learned the hard way.
 *
 * The first version of this gate sent one request per arm and reported a
 * verdict. Run twice in a row it produced BROKEN and then its exact inverse
 * (uncached failed, cached succeeded) — so `temperature: 0` is NOT
 * deterministic for whether this model emits a function call, and a single-shot
 * comparison of two arms is a coin flip dressed as a measurement. It would have
 * killed or shipped a feature on noise, in whichever direction it landed first.
 *
 * A rate is the smallest honest unit here.
 */
const TRIALS = Number.parseInt(process.env.CACHE_GATE_TRIALS || "5", 10);

async function askWith(config, label) {
  let called = 0;
  let failed = 0;
  let cachedTokens = null;
  let promptTokens = null;

  for (let i = 0; i < TRIALS; i++) {
    try {
      const res = await ai.models.generateContent({ model: MODEL, contents: ASK, config });
      if ((res.functionCalls || []).length > 0) called++;
      cachedTokens = res.usageMetadata?.cachedContentTokenCount ?? cachedTokens;
      promptTokens = res.usageMetadata?.promptTokenCount ?? promptTokens;
    } catch (err) {
      failed++;
      if (i === 0) console.log(`   ${label.padEnd(10)} request failed: ${err?.message}`);
    }
  }

  console.log(
    `   ${label.padEnd(10)} called the tool ${called}/${TRIALS}` +
      (failed ? ` (${failed} request errors)` : "") +
      `   cachedContentTokenCount: ${cachedTokens}  promptTokenCount: ${promptTokens}`
  );
  return { called, failed, rate: called / TRIALS, cachedTokens, promptTokens };
}

let toolVerdict = "not run";
const toolCache = await tryCreate("with-tools", 4200, { tools: TOOLS });

if (toolCache.ok) {
  const control = await askWith(
    { systemInstruction: SYSTEM_FOR_CONTROL, tools: TOOLS, temperature: 0 },
    "UNCACHED"
  );
  const cached = await askWith({ cachedContent: toolCache.cache.name, temperature: 0 }, "CACHED");

  if (control.rate === 0) {
    toolVerdict =
      `INCONCLUSIVE — the UNCACHED control called the tool 0/${TRIALS} times, so this probe is ` +
      "measuring the prompt, not the cache";
  } else if (cached.rate === 0) {
    toolVerdict = `BROKEN — uncached ${control.called}/${TRIALS}, cached 0/${TRIALS}. The cache is the difference`;
  } else if (cached.rate < control.rate) {
    toolVerdict =
      `DEGRADED — uncached ${control.called}/${TRIALS}, cached ${cached.called}/${TRIALS}. ` +
      "Tool calling still happens under a cache but less often; N is small, so treat this as " +
      "a reason to measure on the real prompt rather than as a number";
  } else {
    toolVerdict = `WORKS — uncached ${control.called}/${TRIALS}, cached ${cached.called}/${TRIALS}`;
  }
}
console.log(`\n   -> VERDICT: ${toolVerdict}`);
if (toolVerdict.startsWith("BROKEN")) {
  console.log("   -> Explicit caching is dead for tool-bearing businesses, which is every one.");
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
