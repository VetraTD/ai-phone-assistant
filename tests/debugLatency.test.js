import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTurnMetrics, clearStats } from "../lib/voice/metrics.js";

// GET /api/debug/latency doesn't touch supabase/notifications/gemini at all
// (see server.js) — no need to mock those services here, unlike
// tests/degradedMode.test.js / tests/phone-numbers-api.test.js which do hit
// DB-backed routes. Only DEBUG_ENDPOINTS gating and getLatencyStats() wiring
// are under test.

// server.js's cold import pulls in a large dependency graph — see
// tests/degradedMode.test.js / tests/phone-numbers-api.test.js for why this
// is hoisted to beforeAll with a generous hookTimeout instead of imported
// lazily inside each it().
let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

const originalDebugEndpoints = process.env.DEBUG_ENDPOINTS;

beforeEach(() => {
  clearStats();
});

afterEach(() => {
  if (originalDebugEndpoints === undefined) delete process.env.DEBUG_ENDPOINTS;
  else process.env.DEBUG_ENDPOINTS = originalDebugEndpoints;
});

describe("GET /api/debug/latency", () => {
  it("404s when DEBUG_ENDPOINTS is unset", async () => {
    delete process.env.DEBUG_ENDPOINTS;
    const res = await request(app).get("/api/debug/latency");
    expect(res.status).toBe(404);
  });

  it('404s when DEBUG_ENDPOINTS is not exactly "true"', async () => {
    process.env.DEBUG_ENDPOINTS = "1";
    const res = await request(app).get("/api/debug/latency");
    expect(res.status).toBe(404);
  });

  it("returns JSON latency stats when DEBUG_ENDPOINTS=true", async () => {
    process.env.DEBUG_ENDPOINTS = "true";

    const tracker = createTurnMetrics("CA-debug-1");
    tracker.mark("speech_end", 0);
    tracker.mark("first_audio_sent", 400);
    tracker.finishTurn();

    const res = await request(app).get("/api/debug/latency");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.count).toBe(1);
    expect(res.body.byStage.voice_to_voice_ms.p50).toBe(400);
    expect(Array.isArray(res.body.recent)).toBe(true);
  });
});
