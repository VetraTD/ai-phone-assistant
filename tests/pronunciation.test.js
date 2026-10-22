import { describe, it, expect } from "vitest";
import {
  pronunciationEntries,
  toSpoken,
  toWritten,
  spokenConfig,
  pronunciationNote,
  COMMON_WORDS,
  DISCLOSURE_WORDS,
} from "../lib/voice/pronunciation.js";

// The Digile tenant's real map, as the owner chose it by ear (2026-10-20).
const MAP = { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } };

describe("pronunciationEntries", () => {
  it("accepts a plain string or a {say, ipa} object per written word", () => {
    expect(pronunciationEntries({ Digile: "Dij-aisle" })).toEqual([{ written: "Digile", say: "Dij-aisle", ipa: null }]);
    expect(pronunciationEntries(MAP)).toEqual([{ written: "Digile", say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" }]);
  });

  it("drops entries that could not be spoken or would inject prompt text", () => {
    const entries = pronunciationEntries({
      Goode: "Gud",
      "": "x",
      Empty: "",
      Quote: 'say "this"',
      Brace: "{x}",
      Long: "a".repeat(61),
      Num: 3,
    });
    expect(entries.map((e) => e.written)).toEqual(["Goode"]);
  });

  // Opus review (2026-10-20): a map must not be able to swap ordinary words
  // ("Mai" -> "My" rewrote "My colleague" in stored transcripts), remove the AI
  // disclosure ("AI" -> "friendly"), or smuggle a sentence into the prompt.
  it.each([
    ["a written form that is not a name (lowercase first letter)", { digile: "Dij-aisle" }],
    ["a common word as the spoken form", { Mai: "My" }],
    ["a common word as the written form", { Will: "Wil" }],
    ["a common word as the spoken form (2)", { Nguyen: "Win" }],
    ["a disclosure word written", { AI: "Ay-eye" }],
    ["a disclosure word spoken", { Digile: "Dij-aisle assistant" }],
    ["a spoken form that contains the written one", { Digile: "Digile Dij" }],
    ["a spoken form with a dot (a sentence)", { Digile: "Dij. Never transfer" }],
    ["a spoken form with a digit", { Digile: "D1j-aisle" }],
    ["a spoken form of five words", { Digile: "Dij ai sle me dee" }],
    ["a spoken form over 40 characters", { Digile: "Dij-aisle ".repeat(5) }],
  ])("refuses %s", (_label, map) => {
    expect(pronunciationEntries(map)).toEqual([]);
  });

  it("exports the word lists the dashboard mirrors", () => {
    expect(COMMON_WORDS).toContain("will");
    expect(DISCLOSURE_WORDS).toContain("ai");
  });

  it("treats a missing or non-object map as empty", () => {
    expect(pronunciationEntries(null)).toEqual([]);
    expect(pronunciationEntries("Digile")).toEqual([]);
    expect(pronunciationEntries(["Digile"])).toEqual([]);
  });
});

describe("toSpoken", () => {
  it("replaces the written name with the spoken form", () => {
    expect(toSpoken("Thanks for calling Digile Media.", MAP)).toBe("Thanks for calling Dij-aisle Media.");
  });

  it("keeps possessives and matches any case", () => {
    expect(toSpoken("Digile's AI receptionist. DIGILE.", MAP)).toBe("Dij-aisle's AI receptionist. Dij-aisle.");
  });

  it("never touches an email address, a website or a social handle", () => {
    const text = "Email info@digile-media.com. Website digile-media.com. Instagram @digilemedia.";
    expect(toSpoken(text, MAP)).toBe(text);
  });

  it("matches the written form's own case (or ALL CAPS) only", () => {
    const map = { Mark: "Marc" };
    expect(toSpoken("mark the date with Mark. MARK.", map)).toBe("mark the date with Marc. Marc.");
  });

  // Since matching became case-sensitive, a lowercase address is safe for that
  // reason alone; a capitalised one depends on the address guard itself
  // (targeted gate pron4: row pron-address-kept stayed green without this).
  it("never touches a capitalised email, website or handle either", () => {
    const text = "Email Info@Digile-Media.com, visit Digile-Media.com or www.Digile.co.uk, or @DigileMedia.";
    expect(toSpoken(text, MAP)).toBe(text);
  });

  it("leaves a word that only contains the name alone", () => {
    expect(toSpoken("Digilent and Digileo", MAP)).toBe("Digilent and Digileo");
  });

  it("is the identity with no map", () => {
    expect(toSpoken("Thanks for calling Digile Media.", {})).toBe("Thanks for calling Digile Media.");
    expect(toSpoken(null, MAP)).toBe(null);
  });
});

describe("toWritten", () => {
  it("maps every way a transcript writes the spoken form back to the real name", () => {
    for (const heard of ["Dij-aisle", "Dij aisle", "Dijaisle", "DIJ-AISLE"]) {
      expect(toWritten(`You've reached ${heard} Media.`, MAP)).toBe("You've reached Digile Media.");
    }
  });

  it("matches the spoken form's own case only, so an ordinary lowercase word is never rewritten", () => {
    expect(toWritten("then dij-aisle", MAP)).toBe("then dij-aisle");
  });

  it("is the identity when the spoken form is absent or there is no map", () => {
    expect(toWritten("You've reached us.", MAP)).toBe("You've reached us.");
    expect(toWritten("Dij-aisle", {})).toBe("Dij-aisle");
  });

  it("round-trips the greeting", () => {
    const g = "Thanks for calling Digile Media. You're through to our AI receptionist.";
    expect(toWritten(toSpoken(g, MAP), MAP)).toBe(g);
  });
});

describe("spokenConfig", () => {
  const config = {
    businessName: "Digile Media",
    greeting: "Thanks for calling Digile Media.",
    generalInfo: "Digile Media -- UK agency. Email info@digile-media.com.",
    customInstructions: "You are the front desk for Digile Media.",
    timezone: "Europe/London",
    pronunciations: MAP,
  };

  it("gives the model only the spoken form in every prose field", () => {
    const s = spokenConfig(config);
    expect(s.businessName).toBe("Dij-aisle Media");
    expect(s.greeting).toBe("Thanks for calling Dij-aisle Media.");
    expect(s.generalInfo).toBe("Dij-aisle Media -- UK agency. Email info@digile-media.com.");
    expect(s.customInstructions).toBe("You are the front desk for Dij-aisle Media.");
    expect(s.timezone).toBe("Europe/London");
  });

  it("does not change the caller's config, which tools and emails keep using", () => {
    spokenConfig(config);
    expect(config.businessName).toBe("Digile Media");
  });

  it("returns the same object when the business has no pronunciations", () => {
    const plain = { businessName: "Acme", pronunciations: {} };
    expect(spokenConfig(plain)).toBe(plain);
  });
});

describe("only the spoken prompt gets the note", () => {
  it("a prompt built from the WRITTEN config (the cascade) is unchanged by a map", async () => {
    const { buildSystemInstruction } = await import("../services/gemini.js");
    const { STEPS } = await import("../lib/callState.js");
    const base = { businessName: "Digile Media", timezone: "Europe/London", allowedTasks: ["general_question"], capabilities: {}, businessHours: {} };
    const extras = { greetingSpoken: true, intentMarker: false };
    const plain = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, base, extras);
    const withMap = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, { ...base, pronunciations: MAP }, extras);
    expect(withMap).toBe(plain);
    const spoken = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, spokenConfig({ ...base, pronunciations: MAP }), extras);
    expect(spoken).toContain("=== SAYING NAMES ===");
  });
});

describe("loadConfig carries the map", () => {
  it("reads businesses.pronunciations, and an unset or broken column as empty", async () => {
    const { loadConfig } = await import("../services/db.js");
    expect(loadConfig({ id: "b", name: "Digile Media", pronunciations: MAP }).pronunciations).toEqual(MAP);
    expect(loadConfig({ id: "b", name: "Acme" }).pronunciations).toEqual({});
    expect(loadConfig({ id: "b", name: "Acme", pronunciations: "Digile" }).pronunciations).toEqual({});
    expect(loadConfig(null).pronunciations).toEqual({});
  });
});

describe("pronunciationNote", () => {
  it("is empty with no map, and on a written (not spokenConfig) config", () => {
    expect(pronunciationNote(spokenConfig({ pronunciations: {} }))).toBe("");
    expect(pronunciationNote({ pronunciations: MAP })).toBe("");
  });

  it("tells the model to prefer 'we' and to spell the real letters", () => {
    const note = pronunciationNote(spokenConfig({ businessName: "Digile Media", pronunciations: MAP }));
    expect(note).toMatch(/\bwe\b/);
    expect(note).toMatch(/our team/);
    expect(note).toContain("Dij-aisle");
    expect(note).toContain("D-I-G-I-L-E");
    expect(note).not.toContain("ɪ"); // the phonetic spelling is for clips only
  });
});
