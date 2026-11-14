/**
 * The two intake message settings and the compliance tier on the config.
 * Settings are read through accessors so an unknown value reads as the default.
 */
import { describe, it, expect } from "vitest";

const { confirmStyleOf, spellUpFrontOf, isHealthcareTier, INTAKE_CALLER_TYPES, LEAD_LIKE } = await import(
  "../lib/capabilities/intakeSettings.js"
);
const { validateCapabilityConfig } = await import("../lib/capabilities/configSchema.js");
const { loadConfig } = await import("../services/db.js");
const { CALLER_TYPES } = await import("../lib/capabilities/customerRequests.js");
const messages = (await import("../capabilities/messages.js")).default;

const cfg = (m) => ({ capabilities: { messages: m } });

describe("confirmStyleOf", () => {
  it("defaults to end", () => {
    expect(confirmStyleOf({})).toBe("end");
    expect(confirmStyleOf(null)).toBe("end");
  });
  it("reads each", () => {
    expect(confirmStyleOf(cfg({ confirmStyle: "each" }))).toBe("each");
  });
  it("an unknown value reads as the default", () => {
    expect(confirmStyleOf(cfg({ confirmStyle: "loud" }))).toBe("end");
  });
});

describe("spellUpFrontOf", () => {
  it("covers all three values and the default", () => {
    expect(spellUpFrontOf({})).toBe("no");
    expect(spellUpFrontOf(cfg({ spellUpFront: "no" }))).toBe("no");
    expect(spellUpFrontOf(cfg({ spellUpFront: "leads" }))).toBe("leads");
    expect(spellUpFrontOf(cfg({ spellUpFront: "everyone" }))).toBe("everyone");
    expect(spellUpFrontOf(cfg({ spellUpFront: "x" }))).toBe("no");
  });
});

describe("isHealthcareTier", () => {
  it("is true only for hipaa", () => {
    expect(isHealthcareTier({ complianceTier: "hipaa" })).toBe(true);
    expect(isHealthcareTier({})).toBe(false);
    expect(isHealthcareTier({ complianceTier: "standard" })).toBe(false);
  });
});

describe("caller type lists", () => {
  it("INTAKE_CALLER_TYPES is CALLER_TYPES plus wrong_number, frozen", () => {
    expect(INTAKE_CALLER_TYPES).toEqual([...CALLER_TYPES, "wrong_number"]);
    expect(Object.isFrozen(INTAKE_CALLER_TYPES)).toBe(true);
  });
  it("LEAD_LIKE is new_enquiry and existing_customer", () => {
    expect([...LEAD_LIKE].sort()).toEqual(["existing_customer", "new_enquiry"]);
  });
});

describe("validateCapabilityConfig, messages", () => {
  it("keeps valid settings", () => {
    const out = validateCapabilityConfig({ confirmStyle: "each", spellUpFront: "leads" }, messages);
    expect(out.confirmStyle).toBe("each");
    expect(out.spellUpFront).toBe("leads");
  });
  it("drops an unknown value", () => {
    const out = validateCapabilityConfig({ confirmStyle: "loud", spellUpFront: "sometimes" }, messages);
    expect(out.confirmStyle).toBeUndefined();
    expect(out.spellUpFront).toBeUndefined();
  });
});

describe("loadConfig carries complianceTier", () => {
  const row = { id: "b1", name: "Test Co", allowed_tasks: [] };
  it("hipaa tenant", () => {
    expect(loadConfig({ ...row, compliance_tier: "hipaa" }).complianceTier).toBe("hipaa");
  });
  it("standard tenant", () => {
    expect(loadConfig(row).complianceTier).toBe("standard");
  });
  it("the no-business branch carries it too", () => {
    expect(loadConfig(null).complianceTier).toMatch(/^(standard|hipaa)$/);
  });
});
