import { createRequire } from "node:module";
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseArgs, buildFallbackUrl, formatBlock } from "../scripts/fallback-urls.js";

const require = createRequire(import.meta.url);
const { buildFallbackTwiml } = require("../twilio/fallback/fallback.js");
const { VoiceResponse } = require("twilio").twiml;

const BASE = "https://vetra-fallback-1234.twil.io/fallback";
const LANDLINE = "+442071234567";
const UK_MOBILE_DEAR = "+447624123456"; // needs_switch_on
const PREMIUM = "+19005551234"; // never

const q = (url) => new URL(url).searchParams;
const build = (o = {}) => buildFallbackUrl({ base: BASE, transferNumber: LANDLINE, transferNoAnswer: "take_message", sayVoice: "Polly.Amy", allowPricier: false, ...o });

describe("buildFallbackUrl", () => {
  it("builds n, t, v in that order and encodes the plus as %2B", () => {
    const { url, omitted } = build();
    expect(omitted).toBeNull();
    expect(url).toBe(`${BASE}?n=%2B442071234567&t=20&v=Polly.Amy`);
    expect(url).not.toContain("n=+");
    expect(q(url).get("n")).toBe(LANDLINE);
  });

  it("own_voicemail rings 45 seconds; take_message, null and junk ring 20", () => {
    expect(q(build({ transferNoAnswer: "own_voicemail" }).url).get("t")).toBe("45");
    for (const v of ["take_message", null, undefined, "junk"]) {
      expect(q(build({ transferNoAnswer: v }).url).get("t")).toBe("20");
    }
  });

  it("leaves n out with a reason when there is no transfer number", () => {
    for (const transferNumber of [null, undefined, ""]) {
      const r = build({ transferNumber });
      expect(r.omitted).toBe("no_transfer_number");
      expect(r.url).toBe(`${BASE}?t=20&v=Polly.Amy`);
    }
  });

  it("leaves n out when the number is not E.164", () => {
    for (const transferNumber of ["02071234567", "+44 207 123 4567", "+4412"]) {
      const r = build({ transferNumber });
      expect(r.omitted).toBe("not_e164");
      expect(q(r.url).has("n")).toBe(false);
    }
  });

  it("applies the dial price check: needs_switch_on is left out, and allowPricier true puts it in", () => {
    const off = build({ transferNumber: UK_MOBILE_DEAR });
    expect(off.omitted).toBe("needs_switch_on");
    expect(q(off.url).has("n")).toBe(false);
    expect(build({ transferNumber: UK_MOBILE_DEAR, allowPricier: "true" }).omitted).toBe("needs_switch_on");
    const on = build({ transferNumber: UK_MOBILE_DEAR, allowPricier: true });
    expect(on.omitted).toBeNull();
    expect(q(on.url).get("n")).toBe(UK_MOBILE_DEAR);
  });

  it("never includes a premium number, even with allowPricier", () => {
    const r = build({ transferNumber: PREMIUM, allowPricier: true });
    expect(r.omitted).toBe("never");
    expect(q(r.url).has("n")).toBe(false);
  });
});

describe("parseArgs", () => {
  it("accepts an https base and strips one trailing slash", () => {
    expect(parseArgs(["--base", BASE])).toEqual({ ok: true, value: { base: BASE } });
    expect(parseArgs(["--base", BASE + "/"])).toEqual({ ok: true, value: { base: BASE } });
  });
  it("refuses a missing base, http, a query string, a fragment, a non-URL and unknown flags", () => {
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(["--base"]).ok).toBe(false);
    expect(parseArgs(["--base", "http://x.twil.io/fallback"]).ok).toBe(false);
    expect(parseArgs(["--base", BASE + "?n=1"]).ok).toBe(false);
    expect(parseArgs(["--base", BASE + "#x"]).ok).toBe(false);
    expect(parseArgs(["--base", "not a url"]).ok).toBe(false);
    expect(parseArgs(["--base", BASE, "--confirm"]).ok).toBe(false);
    expect(parseArgs(["--base", BASE, "stray"]).ok).toBe(false);
  });
});

describe("output", () => {
  const rows = [
    { phone_number: "+441372656055", name: "Brightwork Studio", ...build({ transferNumber: LANDLINE }) },
    { phone_number: "+441372656066", name: "Second Co", ...build({ transferNumber: UK_MOBILE_DEAR }) },
  ];
  it("prints only the business numbers and the encoded transfer numbers", () => {
    const text = rows.flatMap((r) => formatBlock(r, { url: r.url, omitted: r.omitted })).join("\n");
    expect(text).toContain("[fallback] +441372656055  Brightwork Studio");
    expect(text).toContain("n=%2B442071234567");
    expect(text).toContain("no transfer number in this URL");
    expect(text).toContain("allow_pricier_numbers");
    // every + number in the text is a business number; the transfer numbers appear only encoded
    const plus = text.match(/\+\d{8,}/g) || [];
    expect(new Set(plus)).toEqual(new Set(["+441372656055", "+441372656066"]));
    expect(text).not.toContain(UK_MOBILE_DEAR);
  });
});

describe("wire: URL -> Twilio Function", () => {
  const dialOf = (xml) => ({
    number: (xml.match(/<Number>([^<]*)<\/Number>/) || [])[1],
    timeout: (xml.match(/<Dial\b[^>]*\btimeout="(\d+)"/) || [])[1],
  });
  const run = (url) =>
    buildFallbackTwiml(
      { From: "+447700900555", To: "+441372656055", ...Object.fromEntries(q(url)) },
      { DOMAIN_NAME: "vetra-fallback-1234.twil.io" },
      VoiceResponse
    ).toString();

  it("the Function dials the right number with the right timeout and voice", () => {
    const xml = run(build({ transferNoAnswer: "own_voicemail", sayVoice: "Polly.Amy" }).url);
    expect(dialOf(xml)).toEqual({ number: LANDLINE, timeout: "45" });
    expect(xml).toContain("v=Polly.Amy");
  });

  it("without n the Function takes a message in the right voice", () => {
    const xml = run(build({ transferNumber: PREMIUM, sayVoice: "Polly.Joanna" }).url);
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain('voice="Polly.Joanna"');
    expect(xml).toContain("<Record");
  });
});
