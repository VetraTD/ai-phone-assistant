import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveLocale, resolveGoogleVoice, resolveRingTone, resolveSpeechLocale } from "../lib/voice/voiceLocale.js";

const BELLA_US = "hpp4J3VqNfWAUOO0d1Us"; // accent: american
const ALICE_GB = "Xb7hH8MSUJpSbSDYk0k2"; // accent: british

describe("voiceLocale.js — locale resolution", () => {
  let savedDefault;
  beforeEach(() => {
    savedDefault = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  });
  afterEach(() => {
    if (savedDefault === undefined) delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    else process.env.ELEVENLABS_DEFAULT_VOICE_ID = savedDefault;
  });

  it("American ElevenLabs voice → en-US", () => {
    const config = { voiceId: BELLA_US, languagesSpoken: ["en"], timezone: "America/Chicago" };
    expect(resolveLocale(config)).toBe("en-US");
    expect(resolveGoogleVoice(config)).toBe("en-US-Chirp3-HD-Aoede");
    expect(resolveRingTone(config)).toBe("us");
  });

  it("British ElevenLabs voice → en-GB even in a US timezone", () => {
    const config = { voiceId: ALICE_GB, languagesSpoken: ["en"], timezone: "America/New_York" };
    expect(resolveLocale(config)).toBe("en-GB");
    expect(resolveGoogleVoice(config)).toBe("en-GB-Chirp3-HD-Aoede");
    expect(resolveRingTone(config)).toBe("uk");
  });

  it("Spanish-primary business → es-US regardless of the chosen voice's accent", () => {
    const config = { voiceId: ALICE_GB, languagesSpoken: ["es"], timezone: "America/Chicago" };
    expect(resolveLocale(config)).toBe("es-US");
    expect(resolveGoogleVoice(config)).toBe("es-US-Chirp3-HD-Aoede");
    expect(resolveRingTone(config)).toBe("us");
  });

  it("multi-language en-first business follows the voice accent", () => {
    const config = { voiceId: BELLA_US, languagesSpoken: ["en", "es"], timezone: "America/Chicago" };
    expect(resolveLocale(config)).toBe("en-US");
  });

  it("google provider + London timezone → en-GB via the timezone heuristic", () => {
    const config = { voiceProvider: "google", languagesSpoken: ["en"], timezone: "Europe/London" };
    expect(resolveLocale(config)).toBe("en-GB");
  });

  it("defaults to en-US with no signals", () => {
    expect(resolveLocale({})).toBe("en-US");
    expect(resolveGoogleVoice({})).toBe("en-US-Chirp3-HD-Aoede");
    expect(resolveRingTone({})).toBe("us");
  });
});

// Speech recognition locale (cascade path). Fictional reserved numbers only.
describe("voiceLocale.js — speech locale reads the business's own number", () => {
  const UK_BUSINESS = "+447700900123";
  const US_BUSINESS = "+12025550123";
  const WITHHELD = "+266696687";

  it("a UK business number beats a US timezone when no caller number is known", () => {
    const config = { businessPhone: UK_BUSINESS, timezone: "America/Chicago" };
    expect(resolveSpeechLocale(config)).toBe("en-GB");
  });

  it("a UK business number still wins over a withheld or non-GB/US caller number", () => {
    const config = { businessPhone: UK_BUSINESS, timezone: "America/Chicago" };
    expect(resolveSpeechLocale(config, { callerNumber: WITHHELD })).toBe("en-GB");
    expect(resolveSpeechLocale(config, { callerNumber: "+33123456789" })).toBe("en-GB");
  });

  it("a US business number beats a UK timezone when no caller number is known", () => {
    const config = { businessPhone: US_BUSINESS, timezone: "Europe/London" };
    expect(resolveSpeechLocale(config)).toBe("en-US");
  });

  it("the caller's own number still wins over the business number", () => {
    const config = { businessPhone: UK_BUSINESS, timezone: "America/Chicago" };
    expect(resolveSpeechLocale(config, { callerNumber: "+12025550123" })).toBe("en-US");
  });

  it("mainPhone is still the fallback when businessPhone is absent", () => {
    const config = { mainPhone: UK_BUSINESS, timezone: "America/Chicago" };
    expect(resolveSpeechLocale(config)).toBe("en-GB");
  });
});
