import { describe, it, expect } from "vitest";
import { STRINGS, resolveLang, getStrings } from "../lib/voice/strings.js";

describe("strings.js — localized fixed strings", () => {
  it("every language table has exactly the same keys as English, with matching types", () => {
    const enKeys = Object.keys(STRINGS.en).sort();
    for (const [lang, table] of Object.entries(STRINGS)) {
      expect(Object.keys(table).sort(), `keys for ${lang}`).toEqual(enKeys);
      for (const key of enKeys) {
        expect(typeof table[key], `${lang}.${key} type`).toBe(typeof STRINGS.en[key]);
      }
    }
  });

  it("template functions interpolate", () => {
    for (const table of Object.values(STRINGS)) {
      expect(table.greetingDefault(table.todMorning, "Acme")).toContain("Acme");
      expect(table.goodbyeWithPhone("+15551234567")).toContain("+15551234567");
    }
  });

  it("resolveLang picks the primary configured language, defaulting to en", () => {
    expect(resolveLang({ languagesSpoken: ["es"] })).toBe("es");
    expect(resolveLang({ languagesSpoken: ["es", "en"] })).toBe("es");
    expect(resolveLang({ languagesSpoken: ["en", "es"] })).toBe("en");
    expect(resolveLang({ languagesSpoken: ["fr"] })).toBe("en"); // no fr table yet
    expect(resolveLang({})).toBe("en");
  });

  it("getStrings accepts a config or a language code", () => {
    expect(getStrings("es").filler).toBe("Un momento.");
    expect(getStrings({ languagesSpoken: ["es"] }).filler).toBe("Un momento.");
    expect(getStrings("en").filler).toBe("One moment.");
    expect(getStrings("nope").filler).toBe("One moment.");
  });
});
