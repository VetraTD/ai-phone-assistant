import { describe, it, expect } from "vitest";
import { buildCallsCsv, neutraliseFormula } from "../callsCsv";

const row = (over) => ({ started_at: "2026-11-20T10:00:00Z", caller_number: "+15550100", status: "completed", summary: "", ...over });
const dataLine = (csv) => csv.split("\r\n")[1];

describe("CSV formula guard", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    it(`makes a text cell starting with ${JSON.stringify(lead)} plain text`, () => {
      expect(neutraliseFormula(`${lead}HYPERLINK("http://x")`)).toBe(`'${lead}HYPERLINK("http://x")`);
    });
  }
  it("guards sums and odd punctuation that only look numeric", () => {
    expect(neutraliseFormula("-1+1")).toBe("'-1+1");
    // Control characters inside an otherwise numeric cell are not "a number".
    expect(neutraliseFormula("+1\t2")).toBe("'+1\t2");
    // Not code: a spreadsheet reads it as a syntax error, so it stays as typed.
    expect(neutraliseFormula("+1)(2")).toBe("+1)(2");
  });
  it("leaves phone numbers and plain numbers alone", () => {
    for (const v of ["+1 (555) 010-0199", "+15550100", "-3", "42"]) expect(neutraliseFormula(v)).toBe(v);
  });
  it("guards the summary and the caller name in the export", () => {
    const csv = buildCallsCsv([row({ caller_name_guess: "=cmd|' /C calc'!A0", summary: "@SUM(A1)" })]);
    expect(dataLine(csv)).toContain("'=cmd|");
    expect(dataLine(csv)).toContain("'@SUM(A1)");
  });
});
