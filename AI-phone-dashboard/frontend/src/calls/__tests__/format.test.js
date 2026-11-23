import { describe, it, expect } from "vitest";
import { formatTime, formatDateTime, dayHeading, telHref, callerLabel } from "../format";

const TZ = "America/Chicago";

describe("times in the business's timezone", () => {
  it("formats a time with a lower-case am/pm", () => {
    expect(formatTime("2026-11-24T15:05:00Z", TZ)).toBe("9:05 am");
    expect(formatTime("2026-11-24T21:30:00Z", TZ)).toBe("3:30 pm");
  });

  it("uses the business's clock, not the viewer's, around midnight", () => {
    expect(formatTime("2026-11-23T05:59:00Z", TZ)).toBe("11:59 pm");
    expect(dayHeading("2026-11-23T05:59:00Z", TZ, new Date("2026-11-23T12:00:00Z"))).toBe("Yesterday");
  });

  it("formats a full date and time the UK way", () => {
    expect(formatDateTime("2026-11-24T15:00:00Z", TZ)).toBe("Tuesday 24 November, 9:00 am");
  });

  it("heads a day Today, Yesterday, or with its date", () => {
    const now = new Date("2026-11-23T18:00:00Z"); // Monday 12:00 in Chicago
    expect(dayHeading("2026-11-23T15:00:00Z", TZ, now)).toBe("Today");
    expect(dayHeading("2026-11-22T15:00:00Z", TZ, now)).toBe("Yesterday");
    expect(dayHeading("2026-11-20T15:00:00Z", TZ, now)).toBe("Friday 20 November");
  });
});

describe("telHref", () => {
  it("builds a tel: link from a formatted number", () => {
    expect(telHref("+1 (555) 010-0199")).toBe("tel:+15550100199");
    expect(telHref("+44 7700 900.123")).toBe("tel:+447700900123");
  });

  it("refuses anything that is not a phone number", () => {
    for (const bad of ["javascript:alert(1)", "", null, undefined, "12", "+1555abc0199", "tel:+15550100199"]) {
      expect(telHref(bad)).toBeNull();
    }
  });

  it("gives no link for a withheld number", () => {
    for (const withheld of ["anonymous", "Restricted", "+266696687", "+7378742833", "+2562533", "+8656696", "+86282452253"]) {
      expect(telHref(withheld)).toBeNull();
    }
  });
});

describe("callerLabel", () => {
  it("prefers the name, then the number", () => {
    expect(callerLabel({ callerName: "Sample Caller", callerNumber: "+15550100" })).toBe("Sample Caller");
    expect(callerLabel({ callerName: "  ", callerNumber: "+15550100" })).toBe("+15550100");
  });

  it("says Withheld number when there is nothing to show", () => {
    expect(callerLabel({})).toBe("Withheld number");
    expect(callerLabel({ callerNumber: "anonymous" })).toBe("Withheld number");
    expect(callerLabel({ callerNumber: "+266696687" })).toBe("Withheld number");
  });
});
