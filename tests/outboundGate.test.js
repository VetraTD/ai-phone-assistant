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
    ["daily_contact_cap", "later", (f) => { f.env.enabled = true; f.dialsToday = 3; }],
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
  it("silent_hold's at equals the hold time when it is inside the window", () => {
    const f = base();
    f.outreach.hold_until = new Date("2026-09-28T15:00:00Z"); // Mon 16:00 BST, inside 09:00-20:00
    expect(gate(f)).toEqual({ verdict: "later", reason: "silent_hold", at: new Date("2026-09-28T15:00:00Z") });
  });
  it("capacity retries 30 s later", () => {
    const f = base(); f.active.businessOutbound = 2;
    expect(gate(f).at.toISOString()).toBe("2026-09-28T13:00:30.000Z");
  });
  it("outside the window retries at the next opening (+ jitter, 0 here)", () => {
    const f = base(); f.now = new Date("2026-09-28T20:30:00Z"); f.outreach.created_at = new Date("2026-09-28T20:00:00Z"); f.consents[0].captured_at = f.outreach.created_at;
    expect(gate(f).at.toISOString()).toBe("2026-09-29T08:00:00.000Z"); // Tue 09:00 BST
  });
  it("daily cap retries at tomorrow's opening", () => {
    const f = base(); f.env.enabled = true; f.dialsToday = 3;
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

describe("evaluateGate: cheap pinning gaps", () => {
  it("env.enabled=true allows a number that is not on the allow-list", () => {
    const f = base(); f.env.enabled = true; f.contact.phone_e164 = "+447700900999";
    expect(gate(f)).toEqual({ verdict: "allow" });
  });
  it("dialsToday=2 still allows (below the cap of 3)", () => {
    const f = base(); f.dialsToday = 2;
    expect(gate(f)).toEqual({ verdict: "allow" });
  });
});

// F4 (Checkpoint 2a, owner-approved). scripts/outbound-admin.js refuses to
// write an "operator-test" consent unless the number is on the MIGRATE JOB's
// OUTBOUND_TEST_ALLOWLIST -- but that row then outlives the list. At dial
// time it counts only while the number is on the SERVICE's allow-list
// (env.allowlist, the dispatcher's own outboundEnv()).
describe("evaluateGate: an operator-test consent counts only while the number is allow-listed (F4)", () => {
  const operatorTest = () => ({ ...base().consents[0], source: "manual", wording_version: "operator-test" });

  it("operator-test consent, number on the service allow-list, outbound enabled: allow", () => {
    const f = base(); f.env.enabled = true; f.consents = [operatorTest()];
    expect(gate(f)).toEqual({ verdict: "allow" });
  });

  it("the same consent once the number is OFF the allow-list (outbound enabled): consent_missing", () => {
    const f = base(); f.env.enabled = true; f.env.allowlist = new Set(); f.consents = [operatorTest()];
    expect(gate(f)).toEqual({ verdict: "never", reason: "consent_missing" });
  });

  it("an ordinary consent is unaffected by the allow-list", () => {
    const f = base(); f.env.enabled = true; f.env.allowlist = new Set();
    f.consents = [{ ...base().consents[0], source: "form", wording_version: "v3" }];
    expect(gate(f)).toEqual({ verdict: "allow" });
  });

  it("an ordinary consent still counts alongside a dropped operator-test one", () => {
    const f = base(); f.env.enabled = true; f.env.allowlist = new Set();
    f.consents = [operatorTest(), { ...base().consents[0], source: "form", wording_version: null }];
    expect(gate(f)).toEqual({ verdict: "allow" });
  });

  it("a consent with no wording_version at all (the column is nullable) is not an error", () => {
    const f = base(); const c = { ...base().consents[0] }; delete c.wording_version; f.consents = [c];
    expect(gate(f)).toEqual({ verdict: "allow" });
  });
});

// X3 (owner decision, 2026-09-26). While OUTBOUND_ENABLED=false, check 1
// already refuses every number that is not on the allow-list -- so this
// exemption can only ever reach the operator's own test handsets, and it
// becomes inert the instant outbound is switched on. Live round 1 needs ~11
// dials to one handset in one day.
describe("evaluateGate: the daily-cap exemption while outbound is OFF (owner decision, 2026-09-26)", () => {
  it("OFF + allow-listed + dialsToday 5 -> allow (the cap does not apply)", () => {
    const f = base(); f.dialsToday = 5; // base() is already env.enabled:false, allow-listed
    expect(gate(f)).toEqual({ verdict: "allow" });
  });

  it("ON + allow-listed + dialsToday 3 -> still daily_contact_cap (the exemption is OFF-only)", () => {
    const f = base(); f.env.enabled = true; f.dialsToday = 3;
    expect(gate(f)).toMatchObject({ verdict: "later", reason: "daily_contact_cap" });
  });

  it("OFF + NOT allow-listed + dialsToday 3 -> never/global_disabled (check 9 is never reached)", () => {
    const f = base(); f.contact.phone_e164 = "+447700900999"; f.dialsToday = 3;
    expect(gate(f)).toEqual({ verdict: "never", reason: "global_disabled" });
  });

  it("missing dialsToday still throws even OFF + allow-listed (the exemption never bypasses fact validation)", () => {
    const f = base(); delete f.dialsToday;
    expect(() => gate(f)).toThrow(/gate fact/);
  });

  it("NaN dialsToday still throws even OFF + allow-listed", () => {
    const f = base(); f.dialsToday = NaN;
    expect(() => gate(f)).toThrow(/gate fact/);
  });
});

describe("evaluateGate: a missing or malformed fact throws, never allows", () => {
  // Task 9 builds `facts` from DB helpers; a wrong alias or an unguarded `?.`
  // there must not silently switch a check off (e.g. do-not-call, the daily
  // cap). So a fact that is missing or the wrong shape throws -- dispatch
  // then sees a 500, not a dial and not a permanent close of the outreach.
  const badCases = [
    ["now missing", (f) => { delete f.now; }],
    ["now invalid", (f) => { f.now = new Date("garbage"); }],
    ["env.enabled not a boolean", (f) => { f.env.enabled = "false"; }],
    ["env.allowlist not a Set", (f) => { f.env.allowlist = ["+447700900001"]; }],
    ["env.maxConcurrent not finite", (f) => { delete f.env.maxConcurrent; }],
    ["env.inboundReserve undefined", (f) => { f.env.inboundReserve = undefined; }],
    ["business.outbound_enabled not a boolean", (f) => { f.business.outbound_enabled = 1; }],
    ["business.outbound_max_concurrent not finite", (f) => { f.business.outbound_max_concurrent = "2"; }],
    ["campaign.config not an object", (f) => { f.campaign.config = null; }],
    ["campaign.config.retries.schedule not an array", (f) => { f.campaign.config.retries.schedule = "now"; }],
    ["campaign.config.calling_window not an object", (f) => { f.campaign.config.calling_window = null; }],
    ["contact.phone_e164 not a non-empty string", (f) => { f.contact.phone_e164 = ""; }],
    ["contact.timezone empty", (f) => { f.contact.timezone = ""; }],
    ["outreach.attempts_made undefined", (f) => { f.outreach.attempts_made = undefined; }],
    ["outreach.created_at garbage", (f) => { f.outreach.created_at = "garbage"; }],
    ["outreach.hold_until unparsable", (f) => { f.outreach.hold_until = "garbage"; }],
    ["suppressed undefined", (f) => { f.suppressed = undefined; }],
    ["suppressed null", (f) => { f.suppressed = null; }],
    ["hasRelationship not a boolean", (f) => { f.hasRelationship = "no"; }],
    ["callerIdValid undefined", (f) => { f.callerIdValid = undefined; }],
    ["consents not an array", (f) => { f.consents = null; }],
    ["dialsToday a numeric string", (f) => { f.dialsToday = "3"; }],
    ["active.globalOutbound not finite", (f) => { delete f.active.globalOutbound; }],
    ["active.businessOutbound not finite", (f) => { delete f.active.businessOutbound; }],
    ["active missing both counters", (f) => { f.active = {}; }],
    // Fix round 2: `!= null` treated a missing DB alias (undefined) the same
    // as an intentional `null`, so check 6 silently disabled instead of
    // throwing. Verified live: deleting outreach.hold_until gave "allow".
    ["outreach.hold_until undefined", (f) => { delete f.outreach.hold_until; }],
    // Same class: undefined here makes check 8b compare against NaN, so
    // give_up_window silently never fires.
    ["campaign.config.retries.give_up_after_days missing", (f) => { delete f.campaign.config.retries.give_up_after_days; }],
    ["campaign.status undefined", (f) => { f.campaign.status = undefined; }],
    ["campaign.compliance_class undefined", (f) => { f.campaign.compliance_class = undefined; }],
    ["campaign.template_key undefined", (f) => { f.campaign.template_key = undefined; }],
  ];
  it.each(badCases)("%s -> throws", (_label, mutate) => {
    const f = base(); mutate(f);
    expect(() => gate(f)).toThrow(/gate fact/);
  });
});
