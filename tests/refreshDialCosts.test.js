import { describe, it, expect } from "vitest";
import { categoryOf, transform, assertCompletePull, serialize } from "../scripts/refresh-dial-costs.mjs";

const P = "Programmable Outbound Minute - ";
const pp = (name, price, prefixes) => ({ base_price: String(price), current_price: String(price), friendly_name: P + name, prefixes });
const sp = (type, price) => ({ base_price: String(price), current_price: String(price), number_type: type });

const fixture = () => ({
  fetched: "2026-10-11T00:00:00.000Z",
  voice: [
    {
      country: "United Kingdom",
      iso_country: "GB",
      outbound_prefix_prices: [
        pp("United Kingdom - Premium Services", 0.9, ["449"]),
        pp("United Kingdom - Personal", 0.5577, ["4470"]),
        pp("United Kingdom - Special Services - Other", 0.26, ["44844"]),
        pp("United Kingdom - Special Services - 03", 0.037, ["443"]),
        pp("United Kingdom - Mobile - Other", 0.32, ["447"]),
        pp("United Kingdom - Mobile - Vodafone", 0.0305, ["44740"]),
        pp("United Kingdom - Fixed", 0.02, ["44"]),
      ],
    },
    { country: "Isle of Man", iso_country: "IM", outbound_prefix_prices: [pp("United Kingdom - Mobile - Other", 0.32, ["447"])] },
    { country: "United States", iso_country: "US", outbound_prefix_prices: [pp("United States & Canada - Toll Free", 0.014, ["1", "1907"])] },
    { country: "Canada", iso_country: "CA", outbound_prefix_prices: [pp("Canada - Yukon", 0.12, ["1867"])] },
    {
      country: "Newland",
      iso_country: "NL",
      outbound_prefix_prices: [pp("Newland - Mobile", 0.1, ["999"]), pp("Newland - Fixed", 0.3, ["998"])],
    },
    { country: "Otherland", iso_country: "OL", outbound_prefix_prices: [pp("Otherland - Mobile", 0.05, ["999"]), pp("Otherland - Premium", 0.01, ["998"])] },
  ],
  sms: [
    {
      country: "United Kingdom",
      iso_country: "GB",
      outbound_sms_prices: [
        { carrier: "A", prices: [sp("mobile", 0.056), sp("local", 0.9)] },
        { carrier: "B", prices: [sp("mobile", 0.06)] },
      ],
    },
    { country: "Shortland", iso_country: "SH", outbound_sms_prices: [{ carrier: "A", prices: [sp("shortcode", 0.2), sp("local", 0.3)] }] },
    { country: "Nowhere", iso_country: "IO", outbound_sms_prices: [] },
    null,
  ],
});

describe("importing the script", () => {
  it("does not run main or fetch", () => {
    expect(typeof transform).toBe("function");
  });
});

describe("categoryOf", () => {
  it("classifies real Twilio names, first match wins", () => {
    expect(categoryOf("Programmable Outbound Minute - United Kingdom - Mobile - Other")).toBe("mobile");
    expect(categoryOf("Programmable Outbound Minute - United Kingdom - Premium Services")).toBe("premium");
    expect(categoryOf("Programmable Outbound Minute - United Kingdom - Personal")).toBe("personal");
    expect(categoryOf("Programmable Outbound Minute - United Kingdom - Special Services - Other")).toBe("special");
    expect(categoryOf("Programmable Outbound Minute - Australia - Shared Cost Service")).toBe("shared");
    expect(categoryOf("X - Service & Personal")).toBe("personal");
    expect(categoryOf("Programmable Outbound Minute - United States & Canada - Toll Free")).toBe("fixed");
    expect(categoryOf("Y - Inmarsat")).toBe("satellite");
    expect(categoryOf("Y - Iridium")).toBe("satellite");
    expect(categoryOf("Y - Thuraya")).toBe("satellite");
    expect(categoryOf("Y - Paging")).toBe("pager");
    expect(categoryOf("Y - Pager")).toBe("pager");
    expect(categoryOf("Y - PREMIUM Mobile")).toBe("premium");
  });
});

describe("transform", () => {
  const t = transform(fixture());
  it("carries fetched and source", () => {
    expect(t.fetched).toBe("2026-10-11T00:00:00.000Z");
    expect(t.source).toBe("Twilio Pricing API v1 (Voice + Messaging Countries), USD");
  });
  it("builds voice tuples", () => {
    expect(t.voice["449"]).toEqual([0.9, "GB", "premium"]);
    expect(t.voice["4470"]).toEqual([0.5577, "GB", "personal"]);
    expect(t.voice["44844"]).toEqual([0.26, "GB", "special"]);
    expect(t.voice["443"]).toEqual([0.037, "GB", "special"]);
    expect(t.voice["44740"]).toEqual([0.0305, "GB", "mobile"]);
    expect(t.voice["1"]).toEqual([0.014, "US", "fixed"]);
    expect(t.voice["1907"]).toEqual([0.014, "US", "fixed"]);
    expect(t.voice["1867"]).toEqual([0.12, "CA", "fixed"]);
  });
  it("a shared prefix gets the country the name begins with", () => {
    expect(t.voice["447"]).toEqual([0.32, "GB", "mobile"]);
  });
  it("collisions keep the highest price, and a never-category beats a dearer one", () => {
    expect(t.voice["998"][2]).toBe("premium");
    expect(t.voice["998"][1]).toBe("OL");
    expect(t.voice["999"][0]).toBe(0.1);
  });
  it("counts collisions and differing ones", () => {
    expect(t.stats).toEqual({ collisions: 3, collisionsDiffering: 2 });
  });
  it("sms: max mobile, else max overall, else omitted", () => {
    expect(t.sms.GB).toBe(0.06);
    expect(t.sms.SH).toBe(0.3);
    expect("IO" in t.sms).toBe(false);
  });
});

describe("assertCompletePull", () => {
  it("throws on a small fixture", () => {
    expect(() => assertCompletePull(fixture())).toThrow();
  });
  it("passes on 200 countries containing GB/US/CA, throws without them", () => {
    const mk = (isos) => ({ voice: isos.map((iso_country) => ({ iso_country })) });
    const fill = Array.from({ length: 197 }, (_, i) => "Z" + i);
    expect(() => assertCompletePull(mk([...fill, "GB", "US", "CA"]))).not.toThrow();
    expect(() => assertCompletePull(mk([...fill, "GB", "US", "XX"]))).toThrow();
    expect(() => assertCompletePull(mk([...fill.slice(1), "GB", "US", "CA"]))).toThrow();
  });
});

describe("serialize", () => {
  const text = serialize(transform(fixture()));
  it("is valid JSON in the stated order", () => {
    const o = JSON.parse(text);
    expect(Object.keys(o)).toEqual(["fetched", "source", "voice", "sms"]);
    expect(o.voice["44740"]).toEqual([0.0305, "GB", "mobile"]);
  });
  it("sorts keys as strings, one entry per line, LF, trailing newline", () => {
    const keys = text.split("\n").filter((l) => /^"\d+":\[/.test(l)).map((l) => l.slice(1, l.indexOf('"', 1)));
    expect(keys).toEqual([...keys].sort());
    expect(text).toContain('\n"44740":[0.0305,"GB","mobile"],\n');
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
  });
});
