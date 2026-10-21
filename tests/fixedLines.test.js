import { describe, it, expect, vi } from "vitest";
import { lineClipSpec, createFixedLineClips, FIXED_LINE_KEYS } from "../lib/voice/fixedLines.js";
import { CALL_LINES, buildMessageTwiml, buildHangupLineTwiml } from "../lib/twiml.js";

// ---------------------------------------------------------------------------
// LVX174: the fixed lines (CALL_LINES) in the receptionist's voice -- Google
// TTS in the Chirp 3 HD voice with the live voice's name, the owner's pick by
// ear (2026-10-20). Polly stays the fallback whenever a clip is not ready.
// The lines are generic (no business, no caller), so a clip is served by its
// content hash and shared by every business on that voice and language.
// ---------------------------------------------------------------------------

const V = { languageCode: "en-GB", liveVoice: "Kore" };

describe("lineClipSpec", () => {
  it("renders the line's exact text in the Chirp 3 HD voice with the live voice's name", () => {
    const s = lineClipSpec("technical", V);
    expect(s.text).toBe(CALL_LINES.technical);
    expect(s.ttsVoice).toBe("en-GB-Chirp3-HD-Kore");
    expect(s.ssml).toBe(`<speak>${CALL_LINES.technical.replace(/'/g, "'")}</speak>`);
    expect(s.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("has a different hash per line, voice and language", () => {
    const h = lineClipSpec("technical", V).hash;
    expect(lineClipSpec("noAnswer", V).hash).not.toBe(h);
    expect(lineClipSpec("technical", { ...V, liveVoice: "Aoede" }).hash).not.toBe(h);
    expect(lineClipSpec("technical", { ...V, languageCode: "en-US" }).hash).not.toBe(h);
  });

  it("covers every CALL_LINES key", () => {
    expect([...FIXED_LINE_KEYS].sort()).toEqual(Object.keys(CALL_LINES).sort());
  });
});

function fakeDb(rows = []) {
  const store = new Map(rows.map((r) => [r.hash, r]));
  return {
    store,
    fetchFixedLineClips: vi.fn(async (hashes) => hashes.map((h) => store.get(h)).filter(Boolean)),
    upsertFixedLineClip: vi.fn(async (r) => store.set(r.hash, { hash: r.hash, audio: r.audio })),
  };
}
const quiet = { info: vi.fn(), error: vi.fn() };
const BASE = "https://voice.example.test";

describe("createFixedLineClips", () => {
  it("has no URL for a line until prepare() has loaded it -- the caller then gets Polly", () => {
    const lines = createFixedLineClips({ database: fakeDb(), synthesize: vi.fn(), baseUrl: BASE, log: quiet });
    expect(lines.urlFor("technical", V)).toBeNull();
  });

  it("prepare() loads stored clips, and urlFor then names the clip by its hash", async () => {
    const all = FIXED_LINE_KEYS.map((k) => ({ hash: lineClipSpec(k, V).hash, audio: Buffer.alloc(800, 0x7f) }));
    const db = fakeDb(all);
    const synthesize = vi.fn();
    const lines = createFixedLineClips({ database: db, synthesize, baseUrl: BASE, log: quiet });
    await lines.prepare(V);
    expect(lines.urlFor("technical", V)).toBe(`${BASE}/media/line/${lineClipSpec("technical", V).hash}.wav`);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("prepare() renders and stores any line that is missing", async () => {
    const db = fakeDb();
    const synthesize = vi.fn(async () => Buffer.alloc(800, 0x7f));
    const lines = createFixedLineClips({ database: db, synthesize, baseUrl: BASE, log: quiet });
    await lines.prepare(V);
    expect(synthesize).toHaveBeenCalledTimes(FIXED_LINE_KEYS.length);
    expect(synthesize).toHaveBeenCalledWith(lineClipSpec("timeUp", V).ssml, "en-GB-Chirp3-HD-Kore");
    expect(db.upsertFixedLineClip).toHaveBeenCalledTimes(FIXED_LINE_KEYS.length);
    expect(lines.urlFor("timeUp", V)).not.toBeNull();
  });

  it("a line whose render fails stays on Polly; the others still get clips", async () => {
    const db = fakeDb();
    const bad = lineClipSpec("noAnswer", V).ssml;
    const synthesize = vi.fn(async (ssml) => (ssml === bad ? Buffer.alloc(0) : Buffer.alloc(800, 0x7f)));
    const lines = createFixedLineClips({ database: db, synthesize, baseUrl: BASE, log: quiet });
    await lines.prepare(V);
    expect(lines.urlFor("noAnswer", V)).toBeNull();
    expect(lines.urlFor("technical", V)).not.toBeNull();
  });

  it("audioFor() serves a clip by hash from memory or the database, and nothing for an unknown hash", async () => {
    const h = lineClipSpec("technical", V).hash;
    const db = fakeDb([{ hash: h, audio: Buffer.alloc(800, 0x7f) }]);
    const lines = createFixedLineClips({ database: db, synthesize: vi.fn(), baseUrl: BASE, log: quiet });
    expect((await lines.audioFor(h)).length).toBe(800);
    expect(await lines.audioFor("0".repeat(32))).toBeNull();
    expect(await lines.audioFor("not-a-hash")).toBeNull();
  });

  it("disabled: prepare does nothing and every line stays on Polly", async () => {
    const db = fakeDb();
    const lines = createFixedLineClips({ database: db, synthesize: vi.fn(), baseUrl: BASE, log: quiet, enabled: false });
    await lines.prepare(V);
    expect(db.fetchFixedLineClips).not.toHaveBeenCalled();
    expect(lines.urlFor("technical", V)).toBeNull();
  });
});

describe("TwiML with a clip", () => {
  it("plays the clip instead of saying the line", () => {
    const t = buildHangupLineTwiml({ line: CALL_LINES.timeUp, sayVoice: "Polly.Amy", playUrl: `${BASE}/media/line/abc.wav` });
    expect(t).toBe(`<Response><Play>${BASE}/media/line/abc.wav</Play><Hangup/></Response>`);
    const m = buildMessageTwiml({ line: CALL_LINES.technical, playUrl: `${BASE}/media/line/abc.wav`, callbackUrl: "https://cb", actionUrl: "https://done" });
    expect(m).toContain(`<Play>${BASE}/media/line/abc.wav</Play><Record`);
    expect(m).not.toContain("<Say");
  });

  it("says the line in Polly when there is no clip, exactly as before", () => {
    expect(buildHangupLineTwiml({ line: CALL_LINES.timeUp, sayVoice: "Polly.Amy" })).toContain('<Say voice="Polly.Amy">');
  });
});

describe("fixed-line render failures (Opus review)", () => {
  it("a line whose render failed is not re-rendered on every call for a while", async () => {
    const db = fakeDb();
    const synthesize = vi.fn(async () => Buffer.alloc(0));
    const lines = createFixedLineClips({ database: db, synthesize, baseUrl: BASE, log: quiet });
    const v = { languageCode: "en-US", liveVoice: "Leda" };
    await lines.prepare(v);
    await lines.prepare(v);
    expect(synthesize).toHaveBeenCalledTimes(FIXED_LINE_KEYS.length);
  });
});
