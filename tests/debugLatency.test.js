import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTurnMetrics, clearStats, getLatencyStats } from "../lib/voice/metrics.js";

// GET /api/debug/latency doesn't touch supabase/notifications/gemini at all
// (see server.js) — no need to mock those services here, unlike
// tests/degradedMode.test.js / tests/phone-numbers-api.test.js which do hit
// DB-backed routes. Only the access gate and getLatencyStats() wiring are
// under test.

// server.js's cold import pulls in a large dependency graph — see
// tests/degradedMode.test.js / tests/phone-numbers-api.test.js for why this
// is hoisted to beforeAll with a generous hookTimeout instead of imported
// lazily inside each it().
let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

const originalDebugEndpoints = process.env.DEBUG_ENDPOINTS;
const originalDebugToken = process.env.DEBUG_TOKEN;
const TOKEN = "s3cret-probe-token";

beforeEach(() => {
  clearStats();
});

afterEach(() => {
  if (originalDebugEndpoints === undefined) delete process.env.DEBUG_ENDPOINTS;
  else process.env.DEBUG_ENDPOINTS = originalDebugEndpoints;
  if (originalDebugToken === undefined) delete process.env.DEBUG_TOKEN;
  else process.env.DEBUG_TOKEN = originalDebugToken;
});

/** Enable the endpoints the way a measurement run would. */
function enableDebug() {
  process.env.DEBUG_ENDPOINTS = "true";
  process.env.DEBUG_TOKEN = TOKEN;
}

function recordTurn(callSid, ms) {
  const tracker = createTurnMetrics(callSid);
  tracker.mark("speech_end", 0);
  tracker.mark("first_audio_sent", ms);
  tracker.finishTurn();
}

describe("GET /api/debug/latency", () => {
  it("404s when DEBUG_ENDPOINTS is unset", async () => {
    delete process.env.DEBUG_ENDPOINTS;
    const res = await request(app).get("/api/debug/latency");
    expect(res.status).toBe(404);
  });

  it('404s when DEBUG_ENDPOINTS is not exactly "true"', async () => {
    process.env.DEBUG_ENDPOINTS = "1";
    process.env.DEBUG_TOKEN = TOKEN;
    const res = await request(app).get("/api/debug/latency").set("x-debug-token", TOKEN);
    expect(res.status).toBe(404);
  });

  it("returns JSON latency stats for an authorized request", async () => {
    enableDebug();
    recordTurn("CA-debug-1", 400);

    const res = await request(app).get("/api/debug/latency").set("x-debug-token", TOKEN);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.count).toBe(1);
    expect(res.body.byStage.voice_to_voice_ms.p50).toBe(400);
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it("reports the new out-of-process stages and the cache summary", async () => {
    enableDebug();
    recordTurn("CA-debug-2", 400);

    const res = await request(app).get("/api/debug/latency").set("x-debug-token", TOKEN);

    expect(res.body.byStage).toHaveProperty("stt_endpoint_ms");
    expect(res.body.byStage).toHaveProperty("playout_ms");
    expect(res.body.byStage).toHaveProperty("true_v2v_ms");
    expect(res.body).toHaveProperty("holdRules");
    expect(res.body).toHaveProperty("cache");
  });
});

// ---------------------------------------------------------------------------
// The endpoint is enabled on a PUBLIC deployed host for the duration of a
// measurement run. DEBUG_ENDPOINTS alone is a single env flag away from
// serving call SIDs and infrastructure timing to anyone who guesses the path,
// so a token is required as well and a failed check is indistinguishable from
// the route not existing.
// ---------------------------------------------------------------------------
describe("GET /api/debug/latency — access control", () => {
  it("fails closed when DEBUG_ENDPOINTS is on but no DEBUG_TOKEN is configured", async () => {
    process.env.DEBUG_ENDPOINTS = "true";
    delete process.env.DEBUG_TOKEN;

    const res = await request(app).get("/api/debug/latency");

    expect(res.status).toBe(404);
  });

  it("404s when the token header is missing", async () => {
    enableDebug();
    const res = await request(app).get("/api/debug/latency");
    expect(res.status).toBe(404);
  });

  it("404s — not 401 — on a wrong token, so the route is not advertised", async () => {
    enableDebug();
    const res = await request(app).get("/api/debug/latency").set("x-debug-token", "wrong-token");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({});
  });

  it("404s rather than erroring when the supplied token is a different length", async () => {
    // A naive timingSafeEqual on raw buffers throws on length mismatch, which
    // would surface as a 500 and confirm the route exists.
    enableDebug();
    const res = await request(app).get("/api/debug/latency").set("x-debug-token", "x");
    expect(res.status).toBe(404);
  });

  it("does not leak stats through a body on a rejected request", async () => {
    enableDebug();
    recordTurn("CA-secret", 400);

    const res = await request(app).get("/api/debug/latency").set("x-debug-token", "wrong");

    expect(res.text).not.toMatch(/CA-secret/);
  });
});

// ---------------------------------------------------------------------------
// The probe leg runs on the deployed server, but the caller audio is
// synthesized on the operator's machine, so it has to be uploaded. Doing it
// this way means both ends provably play the same bytes — no dependency on TTS
// being configured on the server, and no chance two runs differ because the
// audio did rather than because the system did.
// ---------------------------------------------------------------------------
describe("POST /api/debug/probe-script", () => {
  const line = { label: "hello", audioBase64: Buffer.alloc(800, 0x10).toString("base64") };

  it("installs an uploaded script and reports its duration", async () => {
    enableDebug();

    const res = await request(app)
      .post("/api/debug/probe-script")
      .set("x-debug-token", TOKEN)
      .send({ lines: [line] });

    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.lines).toBe(1);
    expect(res.body.seconds).toBeCloseTo(0.1, 2); // 800 bytes @ 8kHz
  });

  it("404s without a valid token", async () => {
    enableDebug();
    const res = await request(app).post("/api/debug/probe-script").send({ lines: [line] });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed script rather than accepting a silent run", async () => {
    enableDebug();

    const res = await request(app)
      .post("/api/debug/probe-script")
      .set("x-debug-token", TOKEN)
      .send({ lines: [{ label: "no-audio" }] });

    expect(res.status).toBe(400);
  });

  it("rejects an empty script", async () => {
    enableDebug();
    const res = await request(app)
      .post("/api/debug/probe-script")
      .set("x-debug-token", TOKEN)
      .send({ lines: [] });
    expect(res.status).toBe(400);
  });

  it("accepts a payload larger than the global 100kb json limit", async () => {
    // The real script is a few hundred kb of mu-law; the default express.json
    // cap would 413 it, and the failure would only show up mid-run.
    enableDebug();
    const big = { label: "long", audioBase64: Buffer.alloc(300_000, 0x10).toString("base64") };

    const res = await request(app)
      .post("/api/debug/probe-script")
      .set("x-debug-token", TOKEN)
      .send({ lines: [big] });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The ring buffer is process-lifetime, so consecutive measurement runs would
// otherwise pool together and blur a before/after comparison.
// ---------------------------------------------------------------------------
describe("POST /api/debug/latency/reset", () => {
  it("empties the ring buffer for an authorized request", async () => {
    enableDebug();
    recordTurn("CA-reset-1", 400);
    expect(getLatencyStats().count).toBe(1);

    const res = await request(app)
      .post("/api/debug/latency/reset")
      .set("x-debug-token", TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true });
    expect(getLatencyStats().count).toBe(0);
  });

  it("404s without a valid token and leaves the buffer intact", async () => {
    enableDebug();
    recordTurn("CA-reset-2", 400);

    const res = await request(app).post("/api/debug/latency/reset");

    expect(res.status).toBe(404);
    expect(getLatencyStats().count).toBe(1);
  });

  it("404s when DEBUG_ENDPOINTS is off", async () => {
    delete process.env.DEBUG_ENDPOINTS;
    const res = await request(app).post("/api/debug/latency/reset").set("x-debug-token", TOKEN);
    expect(res.status).toBe(404);
  });
});
