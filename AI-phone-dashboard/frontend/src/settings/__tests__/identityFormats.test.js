import { describe, it, expect } from "vitest";
import { FORMAT_CHOICES, formatFromPattern, patternFor } from "../identityFormats";

describe("identity formats as choices, never a regular expression", () => {
  it("offers plain choices", () => {
    expect(FORMAT_CHOICES.map((c) => c.label)).toEqual(["Anything", "Numbers only", "Exactly this many digits", "Letters and numbers"]);
  });

  it("Exactly 8 digits saves the pattern the engine checks", () => {
    expect(patternFor({ choice: "digits", digits: 8 })).toBe("^\\d{8}$");
    expect(patternFor({ choice: "numbers" })).toBe("^\\d+$");
    expect(patternFor({ choice: "alnum" })).toBe("^[A-Za-z0-9]+$");
    expect(patternFor({ choice: "any" })).toBe("");
  });

  it("keeps the digit count between 1 and 20", () => {
    expect(patternFor({ choice: "digits", digits: 0 })).toBe("^\\d{1}$");
    expect(patternFor({ choice: "digits", digits: 99 })).toBe("^\\d{20}$");
  });

  it("reads a saved pattern back as its choice", () => {
    expect(formatFromPattern("^\\d{8}$")).toEqual({ choice: "digits", digits: 8 });
    expect(formatFromPattern("^[0-9]{6}$")).toEqual({ choice: "digits", digits: 6 });
    expect(formatFromPattern("")).toEqual({ choice: "any" });
    expect(formatFromPattern("^\\d+$")).toEqual({ choice: "numbers" });
    expect(formatFromPattern("^[A-Za-z0-9]+$")).toEqual({ choice: "alnum" });
  });

  it("an unknown pattern is custom and survives a save untouched", () => {
    const odd = "^[A-Z]{2}\\d{4}$";
    expect(formatFromPattern(odd)).toEqual({ choice: "custom" });
    expect(patternFor({ choice: "custom" }, odd)).toBe(odd);
  });
});
