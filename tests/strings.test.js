import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STRINGS, resolveLang, getStrings } from "../lib/voice/strings.js";

const STRINGS_JS_PATH = fileURLToPath(new URL("../lib/voice/strings.js", import.meta.url));

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

// ---------------------------------------------------------------------------
// Since 732f6ed (2026-09-06) the es.signOffRe line carried six literal
// backspace bytes (0x08) where the regex escape `\b` (backslash + b) was
// meant to be -- most likely a shell heredoc/escape accident. A raw 0x08 in a
// JS regex matches a literal backspace character, which never occurs in a
// transcript, so no Spanish spoken farewell ever satisfied it and the
// Spanish goodbye exit in lib/voice/live/index.js never armed on an inbound
// call.
//
// Repaired byte-for-byte (each 0x08 -> the two characters \b, nothing else
// touched), the line reads:
//
//   /\bgracias\s+por\s+llamar\b[^.!?]*\b(?:adi[oó]s|hasta\s+luego|
//   buen\s+d[ií]a|buen[ao]s?\s+(?:d[ií]as|tardes|noches))\b|
//   \bque\s+tenga\s+un\s+buen\s+d[ií]a\b/i
//
// which is the same shape as the English signOffRe just above it in this
// file: an anchor phrase ("gracias por llamar" / "thanks ... for calling"),
// a same-sentence gap, then a farewell word -- OR a standalone closing
// sentence ("que tenga un buen día" / "have a ___ day").
// ---------------------------------------------------------------------------
describe("es signOffRe — repaired from literal backspace bytes (732f6ed)", () => {
  const re = getStrings({ languagesSpoken: ["es"] }).signOffRe;

  const REAL_FAREWELLS = [
    // The brief's own two examples.
    "Gracias por llamar, adiós.",
    "Que tenga un buen día, adiós.",
    // A realistic full closing turn, one per alternative in the group.
    "Perfecto. Hemos reservado su cita. Gracias por llamar a Digile Media, y que tenga un buen día.",
    "Gracias por llamar a Brightwork Studio, hasta luego.",
    "Gracias por llamar, buenos días.",
    "Gracias por llamar, buenas tardes.",
    "Gracias por llamar, buenas noches.",
    // The standalone second alternative, bare.
    "Que tenga un buen día.",
  ];
  for (const said of REAL_FAREWELLS) {
    it(`arms on: ${said}`, () => expect(re.test(said)).toBe(true));
  }

  it.each(["¿Algo más en lo que pueda ayudarle?", "Un momento, por favor."])(
    "does not arm on a non-farewell: %s",
    (said) => expect(re.test(said)).toBe(false)
  );

  // Ruling: the brief listed a bare "Hasta luego." as an expected match, but
  // the six repaired \b positions (verified byte-by-byte against the
  // corrupted line) put "hasta luego" ONLY inside the first alternative,
  // behind the same "gracias por llamar" anchor the English regex requires
  // before ITS bare farewell words. This mirrors English exactly: a bare
  // "take care" alone doesn't arm signOffRe either (tests/liveExitPrecedence
  // .test.js), because an unanchored farewell WORD is too common mid-sentence
  // ("I'll take care of that" / a caller planning to say "hasta luego" to a
  // third party). Widening the alternation to add a new bare-"hasta luego"
  // branch would be a second change beyond restoring the corrupted bytes, so
  // it is left alone; see it matching WITH the anchor above instead.
  it("does not arm on 'hasta luego' alone, without the anchor phrase (matches English's anchor requirement)", () => {
    expect(re.test("Hasta luego.")).toBe(false);
  });

  it("no 0x08 (backspace) byte survives anywhere in lib/voice/strings.js", () => {
    const bytes = readFileSync(STRINGS_JS_PATH, "latin1");
    expect(bytes.includes("\u0008")).toBe(false);
  });

  it("the es closingTicRe is unchanged by the signOffRe repair", () => {
    expect(getStrings({ languagesSpoken: ["es"] }).closingTicRe.source).toBe(
      "\\b(?:hay\\s+)?algo\\s+m[aá]s\\b"
    );
  });
});

// S4-F2 part 2: the inbound end_call instruction says "thank them for calling and
// wish them well", so the model's goodbye often lacks "bye"/"have a great day".
// signOffRe HANGS UP, so the widening stays behind "thank(s) ... for calling".
describe("signOffRe hears a 'wish them well' goodbye after thanks-for-calling", () => {
  const en = getStrings({}).signOffRe;
  const es = getStrings({ languagesSpoken: ["es"] }).signOffRe;

  it("en: these goodbyes match", () => {
    for (const t of [
      "Thank you for calling, all the best!",
      "Thanks for calling, wishing you a nice day",
      "Thank you for calling, I wish you well.",
      "Thank you for calling. Wishing you a lovely evening!",
    ]) {
      expect(en.test(t), t).toBe(true);
    }
  });

  it("en: mid-call uses of the same words do not match", () => {
    for (const t of [
      "I wish you well with the move. What time works for you?",
      "All the best options are in the morning.",
      "Thanks for calling Acme, how can I help you today?",
      "Wishing you a nice day.",
      "All the best!",
    ]) {
      expect(en.test(t), t).toBe(false);
    }
  });

  it("es: these goodbyes match", () => {
    for (const t of [
      "Gracias por llamar, que le vaya bien.",
      "Gracias por llamar, le deseo lo mejor.",
    ]) {
      expect(es.test(t), t).toBe(true);
    }
  });

  it("es: the same words without gracias-por-llamar do not match", () => {
    for (const t of ["Que le vaya bien con la mudanza. ¿A qué hora le viene bien?", "Le deseo lo mejor."]) {
      expect(es.test(t), t).toBe(false);
    }
  });
});
