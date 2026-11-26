// ---------------------------------------------------------------------------
// Hammersleys round 4 (2026-11-26), item 6: a Deepgram SHADOW transcript.
//
// Live is its own ASR and hears UK place names badly on 8 kHz audio
// (Plaistow -> "Play Store"/"Cresta", Lingfield -> "Springfield"). Before
// anything acts on a second transcript, measure it: stream the caller's raw
// inbound audio to Deepgram (nova-3, keyterms = the business's local names)
// beside Live, change NOTHING the caller hears, and store its final segments
// on the call row (calls.answers._shadow_stt -- never in logs). Off unless
// LIVE_SHADOW_STT says so; never for a healthcare tenant; never outbound;
// only through Deepgram's EU endpoint.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { shadowSttEnabled, shadowKeyterms, createShadowStt } from "../lib/voice/live/shadowStt.js";
import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const BIZ = "7df62558-1f02-4bb9-8918-0f90528de700";
const ON = { LIVE_SHADOW_STT: "on", DEEPGRAM_API_KEY: "k", DEEPGRAM_REGION: "eu" };
const STANDARD = { businessName: "Hammersleys Taxis", complianceTier: "standard" };
const facts = (over = {}) => ({ env: ON, config: STANDARD, businessId: BIZ, outbound: false, hipaa: false, language: "en-GB", ...over });

describe("shadowSttEnabled — every gate must pass", () => {
  it.each([undefined, "", "off", "0", "false", "OFF"])("off when LIVE_SHADOW_STT is %j", (v) => {
    expect(shadowSttEnabled(facts({ env: { ...ON, LIVE_SHADOW_STT: v } })).on).toBe(false);
  });
  it("on for a standard inbound English call through the EU endpoint", () => {
    expect(shadowSttEnabled(facts())).toEqual({ on: true, reason: "on" });
  });
  it("a business-id list scopes it to the listed businesses", () => {
    expect(shadowSttEnabled(facts({ env: { ...ON, LIVE_SHADOW_STT: `other-id, ${BIZ}` } })).on).toBe(true);
    expect(shadowSttEnabled(facts({ env: { ...ON, LIVE_SHADOW_STT: "other-id" } }))).toEqual({ on: false, reason: "not_listed" });
  });
  it("never for a healthcare tenant or a hipaa deployment", () => {
    expect(shadowSttEnabled(facts({ config: { ...STANDARD, complianceTier: "hipaa" } }))).toEqual({ on: false, reason: "healthcare" });
    expect(shadowSttEnabled(facts({ hipaa: true }))).toEqual({ on: false, reason: "healthcare" });
  });
  it("never outbound", () => {
    expect(shadowSttEnabled(facts({ outbound: true }))).toEqual({ on: false, reason: "outbound" });
  });
  it("never outside Deepgram's EU endpoint", () => {
    for (const region of [undefined, "", "us", "US"]) {
      expect(shadowSttEnabled(facts({ env: { ...ON, DEEPGRAM_REGION: region } }))).toEqual({ on: false, reason: "not_eu" });
    }
  });
  it("needs a key and an English call", () => {
    expect(shadowSttEnabled(facts({ env: { ...ON, DEEPGRAM_API_KEY: "" } }))).toEqual({ on: false, reason: "no_key" });
    expect(shadowSttEnabled(facts({ language: "es-ES" }))).toEqual({ on: false, reason: "language" });
  });
});

describe("shadowKeyterms — the business name and its 'Local names' line", () => {
  const info =
    "Hammersleys Taxis Ltd: a family-run taxi firm.\n" +
    "Local names (addresses are usually in these places; if you hear something close to one, say back that one): " +
    "Lingfield, Dormansland, Dormans Park, Felcourt; stations: Lingfield, Dormans, Gatwick Airport, Three Bridges.\n" +
    "Payment: cash or card.";
  it("takes the name and each listed place once, without the labels", () => {
    expect(shadowKeyterms({ businessName: "Hammersleys Taxis", generalInfo: info })).toEqual([
      "Hammersleys Taxis", "Lingfield", "Dormansland", "Dormans Park", "Felcourt", "Dormans", "Gatwick Airport", "Three Bridges",
    ]);
  });
  it("no line: just the business name", () => {
    expect(shadowKeyterms({ businessName: "Brightwork", generalInfo: "Open 9-5." })).toEqual(["Brightwork"]);
  });
  it("caps the list at 50 and drops anything longer than 5 words", () => {
    const many = Array.from({ length: 80 }, (_, i) => `Place${i}`).join(", ");
    const terms = shadowKeyterms({ businessName: "B", generalInfo: `Local names: ${many}, one two three four five six` });
    expect(terms).toHaveLength(50);
    expect(terms.some((t) => t.split(" ").length > 5)).toBe(false);
  });
});

/** A fake of createDeepgramSttStream's handle. */
function fakeConnect({ fail = false, gate } = {}) {
  const calls = [];
  const connect = vi.fn(async (opts) => {
    if (gate) await gate;
    if (fail) throw new Error("connect refused");
    const h = {
      opts,
      audio: [],
      finalized: false,
      sendAudio: vi.fn((b) => h.audio.push(b)),
      close: vi.fn(),
      finalize: vi.fn(async () => {
        h.finalized = true;
      }),
      say: (text, confidence = 0.91) => opts.onFinal?.(text, { confidence }),
    };
    calls.push(h);
    return h;
  });
  return { connect, calls };
}

describe("createShadowStt — beside the call, never in its way", () => {
  it("frames before the connect are dropped and counted; after it, each raw frame goes to Deepgram", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { connect, calls } = fakeConnect({ gate });
    const log = { info: vi.fn(), error: vi.fn() };
    const sh = createShadowStt({ callSid: "CA_s1", language: "en-GB", keyterms: ["Lingfield"], connect, log, now: () => 0 });
    sh.push(Buffer.from([1]));
    release();
    await new Promise((r) => setTimeout(r, 0));
    const f = Buffer.from([2]);
    sh.push(f);
    expect(calls[0].audio).toEqual([f]);
    expect(calls[0].opts).toMatchObject({ language: "en-GB", keyterms: ["Lingfield"], callSid: "CA_s1" });
    const out = await sh.close();
    expect(out.frames_sent).toBe(1);
    expect(out.frames_dropped).toBe(1);
  });

  it("keeps Deepgram's finals with their time and confidence, and finalizes on close", async () => {
    let t = 0;
    const { connect, calls } = fakeConnect();
    const sh = createShadowStt({ callSid: "CA_s2", language: "en-GB", keyterms: [], connect, log: { info: vi.fn(), error: vi.fn() }, now: () => t });
    await new Promise((r) => setTimeout(r, 0));
    t = 4200;
    calls[0].say("5 Plaistow Street, Lingfield.");
    const out = await sh.close();
    expect(calls[0].finalize).toHaveBeenCalled();
    expect(out.segments).toEqual([{ t_ms: 4200, text: "5 Plaistow Street, Lingfield.", conf: 0.91 }]);
  });

  it("push never throws, even when the vendor's send does", async () => {
    const { connect, calls } = fakeConnect();
    const sh = createShadowStt({ callSid: "CA_s3", language: "en-GB", keyterms: [], connect, log: { info: vi.fn(), error: vi.fn() } });
    await new Promise((r) => setTimeout(r, 0));
    calls[0].sendAudio.mockImplementation(() => {
      throw new Error("socket gone");
    });
    expect(() => sh.push(Buffer.from([1]))).not.toThrow();
  });

  it("a failed connect is recorded, and push and close still never throw", async () => {
    const { connect } = fakeConnect({ fail: true });
    const sh = createShadowStt({ callSid: "CA_s4", language: "en-GB", keyterms: [], connect, log: { info: vi.fn(), error: vi.fn() } });
    await new Promise((r) => setTimeout(r, 0));
    expect(() => sh.push(Buffer.from([1]))).not.toThrow();
    expect((await sh.close()).error).toBe("connect_failed");
  });

  it("a connect that lands after the call ended is closed at once", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { connect, calls } = fakeConnect({ gate });
    const sh = createShadowStt({ callSid: "CA_s5", language: "en-GB", keyterms: [], connect, log: { info: vi.fn(), error: vi.fn() }, closeWaitMs: 10 });
    await sh.close();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0].close).toHaveBeenCalled();
  });

  it("logs counts only -- never the caller's words", async () => {
    const { connect, calls } = fakeConnect();
    const log = { info: vi.fn(), error: vi.fn() };
    const sh = createShadowStt({ callSid: "CA_s6", language: "en-GB", keyterms: [], connect, log });
    await new Promise((r) => setTimeout(r, 0));
    calls[0].say("my name is Sam Price");
    await sh.close();
    const logged = JSON.stringify([...log.info.mock.calls, ...log.error.mock.calls]);
    expect(logged).toContain("live_shadow_stt");
    expect(logged).not.toContain("Sam Price");
  });
});

describe("the engine wiring", () => {
  beforeEach(() => clearStats());
  const CONFIG = {
    businessName: "Hammersleys Taxis",
    mainPhone: "+14692810667",
    timezone: "Europe/London",
    locale: "en-GB",
    allowedTasks: ["general_question", "take_message"],
    capabilities: {},
    generalInfo: "Local names: Lingfield, Dormansland.",
    complianceTier: "standard",
  };

  async function call({ env, config = CONFIG }) {
    const { connect, calls } = fakeConnect();
    const db = { ...fakeDb(config, BIZ), mergeCallAnswers: vi.fn(async () => {}), withTenantSafe: vi.fn(async (_id, fn) => fn()) };
    const s = await bootLive({ config, businessId: BIZ, callSid: "CA_shadow", env, database: db, shadowConnect: connect });
    await new Promise((r) => setTimeout(r, 0));
    await s.feed(400, { voiced: true });
    await s.feed(200);
    s.ws.emit("close");
    await vi.waitFor(() => expect(true).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    return { s, db, connect, calls };
  }

  it("off by default: Deepgram is never contacted and nothing is written", async () => {
    const { connect, db } = await call({ env: {} });
    expect(connect).not.toHaveBeenCalled();
    expect(db.mergeCallAnswers.mock.calls.some(([, p]) => p && "_shadow_stt" in p)).toBe(false);
  });

  it("on: every raw inbound frame goes to Deepgram, keyterms from the business, segments saved on the call row", async () => {
    const { connect, calls, db } = await call({ env: ON });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(calls[0].opts.keyterms).toEqual(["Hammersleys Taxis", "Lingfield", "Dormansland"]);
    expect(calls[0].opts.language).toMatch(/^en/);
    expect(calls[0].audio.length).toBe(30); // 400 + 200 ms of 20 ms frames
    expect(calls[0].finalized).toBe(true);
    const write = db.mergeCallAnswers.mock.calls.find(([, p]) => p && "_shadow_stt" in p);
    expect(write?.[0]).toBe("CA_shadow");
    expect(write?.[1]._shadow_stt).toMatchObject({ v: 1, segments: [], frames_sent: 30 });
    expect(db.withTenantSafe.mock.calls.some(([id, , o]) => id === BIZ && o?.operation === "shadow_stt")).toBe(true);
  });

  it("never for a healthcare tenant, even when switched on", async () => {
    const { connect } = await call({ env: ON, config: { ...CONFIG, complianceTier: "hipaa" } });
    expect(connect).not.toHaveBeenCalled();
  });
});
