import { describe, it, expect, vi } from "vitest";
import { greetingVariant, greetingClipSpec, loadGreetingClip, ensureGreetingClips } from "../lib/voice/greetingClip.js";
import { toSsml } from "../lib/voice/pronunciation.js";
import { greetingTextFor } from "../lib/voice/greeting.js";

// ---------------------------------------------------------------------------
// The recorded greeting (pronunciation build, Step 2). Owner, 2026-10-20: the
// greeting is a Google TTS clip in the voice with the same name as the live
// voice, with the business name said from its phonetic spelling. A clip may
// only play if it was made from EXACTLY what the AI would say now -- anything
// else falls back to the AI speaking the greeting itself.
// ---------------------------------------------------------------------------

const DIGILE = {
  businessId: "biz-1",
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media. How can I help you today?",
  _hasCustomGreeting: true,
  timezone: "Europe/London",
  pronunciations: { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } },
};
const AT = new Date("2026-10-21T09:30:00Z"); // 10:30 in London (BST)

describe("toSsml", () => {
  it("wraps a name that has a phonetic spelling in <phoneme>, written letters inside", () => {
    expect(toSsml("Thanks for calling Digile Media.", DIGILE.pronunciations)).toBe(
      '<speak>Thanks for calling <phoneme alphabet="ipa" ph="ˈdɪdʒaɪl">Digile</phoneme> Media.</speak>'
    );
  });

  it("uses the spoken spelling when there is no phonetic one", () => {
    expect(toSsml("Thanks for calling Digile Media.", { Digile: "Dij-aisle" })).toBe("<speak>Thanks for calling Dij-aisle Media.</speak>");
  });

  it("escapes everything else as XML", () => {
    expect(toSsml("Smith & Sons <Ltd>", {})).toBe("<speak>Smith &amp; Sons &lt;Ltd&gt;</speak>");
  });
});

describe("greetingTextFor at a given hour", () => {
  it("uses the hour it is given for the time-of-day default greeting", () => {
    const plain = { businessName: "Acme", timezone: "America/Chicago" };
    expect(greetingTextFor(plain, { hour: 9 })).toMatch(/^Good morning/);
    expect(greetingTextFor(plain, { hour: 14 })).toMatch(/^Good afternoon/);
    expect(greetingTextFor(plain, { hour: 19 })).toMatch(/^Good evening/);
  });
});

describe("greetingVariant", () => {
  it("is 'custom' for a business's own greeting", () => {
    expect(greetingVariant(DIGILE, AT)).toBe("custom");
  });

  it("follows the business's own clock for the default greeting", () => {
    const plain = { businessName: "Acme", timezone: "Europe/London" };
    expect(greetingVariant(plain, new Date("2026-10-21T09:30:00Z"))).toBe("morning"); // 10:30 BST
    expect(greetingVariant(plain, new Date("2026-10-21T13:30:00Z"))).toBe("afternoon"); // 14:30
    expect(greetingVariant(plain, new Date("2026-10-21T17:30:00Z"))).toBe("evening"); // 18:30
  });
});

describe("greetingClipSpec", () => {
  const spec = (config = DIGILE, o = {}) =>
    greetingClipSpec(config, { languageCode: "en-GB", liveVoice: "Kore", variant: "custom", ...o });

  it("renders in the Chirp 3 HD voice with the live voice's name", () => {
    expect(spec().ttsVoice).toBe("en-GB-Chirp3-HD-Kore");
  });

  it("carries the written greeting, the spoken one the model is told it said, and the SSML", () => {
    const s = spec();
    expect(s.writtenText).toBe("Thanks for calling Digile Media. How can I help you today?");
    expect(s.spokenText).toBe("Thanks for calling Dij-aisle Media. How can I help you today?");
    expect(s.ssml).toContain('<phoneme alphabet="ipa" ph="ˈdɪdʒaɪl">Digile</phoneme>');
  });

  it("changes its hash when the greeting, the voice, the language or the pronunciation changes", () => {
    const base = spec().hash;
    expect(spec({ ...DIGILE, greeting: "Hello from Digile Media." }).hash).not.toBe(base);
    expect(spec(DIGILE, { liveVoice: "Aoede" }).hash).not.toBe(base);
    expect(spec(DIGILE, { languageCode: "en-US" }).hash).not.toBe(base);
    expect(spec({ ...DIGILE, pronunciations: { Digile: "Didge-isle" } }).hash).not.toBe(base);
    expect(spec().hash).toBe(base);
  });

  it("makes each time-of-day variant from the default greeting", () => {
    const plain = { businessName: "Acme", timezone: "Europe/London" };
    expect(spec(plain, { variant: "morning" }).writtenText).toMatch(/^Good morning/);
    expect(spec(plain, { variant: "evening" }).writtenText).toMatch(/^Good evening/);
  });
});

function fakeDb(row) {
  return {
    withTenantSafe: vi.fn(async (_id, fn) => fn()),
    withTenant: vi.fn(async (_id, fn) => fn()),
    fetchGreetingClip: vi.fn(async () => row),
    upsertGreetingClip: vi.fn(async () => {}),
  };
}
const quiet = { info: vi.fn(), error: vi.fn() };

describe("loadGreetingClip", () => {
  const args = (database, extra = {}) => ({
    database,
    businessId: "biz-1",
    config: DIGILE,
    languageCode: "en-GB",
    liveVoice: "Kore",
    now: AT,
    log: quiet,
    synthesize: vi.fn(async () => Buffer.alloc(800, 0xff)),
    ...extra,
  });

  it("returns the clip when it was made from exactly this greeting, voice and language", async () => {
    const want = greetingClipSpec(DIGILE, { languageCode: "en-GB", liveVoice: "Kore", variant: "custom" });
    const db = fakeDb({ input_hash: want.hash, audio: Buffer.alloc(1600, 0xff) });
    const clip = await loadGreetingClip(args(db));
    expect(clip.audio.length).toBe(1600);
    expect(clip.spokenText).toBe(want.spokenText);
    expect(clip.writtenText).toBe(want.writtenText);
    expect(db.fetchGreetingClip).toHaveBeenCalledWith("biz-1", "custom", "en-GB");
  });

  it("refuses a stale clip, and remakes it in the background for the next call", async () => {
    const db = fakeDb({ input_hash: "stale", audio: Buffer.alloc(1600, 0xff) });
    const a = args(db);
    expect(await loadGreetingClip(a)).toBeNull();
    await vi.waitFor(() => expect(db.upsertGreetingClip).toHaveBeenCalled());
    expect(a.synthesize).toHaveBeenCalledWith(expect.stringContaining("<phoneme"), "en-GB-Chirp3-HD-Kore");
  });

  it("falls back (null) when the read is slower than the pickup can wait", async () => {
    const db = fakeDb(null);
    db.fetchGreetingClip = vi.fn(() => new Promise(() => {}));
    expect(await loadGreetingClip(args(db, { timeoutMs: 20 }))).toBeNull();
  });

  it("falls back (null) when the read fails", async () => {
    const db = fakeDb(null);
    db.fetchGreetingClip = vi.fn(async () => {
      throw new Error("db down");
    });
    expect(await loadGreetingClip(args(db))).toBeNull();
  });
});

describe("ensureGreetingClips", () => {
  it("renders the three time-of-day clips for a business on the default greeting", async () => {
    const db = fakeDb(null);
    const synthesize = vi.fn(async () => Buffer.alloc(800, 0xff));
    const plain = { businessName: "Acme", timezone: "Europe/London", pronunciations: {} };
    const made = await ensureGreetingClips({ database: db, businessId: "biz-2", config: plain, languageCode: "en-GB", liveVoice: "Kore", synthesize, log: quiet });
    expect(made.sort()).toEqual(["afternoon", "evening", "morning"]);
    expect(db.upsertGreetingClip).toHaveBeenCalledTimes(3);
  });

  it("does not re-render a clip that is already current", async () => {
    const want = greetingClipSpec(DIGILE, { languageCode: "en-GB", liveVoice: "Kore", variant: "custom" });
    const db = fakeDb({ input_hash: want.hash, audio: Buffer.alloc(1600, 0xff) });
    const synthesize = vi.fn();
    const made = await ensureGreetingClips({ database: db, businessId: "biz-1", config: DIGILE, languageCode: "en-GB", liveVoice: "Kore", synthesize, log: quiet });
    expect(made).toEqual([]);
    expect(synthesize).not.toHaveBeenCalled();
  });
});
