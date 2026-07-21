import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveLocale, resolveGoogleVoice, resolveRingTone } from "../lib/voice/voiceLocale.js";

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
