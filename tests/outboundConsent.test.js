// tests/outboundConsent.test.js
import { describe, it, expect } from "vitest";
import { consentSatisfies } from "../lib/outbound/consent.js";

const now = new Date("2026-09-28T12:00:00Z");
const c = (o = {}) => ({ purpose: "enquiry_followup", channels: ["call", "sms"], covers_automated: true,
  captured_at: new Date("2026-09-20T12:00:00Z"), expires_at: null, revoked_at: null, ...o });
const sol = (consents, extra = {}) => consentSatisfies({ complianceClass: "solicited", purpose: "enquiry_followup", consents, consentWindowDays: 30, hasRelationship: false, now, ...extra });

describe("solicited", () => {
  it("passes with a matching, automated, in-window, unrevoked consent", () => expect(sol([c()])).toEqual({ ok: true }));
  it("no consent at all -> consent_missing", () => expect(sol([])).toEqual({ ok: false, reason: "consent_missing" }));
  it("a consent for another purpose does not count", () => expect(sol([c({ purpose: "review" })]).reason).toBe("consent_missing"));
  it("a consent without the call channel does not count", () => expect(sol([c({ channels: ["sms"] })]).reason).toBe("consent_missing"));
  it("a revoked consent does not count", () => expect(sol([c({ revoked_at: new Date("2026-09-21T00:00:00Z") })]).reason).toBe("consent_missing"));
  it("consent that never mentioned automated/AI calls -> consent_not_automated", () => expect(sol([c({ covers_automated: false })]).reason).toBe("consent_not_automated"));
  it("captured more than consent_window_days ago -> consent_expired", () => expect(sol([c({ captured_at: new Date("2026-08-01T00:00:00Z") })]).reason).toBe("consent_expired"));
  it("past its own expires_at -> consent_expired", () => expect(sol([c({ expires_at: new Date("2026-09-27T00:00:00Z") })]).reason).toBe("consent_expired"));
  it("one good consent among bad ones is enough", () => expect(sol([c({ covers_automated: false }), c()])).toEqual({ ok: true }));
});

describe("service", () => {
  it("needs an existing relationship, not a consent", () => {
    expect(consentSatisfies({ complianceClass: "service", consents: [], hasRelationship: true, now })).toEqual({ ok: true });
    expect(consentSatisfies({ complianceClass: "service", consents: [c()], hasRelationship: false, now }).reason).toBe("consent_missing");
  });
});

describe("marketing_consented", () => {
  it("is refused outright in Part 1 even if a campaign row somehow carries it", () =>
    expect(consentSatisfies({ complianceClass: "marketing_consented", consents: [c()], hasRelationship: true, now }).ok).toBe(false));
});
