import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerGreetingClipRoute, GREETING_CLIP_PATH } from "../lib/voice/greetingClipRoute.js";
import { greetingClipSpec } from "../lib/voice/greetingClip.js";

// ---------------------------------------------------------------------------
// POST /internal/greeting-clip (pronunciation build, Step 3). The dashboard's
// "Hear greeting" button and its after-save remake both come through here, so
// the voice service stays the ONE place a greeting is composed and rendered --
// the preview is the exact clip a caller hears. Google-signed service identity
// only (the dashboard's service account); fail closed.
// ---------------------------------------------------------------------------

const BIZ = "55c7c8c4-2c33-463c-875a-7f16d6bcc17e";
const ROW = {
  id: BIZ,
  name: "Digile Media",
  phone_number: "+441372656055",
  greeting: "Thanks for calling Digile Media. How can I help you today?",
  timezone: "Europe/London",
  pronunciations: { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } },
};

function setup({ business = ROW, render = vi.fn(async () => Buffer.alloc(8000, 0x7f)) } = {}) {
  const store = new Map();
  const db = {
    withTenant: vi.fn(async (_id, fn) => fn()),
    fetchBusinessById: vi.fn(async () => business),
    fetchBusinessCapabilities: vi.fn(async () => []),
    loadConfig: (b) => ({
      businessId: b.id,
      businessName: b.name,
      greeting: b.greeting,
      _hasCustomGreeting: !!b.greeting,
      timezone: b.timezone,
      pronunciations: b.pronunciations || {},
      locale: null,
      liveVoice: null,
    }),
    fetchGreetingClip: vi.fn(async (id, variant, lang) => store.get(`${id}|${variant}|${lang}`) || null),
    upsertGreetingClip: vi.fn(async (c) => {
      store.set(`${c.businessId}|${c.variant}|${c.languageCode}`, { input_hash: c.inputHash, audio: c.audio });
    }),
  };
  const verifier = { verify: vi.fn(async (h) => (h === "Bearer good" ? { ok: true } : { ok: false, reason: h ? "audience" : "missing" })) };
  const app = express();
  app.use(express.json());
  registerGreetingClipRoute(app, { db, verifier, synthesize: render, env: {}, log: { info: vi.fn(), error: vi.fn() } });
  return { app, db, render, verifier };
}

describe("POST /internal/greeting-clip", () => {
  it("refuses a request with no token (401) or a bad one (403), before touching the database", async () => {
    const { app, db } = setup();
    expect((await request(app).post(GREETING_CLIP_PATH).send({ business_id: BIZ })).status).toBe(401);
    expect((await request(app).post(GREETING_CLIP_PATH).set("Authorization", "Bearer bad").send({ business_id: BIZ })).status).toBe(403);
    expect(db.fetchBusinessById).not.toHaveBeenCalled();
  });

  it("renders the clip the business's calls would play and returns it as a WAV", async () => {
    const { app, render, db } = setup();
    const res = await request(app).post(GREETING_CLIP_PATH).set("Authorization", "Bearer good").send({ business_id: BIZ });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/wav/);
    expect(res.body.subarray(0, 4).toString()).toBe("RIFF");
    // The voice and language a call to this number resolves: +44 -> en-GB, default voice Kore.
    const spec = greetingClipSpec(db.loadConfig(ROW), { languageCode: "en-GB", liveVoice: "Kore", variant: "custom" });
    expect(render).toHaveBeenCalledWith(spec.ssml, "en-GB-Chirp3-HD-Kore");
    expect(db.withTenant.mock.calls.every((c) => c[0] === BIZ)).toBe(true);
  });

  it("does not re-render a clip that is already current", async () => {
    const { app, render } = setup();
    await request(app).post(GREETING_CLIP_PATH).set("Authorization", "Bearer good").send({ business_id: BIZ });
    await request(app).post(GREETING_CLIP_PATH).set("Authorization", "Bearer good").send({ business_id: BIZ });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("404 for an unknown business, 400 for a malformed id", async () => {
    const { app } = setup({ business: null });
    expect((await request(app).post(GREETING_CLIP_PATH).set("Authorization", "Bearer good").send({ business_id: BIZ })).status).toBe(404);
    expect((await request(app).post(GREETING_CLIP_PATH).set("Authorization", "Bearer good").send({ business_id: "x" })).status).toBe(400);
  });

  it("502 when the render fails, never a stale or empty clip", async () => {
    const { app } = setup({ render: vi.fn(async () => Buffer.alloc(0)) });
    const res = await request(app).post(GREETING_CLIP_PATH).set("Authorization", "Bearer good").send({ business_id: BIZ });
    expect(res.status).toBe(502);
  });
});
