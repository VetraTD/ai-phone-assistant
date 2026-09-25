// tests/outboundGate.test.js
import { describe, it, expect } from "vitest";
import { evaluateGate } from "../lib/outbound/gate.js";
import { TEMPLATES } from "../lib/outbound/templates.js";

const NOW = new Date("2026-09-28T13:00:00Z"); // Mon 14:00 London
const base = () => ({
  now: NOW,
  env: { enabled: false, allowlist: new Set(["+447700900001"]), maxConcurrent: 8, inboundReserve: 2 },
  business: { outbound_enabled: true, outbound_max_concurrent: 2 },
  campaign: { status: "active", compliance_class: "solicited", template_key: "speed_to_lead",
    config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" } },
  contact: { phone_e164: "+447700900001", timezone: "Europe/London" },
  outreach: { attempts_made: 0, created_at: new Date("2026-09-28T12:59:00Z"), hold_until: null },
  suppressed: false,
  consents: [{ purpose: "enquiry_followup", channels: ["call"], covers_automated: true, captured_at: new Date("2026-09-28T12:58:00Z"), expires_at: null, revoked_at: null }],
  hasRelationship: false,
  dialsToday: 0,
  active: { globalOutbound: 0, businessOutbound: 0 },
  callerIdValid: true,
});
const gate = (f) => evaluateGate(f, { rand: () => 0 });

describe("evaluateGate: the base case dials", () => {
  it("allows an allow-listed number with the global switch off", () => expect(gate(base())).toEqual({ verdict: "allow" }));
});

describe("evaluateGate: each check refuses on its own (11 reasons)", () => {
  const cases = [
    ["global_disabled", "never", (f) => { f.contact.phone_e164 = "+447700900999"; }],
    ["business_disabled", "never", (f) => { f.business.outbound_enabled = false; }],
    ["campaign_paused", "later", (f) => { f.campaign.status = "paused"; }],
    ["suppressed", "never", (f) => { f.suppressed = true; }],
    ["consent_missing", "never", (f) => { f.consents = []; }],
    ["silent_hold", "later", (f) => { f.outreach.hold_until = new Date("2026-09-30T13:00:00Z"); }],
    ["outside_window", "later", (f) => { f.now = new Date("2026-09-28T20:30:00Z"); f.outreach.created_at = new Date("2026-09-28T20:00:00Z"); f.consents[0].captured_at = f.outreach.created_at; }],
    ["attempts_exhausted", "never", (f) => { f.outreach.attempts_made = 5; }],
    ["give_up_window", "never", (f) => { f.outreach.created_at = new Date("2026-09-10T12:00:00Z"); f.consents[0].captured_at = new Date("2026-09-27T12:00:00Z"); }],
    ["daily_contact_cap", "later", (f) => { f.dialsToday = 3; }],
    ["capacity", "later", (f) => { f.active.businessOutbound = 2; }],
    ["caller_id_invalid", "never", (f) => { f.callerIdValid = false; }],
  ];
  it.each(cases)("%s -> %s", (reason, verdict, mutate) => {
    const f = base(); mutate(f);
    expect(gate(f)).toMatchObject({ verdict, reason });
  });

  it("global capacity: outbound at max - reserve is refused even when the business has room", () => {
    const f = base(); f.active.globalOutbound = 6;
    expect(gate(f)).toMatchObject({ verdict: "later", reason: "capacity" });
  });
});

describe("evaluateGate: 'later' carries a time", () => {
  it("capacity retries 30 s later", () => {
    const f = base(); f.active.businessOutbound = 2;
    expect(gate(f).at.toISOString()).toBe("2026-09-28T13:00:30.000Z");
  });
  it("outside the window retries at the next opening (+ jitter, 0 here)", () => {
    const f = base(); f.now = new Date("2026-09-28T20:30:00Z"); f.outreach.created_at = new Date("2026-09-28T20:00:00Z"); f.consents[0].captured_at = f.outreach.created_at;
    expect(gate(f).at.toISOString()).toBe("2026-09-29T08:00:00.000Z"); // Tue 09:00 BST
  });
  it("daily cap retries at tomorrow's opening", () => {
    const f = base(); f.dialsToday = 3;
    expect(gate(f).at.toISOString()).toBe("2026-09-29T08:00:00.000Z");
  });
  it("a paused campaign holds without a time -- resuming re-enqueues", () => {
    const f = base(); f.campaign.status = "paused";
    expect(gate(f)).toEqual({ verdict: "later", reason: "campaign_paused", at: null });
  });
});

describe("evaluateGate: order -- the first failure decides", () => {
  it("suppressed beats outside_window", () => {
    const f = base(); f.suppressed = true; f.now = new Date("2026-09-28T20:30:00Z");
    expect(gate(f).reason).toBe("suppressed");
  });
  it("global_disabled beats everything", () => {
    const f = base(); f.contact.phone_e164 = "+447700900999"; f.suppressed = true; f.callerIdValid = false;
    expect(gate(f).reason).toBe("global_disabled");
  });
});
