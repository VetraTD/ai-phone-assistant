import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// The VOICE path, on Vertex, with no API key.
//
// tests/vertexBackend.test.js proves getClient() picks the right backend. That
// was not enough, and the gap cost a live call.
//
// `getReplyStreaming` — the ONLY LLM entry point the phone pipeline uses —
// carried its own guard:
//
//     const apiKey = process.env.GEMINI_API_KEY;
//     if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
//     const gemini = getClient();
//
// It demanded the key BEFORE asking the factory that knows about Vertex. So a
// correctly configured covered deployment — VERTEX_ENABLED=true, no API key,
// because the Gemini Developer API is not BAA-covered and must not be present —
// threw on every single turn. Two in a row tripped the fallback threshold and
// the caller was handed to the take-a-message script, which is exactly what a
// real call did.
//
// A8 removed the same unconditional requirement from server.js's boot check and
// did not reach this one. Nothing caught it because the eval harness and every
// local run have GEMINI_API_KEY set, so the guard is invisible off Cloud Run.
//
// The assertion that matters is the first one: the voice path RUNS with no API
// key when Vertex is enabled.
// ---------------------------------------------------------------------------

const ENV = ["VERTEX_ENABLED", "GOOGLE_CLOUD_PROJECT", "VERTEX_LOCATION", "GEMINI_API_KEY", "DEPLOYMENT_MODE"];
const saved = {};

const H = vi.hoisted(() => ({ constructed: [], sent: [] }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(opts) {
      H.constructed.push(opts);
      this.chats = {
        create: () => ({
          async sendMessageStream({ message }) {
            H.sent.push(message);
            return (async function* () {
              yield { text: "Sure, I can help with that." };
            })();
          },
        }),
      };
    }
  },
  Type: {},
}));

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: () => "req-test",
}));

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  H.constructed.length = 0;
  H.sent.length = 0;
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

/** Drain the generator far enough to prove it started without throwing. */
async function firstChunk(gen) {
  for await (const chunk of gen) return chunk;
  return null;
}

describe("getReplyStreaming on Vertex", () => {
  it("RUNS with no GEMINI_API_KEY when Vertex is enabled — the bug that hit a live call", async () => {
    for (const k of ENV) delete process.env[k];
    process.env.VERTEX_ENABLED = "true";
    process.env.GOOGLE_CLOUD_PROJECT = "vetra-us-staging-c3a3bd";
    process.env.VERTEX_LOCATION = "us";
    vi.resetModules();

    const { getReplyStreaming } = await import("../services/gemini.js");
    const gen = getReplyStreaming([], "I'd like to book an appointment", "identify_intent", null);

    // Before the fix this rejected with "GEMINI_API_KEY is not set" on every
    // turn, and two turns tripped the take-a-message fallback.
    await expect(firstChunk(gen)).resolves.toBeTruthy();

    // And it really went to Vertex rather than quietly using a key.
    expect(H.constructed[0]).toMatchObject({ vertexai: true, project: "vetra-us-staging-c3a3bd" });
    expect(H.constructed[0].apiKey).toBeUndefined();
  });

  it("still refuses when NEITHER Vertex nor an API key is configured", async () => {
    // The guard was not pointless — a deployment with no backend at all must
    // fail loudly rather than produce silence on a call.
    for (const k of ENV) delete process.env[k];
    vi.resetModules();

    const { getReplyStreaming } = await import("../services/gemini.js");
    const gen = getReplyStreaming([], "hello", "identify_intent", null);

    await expect(firstChunk(gen)).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("uses the API key when Vertex is NOT enabled", async () => {
    for (const k of ENV) delete process.env[k];
    process.env.GEMINI_API_KEY = "test-key";
    vi.resetModules();

    const { getReplyStreaming } = await import("../services/gemini.js");
    await expect(firstChunk(getReplyStreaming([], "hello", "identify_intent", null))).resolves.toBeTruthy();
    expect(H.constructed[0]).toMatchObject({ apiKey: "test-key" });
    expect(H.constructed[0].vertexai).toBeFalsy();
  });

  it("the voice path has no API-key guard of its own left in the source", async () => {
    // The defect was a SECOND guard, upstream of the factory that knows about
    // Vertex. getClient() is the one place allowed to decide what a backend
    // needs; anything else duplicating that decision will drift from it again.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../services/gemini.js", import.meta.url)), "utf8");

    const guards = src.match(/GEMINI_API_KEY is not set/g) || [];
    expect(guards).toHaveLength(1); // getClient's, and only getClient's

    const streamingStart = src.indexOf("export async function* getReplyStreaming");
    const streamingBody = src.slice(streamingStart, streamingStart + 1200);
    expect(streamingBody).not.toMatch(/GEMINI_API_KEY is not set/);
  });
});
