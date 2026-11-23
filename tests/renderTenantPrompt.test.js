import { describe, it, expect } from "vitest";
import { renderTenantPrompt, payloadToConfig } from "../scripts/render-tenant-prompt.js";
import { buildSystemInstruction } from "../services/gemini.js";

// A reserved, fictional business: example.com style names only.
const BASE = {
  business: {
    name: "Example Plumbing Co",
    timezone: "Europe/London",
    greeting: "Thanks for calling Example Plumbing. I'm an AI assistant. How can I help?",
    general_info: "We fix boilers and taps.",
    compliance_tier: "standard",
  },
  capabilities: [
    { capability_id: "messages", enabled: true, config: { notes: "Ask whether it is a leak or a quote." } },
    { capability_id: "appointments", enabled: false, config: {} },
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

describe("renderTenantPrompt", () => {
  it("returns the prompt, its length and no warnings for a clean payload", () => {
    const r = renderTenantPrompt(BASE);
    expect(typeof r.prompt).toBe("string");
    expect(r.chars).toBe(r.prompt.length);
    expect(r.warnings).toEqual([]);
  });

  it("warns on custom_instructions over 2000, from the raw value", () => {
    const p = clone(BASE);
    p.business.custom_instructions = "x".repeat(2001);
    const r = renderTenantPrompt(p);
    expect(r.warnings.some((w) => /custom_instructions/.test(w) && /2001/.test(w))).toBe(true);
    // exactly at the limit is fine
    p.business.custom_instructions = "x".repeat(2000);
    expect(renderTenantPrompt(p).warnings).toEqual([]);
  });

  it("warns on capability notes over 2000", () => {
    const p = clone(BASE);
    p.capabilities[0].config.notes = "n".repeat(2500);
    const r = renderTenantPrompt(p);
    expect(r.warnings.some((w) => /messages/.test(w) && /notes/.test(w) && /2500/.test(w))).toBe(true);
  });

  it("warns on general_info over 2000", () => {
    const p = clone(BASE);
    p.business.general_info = "g".repeat(2100);
    expect(renderTenantPrompt(p).warnings.some((w) => /general_info/.test(w))).toBe(true);
  });

  it("messages notes appear in the prompt with appointments disabled", () => {
    const r = renderTenantPrompt(BASE);
    expect(r.prompt).toContain("Ask whether it is a leak or a quote.");
  });

  it("a disabled appointments capability leaves no booking language in the prompt", () => {
    const r = renderTenantPrompt(BASE);
    // The offer, the tool name and the scheduling rules are what a caller could
    // act on. The generic rules (read-back wording, the "you cannot book" line)
    // are in the prompt either way and are not booking language.
    expect(r.prompt).not.toMatch(/check_appointment_availability|book appointments|When scheduling, always calculate/i);
    expect(r.prompt).toMatch(/You cannot book, check, cancel, or reschedule/);
  });

  it("an enabled appointments capability does bring booking language in (the check above is not vacuous)", () => {
    const p = clone(BASE);
    p.capabilities[1].enabled = true;
    expect(renderTenantPrompt(p).prompt).toMatch(/check_appointment_availability/);
  });

  it("payloadToConfig builds the exact config the prompt is rendered from", () => {
    // The eval runner tests a real tenant payload through this; if it drifted
    // from what renderTenantPrompt renders, a sim would test a different agent.
    const config = payloadToConfig(BASE);
    const prompt = buildSystemInstruction("greeting", null, config, { greetingSpoken: false });
    expect(prompt).toBe(renderTenantPrompt(BASE).prompt);
    expect(config.businessName).toBe("Example Plumbing Co");
  });

  it("payloadToConfig refuses a payload with no business object", () => {
    expect(() => payloadToConfig({ capabilities: [] })).toThrow(/business/);
  });

  it("accepts capability / id spellings the importer accepts", () => {
    const p = clone(BASE);
    p.capabilities = [{ capability: "messages", config: { notes: "Spelling check note." } }];
    expect(renderTenantPrompt(p).prompt).toContain("Spelling check note.");
  });
});
