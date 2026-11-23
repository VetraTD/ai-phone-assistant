import { describe, it, expect } from "vitest";
import { formatTime, formatDateTime, dayHeading, telHref, callerLabel, formatPhone, shortDay } from "../format";

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

describe("formatPhone", () => {
  it("groups UK and North American numbers and leaves anything else as stored", () => {
    expect(formatPhone("+447700900113")).toBe("+44 7700 900113");
    expect(formatPhone("+15550100199")).toBe("+1 (555) 010-0199");
    expect(formatPhone("+33123456789")).toBe("+33123456789");
    expect(formatPhone(null)).toBe("");
  });
});

describe("shortDay", () => {
  it("names an earlier day briefly; yesterday stays Yesterday", () => {
    const now = new Date("2026-11-23T18:00:00Z");
    expect(shortDay("2026-11-21T02:03:00Z", "America/Chicago", now)).toBe("Fri 20 Nov");
    expect(shortDay("2026-11-22T18:00:00Z", "America/Chicago", now)).toBe("Yesterday");
    expect(shortDay("2026-11-23T17:00:00Z", "America/Chicago", now)).toBe("Today");
  });
});

describe("callerLabel", () => {
  it("prefers the name, then the number", () => {
    expect(callerLabel({ callerName: "Sample Caller", callerNumber: "+15550100" })).toBe("Sample Caller");
    expect(callerLabel({ callerName: "  ", callerNumber: "+15550100" })).toBe("+15550100");
    // A whole number reads in groups, the way the front desk says it aloud.
    expect(callerLabel({ callerNumber: "+447700900113" })).toBe("+44 7700 900113");
    expect(callerLabel({ callerNumber: "+15550100199" })).toBe("+1 (555) 010-0199");
  });

  it("says Withheld number when there is nothing to show", () => {
    expect(callerLabel({})).toBe("Withheld number");
    expect(callerLabel({ callerNumber: "anonymous" })).toBe("Withheld number");
    expect(callerLabel({ callerNumber: "+266696687" })).toBe("Withheld number");
  });
});

describe("dayHeading far east of UTC", () => {
  it("says Yesterday in New Zealand too", () => {
    const now = new Date("2026-11-23T10:00:00Z"); // 23:00 on the 23rd in Auckland
    expect(dayHeading("2026-11-22T10:00:00Z", "Pacific/Auckland", now)).toBe("Yesterday"); // 23:00 on the 22nd
    expect(dayHeading("2026-11-23T01:00:00Z", "Pacific/Auckland", now)).toBe("Today");
  });
});
