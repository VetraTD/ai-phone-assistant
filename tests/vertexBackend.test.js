import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A8. The ledger is explicit that this step is "Code only — cannot be verified
// before C1", and that is honest: no Vertex call has been made from this code.
// What C1 measures is llm_ttfb_ms, which A0 put at 42% of a 2,611 ms turn —
// the dominant stage, and the number this change moves in one direction or the
// other. Nothing in this file is evidence that Vertex works.
//
// What CAN be tested now is which backend gets chosen, and that is worth
// testing on its own, because the choice is a compliance boundary rather than a
// preference: the API-key path is the Gemini Developer API (AI Studio), which
// is not a Google Cloud service and so is not covered by the Google Cloud BAA.
// An uncovered LLM call carries the caller's entire utterance.

const ENV = ["VERTEX_ENABLED", "GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION", "GEMINI_API_KEY", "DEPLOYMENT_MODE"];
const saved = {};

const constructed = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(opts) {
      constructed.push(opts);
    }
  },
  Type: {},
}));

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  constructed.length = 0;
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

async function load(env) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../services/gemini.js");
}

describe("vertexConfig", () => {
  it("is off unless VERTEX_ENABLED is set explicitly", async () => {
    const { vertexConfig } = await load({ GEMINI_API_KEY: "k" });
    // GOOGLE_CLOUD_PROJECT is injected automatically by Cloud Run, so inferring
    // Vertex from its presence would silently switch backends the moment this
    // deploys. That has to be a decision, not a side effect.
    expect(vertexConfig({ GOOGLE_CLOUD_PROJECT: "p", VERTEX_LOCATION: "us" }).enabled).toBe(false);
  });

  it("is usable only with a project AND a location", async () => {
    const { vertexConfig } = await load({ GEMINI_API_KEY: "k" });
    expect(vertexConfig({ VERTEX_ENABLED: "true", GOOGLE_CLOUD_PROJECT: "p" }).usable).toBe(false);
    expect(vertexConfig({ VERTEX_ENABLED: "true", VERTEX_LOCATION: "us" }).usable).toBe(false);
    expect(
      vertexConfig({ VERTEX_ENABLED: "true", GOOGLE_CLOUD_PROJECT: "p", VERTEX_LOCATION: "us" }).usable
    ).toBe(true);
  });
});

describe("getClient — backend selection", () => {
  it("builds a Vertex client with no API key when configured", async () => {
    const { getClient } = await load({
      VERTEX_ENABLED: "true",
      GOOGLE_CLOUD_PROJECT: "vetra-us-prod-c3a3bd",
      VERTEX_LOCATION: "us",
      GEMINI_API_KEY: "should-be-ignored",
    });

    getClient();

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toEqual({
      vertexai: true,
      project: "vetra-us-prod-c3a3bd",
      location: "us",
      // `us` is a MULTI-REGION, and the SDK would derive
      // us-aiplatform.googleapis.com for it, which 404s. The global host with
      // the location in the path is the one that answers. A real call failed on
      // this — see tests/vertexStreamingPath.test.js.
      httpOptions: { baseUrl: "https://aiplatform.googleapis.com" },
    });
    // No apiKey, deliberately: Vertex authenticates with ADC, which on Cloud
    // Run is the runtime service account's metadata token — a credential that
    // cannot be copied out of the project, unlike a key that can be pasted
    // anywhere.
    expect(constructed[0]).not.toHaveProperty("apiKey");
  });

  it("builds the API-key client when Vertex is not asked for", async () => {
    const { getClient } = await load({ GEMINI_API_KEY: "k" });

    getClient();

    expect(constructed[0]).toEqual({ apiKey: "k" });
  });

  // The silent-failure class this codebase keeps finding: the operator asked
  // for the covered backend and would have got the uncovered one.
  it("refuses rather than falling back when VERTEX_ENABLED is set but incomplete", async () => {
    const { getClient } = await load({ VERTEX_ENABLED: "true", GEMINI_API_KEY: "k" });

    expect(() => getClient()).toThrow(/VERTEX_ENABLED is set but/);
    expect(constructed).toHaveLength(0);
  });

  it("reuses the one client rather than building a pool per turn", async () => {
    const { getClient } = await load({ GEMINI_API_KEY: "k" });

    const a = getClient();
    const b = getClient();

    expect(a).toBe(b);
    expect(constructed).toHaveLength(1);
  });
});

describe("getClient — hipaa mode", () => {
  it("refuses the Gemini Developer API", async () => {
    const { getClient } = await load({ DEPLOYMENT_MODE: "hipaa", GEMINI_API_KEY: "k" });

    expect(() => getClient()).toThrow(/Gemini Developer API/);
    expect(constructed).toHaveLength(0);
  });

  it("allows Vertex", async () => {
    const { getClient } = await load({
      DEPLOYMENT_MODE: "hipaa",
      VERTEX_ENABLED: "true",
      GOOGLE_CLOUD_PROJECT: "vetra-us-prod-c3a3bd",
      VERTEX_LOCATION: "us",
    });

    expect(() => getClient()).not.toThrow();
    expect(constructed[0].vertexai).toBe(true);
  });
});

describe("explicit caching survives the move", () => {
  // The ledger flags this as the hard part: `cachedContent` is mutually
  // exclusive with `systemInstruction` AND with `tools` on a request, so the
  // tools have to go INTO the cache instead. services/geminiCache.js already
  // does that — scheduleCreate puts toolsConfig in the cache config — and it
  // was verified against the live API by scripts/verify-explicit-cache.js
  // before this migration started. Pinning it here so a Vertex port cannot
  // quietly undo it.
  it("puts tools inside the cached content, not alongside it", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../services/geminiCache.js", import.meta.url), "utf8");
    expect(src).toMatch(/config\.tools = toolsConfig/);
  });

});

// ---------------------------------------------------------------------------
// VERTEX_LOCATION, probed rather than assumed (2026-08-21).
//
// `:countTokens` against the real org, with a bogus model name as the control:
// locations/eu 200, locations/us 200, locations/global 200, us-central1 404,
// europe-west2 404, europe-west4 404.
//
// NO SINGLE REGION SERVES gemini-3.6-flash. The fixtures in this file used to
// say `us-central1`, which reads as obviously correct, sits next to the US
// Cloud Run service, and would have 404'd on the first turn of the first call.
// ---------------------------------------------------------------------------
describe("VERTEX_LOCATION", () => {
  const base = { VERTEX_ENABLED: "true", GOOGLE_CLOUD_PROJECT: "p" };

  it.each(["us", "eu"])("%s is a served multi-region and is usable", async (location) => {
    const { vertexConfig } = await load({ ...base, VERTEX_LOCATION: location });
    const cfg = vertexConfig();
    expect(cfg.usable).toBe(true);
    expect(cfg.forbidden).toBe(false);
    expect(cfg.unproven).toBe(false);
  });

  it.each(["global", "GLOBAL", "Global"])("%s is REFUSED — it routes worldwide", async (location) => {
    const { vertexConfig } = await load({ ...base, VERTEX_LOCATION: location });
    const cfg = vertexConfig();
    expect(cfg.forbidden).toBe(true);
    // Not merely flagged. UNUSABLE, so getClient throws rather than quietly
    // building a client that can send a UK caller's utterance to Iowa.
    expect(cfg.usable).toBe(false);
  });

  it.each(["us-central1", "europe-west2", "europe-west4"])(
    "%s is announced as unproven, not refused",
    async (location) => {
      const { vertexConfig } = await load({ ...base, VERTEX_LOCATION: location });
      const cfg = vertexConfig();
      expect(cfg.unproven).toBe(true);
      // A1.2's line: fatal is for "the operator asked for one thing and would
      // get another". `global` is that case. A single region is a plausible
      // deliberate choice for some future model, so it is announced loudly and
      // allowed.
      expect(cfg.usable).toBe(true);
    }
  );

  it("getClient refuses global at CLIENT CONSTRUCTION, not at provider selection", async () => {
    const gemini = await load({ ...base, VERTEX_LOCATION: "global" });
    expect(() => gemini.getClient()).toThrow(/routes requests to whichever region/i);
    // And it built nothing. A guard that throws after construction has already
    // handed the SDK the location it was supposed to reject.
    expect(constructed).toEqual([]);
  });

  it("getClient accepts a multi-region and passes it through", async () => {
    const gemini = await load({ ...base, VERTEX_LOCATION: "eu" });
    gemini.getClient();
    expect(constructed).toEqual([
      {
        vertexai: true,
        project: "p",
        location: "eu",
        // Same as `us`: a multi-region needs the global host, not eu-aiplatform.
        httpOptions: { baseUrl: "https://aiplatform.googleapis.com" },
      },
    ]);
  });
});
