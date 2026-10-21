import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// LVX174 on the REAL app: GET /media/line/<hash>.wav serves a stored clip to
// Twilio's <Play>, and the transfer no-answer line plays its clip when one is
// stored for the business's voice and language (Polly otherwise).
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.BASE_URL = "https://test.example.com";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";
process.env.FIXED_LINE_CLIPS = "on";

const clips = vi.hoisted(() => new Map());
const mockLookup = vi.fn(async () => null);
vi.mock("../services/db.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isEnabled: () => true,
    lookupBusinessByPhone: (...a) => mockLookup(...a),
    endPendingDial: async () => 1,
    loadConfig: (...a) => actual.loadConfig(...a),
    fetchFixedLineClips: async (hashes) => hashes.filter((h) => clips.has(h)).map((h) => ({ hash: h, audio: clips.get(h) })),
    upsertFixedLineClip: async () => {},
  };
});
vi.mock("../services/googleTts.js", async (importOriginal) => ({
  ...(await importOriginal()),
  synthesizeSsmlMulaw: async () => Buffer.alloc(0), // never reaches the vendor; an empty render is refused
}));

import { lineClipSpec, FIXED_LINE_KEYS } from "../lib/voice/fixedLines.js";

const UK = "+441372656055";
const V = { languageCode: "en-GB", liveVoice: "Kore" };
let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 30000);
beforeEach(() => {
  clips.clear();
  mockLookup.mockReset().mockResolvedValue(null);
});

describe("GET /media/line/:hash.wav", () => {
  it("serves a stored clip as a WAV", async () => {
    const h = lineClipSpec("technical", V).hash;
    clips.set(h, Buffer.alloc(800, 0x7f));
    const res = await request(app).get(`/media/line/${h}.wav`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/wav/);
    expect(res.body.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("404s an unknown or malformed hash", async () => {
    expect((await request(app).get(`/media/line/${"0".repeat(32)}.wav`)).status).toBe(404);
    expect((await request(app).get(`/media/line/nope.wav`)).status).toBe(404);
  });
});

describe("POST /twilio/transfer-result with a stored no-answer clip", () => {
  const post = () =>
    request(app).post("/twilio/transfer-result").type("form").send({ CallSid: "CA_fl_1", To: UK, From: "+447700900123", DialCallStatus: "no-answer" });

  it("plays the clip in the business's voice and language", async () => {
    for (const k of FIXED_LINE_KEYS) clips.set(lineClipSpec(k, V).hash, Buffer.alloc(800, 0x7f));
    mockLookup.mockResolvedValue({ id: "55c7c8c4-2c33-463c-875a-7f16d6bcc17e", name: "Digile Media", phone_number: UK, locale: "en-GB" });
    const res = await post();
    expect(res.text).toContain(`<Play>https://test.example.com/media/line/${lineClipSpec("noAnswer", V).hash}.wav</Play>`);
    expect(res.text).toContain("<Record");
  });

  it("no clip: Polly says the line, as before", async () => {
    // A voice no earlier test stored a clip for: the store keeps clips in memory
    // for the life of the process, by design.
    mockLookup.mockResolvedValue({ id: "55c7c8c4-2c33-463c-875a-7f16d6bcc17e", name: "Digile Media", phone_number: UK, locale: "en-GB", live_voice: "Aoede" });
    const res = await post();
    expect(res.text).toContain("<Say");
    expect(res.text).not.toContain("<Play>");
  });
});
