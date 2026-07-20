import { describe, it, expect } from "vitest";
import { VOICE_CATALOG } from "../config/voices.js";

describe("config/voices.js — curated ElevenLabs voice catalog", () => {
  it("has exactly 8 curated entries", () => {
    expect(VOICE_CATALOG).toHaveLength(8);
  });

  it("every entry has the required shape", () => {
    for (const entry of VOICE_CATALOG) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.elevenVoiceId).toBe("string");
      expect(entry.elevenVoiceId.length).toBeGreaterThan(0);
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(["male", "female", "neutral"]).toContain(entry.gender);
      expect(typeof entry.accent).toBe("string");
      expect(typeof entry.previewText).toBe("string");
      expect(entry.previewText.length).toBeGreaterThan(0);
      expect(entry.voiceSettings).toBeTruthy();
      expect(typeof entry.voiceSettings.stability).toBe("number");
      expect(typeof entry.voiceSettings.similarity_boost).toBe("number");
    }
  });

  it("has unique catalog ids", () => {
    const ids = VOICE_CATALOG.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique ElevenLabs voice ids", () => {
    const voiceIds = VOICE_CATALOG.map((v) => v.elevenVoiceId);
    expect(new Set(voiceIds).size).toBe(voiceIds.length);
  });

  it("stability values are within ElevenLabs' valid 0..1 range", () => {
    for (const entry of VOICE_CATALOG) {
      expect(entry.voiceSettings.stability).toBeGreaterThanOrEqual(0);
      expect(entry.voiceSettings.stability).toBeLessThanOrEqual(1);
      expect(entry.voiceSettings.similarity_boost).toBeGreaterThanOrEqual(0);
      expect(entry.voiceSettings.similarity_boost).toBeLessThanOrEqual(1);
    }
  });
});
