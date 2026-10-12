import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkDial,
  checkText,
  callCostOf,
  makeChecker,
  parseTable,
  tableAgeDays,
  REFUSAL_MESSAGES,
  AUTO_MAX_PER_MIN,
  HARD_MAX_PER_MIN,
  TEXT_MAX_EACH,
} from "../lib/dialCost.js";

describe("constants and messages", () => {
  it("has the owner's thresholds", () => {
    expect(AUTO_MAX_PER_MIN).toBe(0.1);
    expect(HARD_MAX_PER_MIN).toBe(0.6);
    expect(TEXT_MAX_EACH).toBe(0.25);
  });
  it("has a message for every refusal reason", () => {
    for (const r of ["invalid", "unknown", "never", "over_ceiling", "needs_switch_on"]) {
      expect(typeof REFUSAL_MESSAGES[r]).toBe("string");
    }
    expect(REFUSAL_MESSAGES.invalid).toBe(
      "That doesn't look like a full international number. Use the + format with the country code, for example +442079460958."
    );
  });
});

describe("checkDial on the real table", () => {
  it("allows a cheap UK mobile", () => {
    const r = checkDial("+447400123456");
    expect(r.ok).toBe(true);
    expect(r.perMin).toBe(0.0305);
    expect(r.iso).toBe("GB");
  });
  it("needs switch-on for pricier mobiles, and honours allowPricier", () => {
    expect(checkDial("+447911123456")).toMatchObject({ ok: false, reason: "needs_switch_on" });
    expect(checkDial("+447624123456")).toMatchObject({ ok: false, reason: "needs_switch_on" });
    expect(checkDial("+447624123456", { allowPricier: true }).ok).toBe(true);
    expect(checkDial("+18675551234")).toMatchObject({ ok: false, reason: "needs_switch_on" });
    expect(checkDial("+33612345678")).toMatchObject({ ok: false, reason: "needs_switch_on" });
  });
  it("never dials personal, premium or dear special numbers", () => {
    expect(checkDial("+447000123456")).toMatchObject({ ok: false, reason: "never" });
    expect(checkDial("+449090123456")).toMatchObject({ ok: false, reason: "never" });
    expect(checkDial("+448443123456")).toMatchObject({ ok: false, reason: "never" });
    expect(checkDial("+448443123456", { allowPricier: true }).ok).toBe(false);
  });
  it("allows a cheap special (03) and ordinary US numbers", () => {
    expect(checkDial("+443301234567").ok).toBe(true);
    expect(checkDial("+12125551234").ok).toBe(true);
    expect(checkDial("+19075551234").ok).toBe(true);
  });
  it("refuses NANP premium areas that Twilio prices under plain +1", () => {
    expect(checkDial("+19005551234")).toMatchObject({ ok: false, reason: "never" });
    expect(checkDial("+19765551234")).toMatchObject({ ok: false, reason: "never" });
    expect(checkDial("+15005551234")).toMatchObject({ ok: false, reason: "never" });
  });
  it("refuses over the hard ceiling even with allowPricier", () => {
    expect(checkDial("+21650123456")).toMatchObject({ ok: false, reason: "over_ceiling" });
    expect(checkDial("+21650123456", { allowPricier: true })).toMatchObject({ ok: false, reason: "over_ceiling" });
  });
  it("refuses malformed input", () => {
    for (const bad of ["+44", "+44abc", "447400123456", "", null, undefined, 447400123456]) {
      expect(checkDial(bad)).toMatchObject({ ok: false, reason: "invalid" });
    }
  });
  it("callCostOf gives the longest-prefix entry or null", () => {
    expect(callCostOf("+447400123456")).toMatchObject({ iso: "GB", category: "mobile" });
    expect(callCostOf("garbage")).toBeNull();
  });
});

describe("checkText on the real table", () => {
  it("allows ordinary texts", () => {
    for (const n of ["+447400123456", "+12125551234", "+33612345678", "+447624123456"]) {
      expect(checkText(n).ok).toBe(true);
    }
  });
  it("refuses a dear text, a never number and garbage", () => {
    expect(checkText("+923001234567")).toMatchObject({ ok: false, reason: "over_ceiling" });
    expect(checkText("+447000123456")).toMatchObject({ ok: false, reason: "never" });
    expect(checkText("nonsense")).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("boundaries on a synthetic table", () => {
  const mk = (voice, sms) =>
    makeChecker(parseTable(JSON.stringify({ fetched: "2026-10-01T00:00:00Z", source: "t", voice, sms })));
  it("inclusive thresholds for voice", () => {
    const c = mk(
      {
        "21": [0.1, "AA", "fixed"],
        "22": [0.1001, "AA", "fixed"],
        "23": [0.6, "AA", "fixed"],
        "24": [0.6001, "AA", "fixed"],
        "25": [0.1, "AA", "special"],
        "26": [0.1001, "AA", "special"],
      },
      { AA: 0.25 }
    );
    expect(c.checkDial("+21234567").ok).toBe(true);
    expect(c.checkDial("+22234567")).toMatchObject({ ok: false, reason: "needs_switch_on" });
    expect(c.checkDial("+23234567")).toMatchObject({ ok: false, reason: "needs_switch_on" });
    expect(c.checkDial("+23234567", { allowPricier: true }).ok).toBe(true);
    expect(c.checkDial("+24234567")).toMatchObject({ ok: false, reason: "over_ceiling" });
    expect(c.checkDial("+24234567", { allowPricier: true })).toMatchObject({ ok: false, reason: "over_ceiling" });
    expect(c.checkDial("+25234567").ok).toBe(true);
    expect(c.checkDial("+26234567")).toMatchObject({ ok: false, reason: "never" });
  });
  it("allowPricier is strict", () => {
    const c = mk({ "23": [0.6, "AA", "fixed"] }, { AA: 0.1 });
    expect(c.checkDial("+23234567", { allowPricier: "true" }).ok).toBe(false);
    expect(c.checkDial("+23234567", { allowPricier: 1 }).ok).toBe(false);
  });
  it("inclusive threshold for texts, and unknown when no sms price", () => {
    const c = mk(
      { "21": [0.01, "AA", "fixed"], "22": [0.01, "BB", "fixed"], "23": [0.01, "CC", "fixed"] },
      { AA: 0.25, BB: 0.2501 }
    );
    expect(c.checkText("+21234567").ok).toBe(true);
    expect(c.checkText("+22234567")).toMatchObject({ ok: false, reason: "over_ceiling" });
    expect(c.checkText("+23234567")).toMatchObject({ ok: false, reason: "unknown" });
    expect(c.checkText("+29999999")).toMatchObject({ ok: false, reason: "unknown" });
  });
});

describe("parseTable", () => {
  const good = () => ({
    fetched: "2026-10-01T00:00:00Z",
    source: "t",
    voice: { "44": [0.01, "GB", "fixed"] },
    sms: { GB: 0.05 },
  });
  const t = (o) => () => parseTable(typeof o === "string" ? o : JSON.stringify(o));
  it("accepts a good table", () => {
    expect(t(good())).not.toThrow();
  });
  it("throws on anything malformed", () => {
    expect(t("not json")).toThrow();
    expect(t("null")).toThrow();
    const noVoice = good();
    delete noVoice.voice;
    expect(t(noVoice)).toThrow();
    expect(t({ ...good(), voice: {} })).toThrow();
    expect(t({ ...good(), sms: {} })).toThrow();
    expect(t({ ...good(), voice: { "44": [-1, "GB", "fixed"] } })).toThrow();
    expect(t({ ...good(), voice: { "44": [0.01, "GBR", "fixed"] } })).toThrow();
    expect(t({ ...good(), voice: { "44": [0.01, "GB", "weird"] } })).toThrow();
    expect(t({ ...good(), voice: { "44": [null, "GB", "fixed"] } })).toThrow();
    expect(t({ ...good(), sms: { GB: -0.1 } })).toThrow();
    expect(t({ ...good(), fetched: "yesterday-ish" })).toThrow();
    expect(t({ ...good(), fetched: undefined })).toThrow();
  });
});

describe("tableAgeDays", () => {
  const fetched = new Date(JSON.parse(readFileSync(new URL("../lib/dialCostTable.json", import.meta.url), "utf8")).fetched);
  it("counts whole days since fetched", () => {
    expect(tableAgeDays(fetched)).toBe(0);
    expect(tableAgeDays(new Date(fetched.getTime() + 3.9 * 86400000))).toBe(3);
    expect(tableAgeDays(new Date(fetched.getTime() + 121 * 86400000))).toBe(121);
  });
});
