import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { pronunciationEntries } from "../lib/voice/pronunciation.js";

// The dashboard validator (CommonJS, separate package) mirrors the voice
// server's pronunciation rules. The voice server drops what it dislikes, the
// dashboard rejects it: for any single entry, "dashboard accepts" must equal
// "voice server keeps". If this fails, one side's rules changed alone.
const require = createRequire(import.meta.url);
const { SETTINGS_FIELD_VALIDATORS } = require("../AI-phone-dashboard/backend/src/settingsValidation.js");
const validate = SETTINGS_FIELD_VALIDATORS.pronunciations;

const IPA_OK = "ˈdɪdʒaɪl";

const CASES = [
  ["plain", { Digile: "Dij-aisle" }],
  ["say + ipa", { Digile: { say: "Dij-aisle", ipa: IPA_OK } }],
  ["object, no ipa", { Digile: { say: "Dij-aisle" } }],
  ["trimmed", { " Digile ": "  Dij-aisle  " }],
  ["multi-word with & and apostrophe", { "O’Brien & Sons": "Oh-Bry-en and Sons" }],
  ["accented letters", { Zoë: "Zoh-ee" }],
  ["digits and dots", { "3.M": "Three M" }],
  ["written exactly 40", { ["a".repeat(40)]: "ok" }],
  ["written 41", { ["a".repeat(41)]: "ok" }],
  ["say exactly 60", { Digile: "a".repeat(60) }],
  ["say 61", { Digile: "a".repeat(61) }],
  ["empty written", { "": "ok" }],
  ["blank written", { "   ": "ok" }],
  ["empty say", { Digile: "" }],
  ["blank say", { Digile: "   " }],
  ["object with no say", { Digile: { ipa: IPA_OK } }],
  ["non-string value", { Digile: 5 }],
  ["null value", { Digile: null }],
  ["double quote in say", { Digile: 'Dij"aisle' }],
  ["double quote in written", { 'Dig"ile': "ok" }],
  ["brace in say", { Digile: "Dij{aisle}" }],
  ["colon in say", { Digile: "say: hi" }],
  ["newline in say", { Digile: "Dij\naisle" }],
  ["backtick in written", { "Dig`ile": "ok" }],
  ["angle brackets in say", { Digile: "<b>x</b>" }],
];

describe("dashboard pronunciation validator == voice-server pronunciationEntries", () => {
  it.each(CASES)("%s", (_name, map) => {
    const kept = pronunciationEntries(map).length === 1;
    const accepted = validate(map).error === undefined;
    expect(accepted).toBe(kept);
  });

  it("11 entries: the dashboard refuses, the voice server keeps only 10", () => {
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Name${i}`, "ok"]));
    expect(validate(eleven).error).toBeTruthy();
    expect(pronunciationEntries(eleven)).toHaveLength(10);
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Name${i}`, "ok"]));
    expect(validate(ten).error).toBeUndefined();
    expect(pronunciationEntries(ten)).toHaveLength(10);
  });

  it("a bad ipa: the dashboard refuses it, the voice server drops only the ipa", () => {
    for (const ipa of ["<x>", "a".repeat(61), "ˈd{ɪ"]) {
      const map = { Digile: { say: "Dij-aisle", ipa } };
      expect(validate(map).error).toBeTruthy();
      const [e] = pronunciationEntries(map);
      expect(e.say).toBe("Dij-aisle");
      expect(e.ipa).toBeNull();
    }
  });

  it("what the dashboard normalizes, the voice server reads back identically", () => {
    const { value } = validate({ " Digile ": { say: " Dij-aisle ", ipa: ` ${IPA_OK} ` } });
    expect(pronunciationEntries(value)).toEqual([{ written: "Digile", say: "Dij-aisle", ipa: IPA_OK }]);
  });
});
