import { describe, it, expect } from "vitest";
import { buildSystemInstruction, buildAllDeclarations } from "../services/gemini.js";
import { getStrings } from "../lib/voice/strings.js";
import { STEPS } from "../lib/callState.js";

// Owner decision (pronunciation design, 2026-10-20): the goodbye drops the
// business name -- "Thanks for calling, have a great day" -- for every
// business. One fewer place the name can be mispronounced, at the moment the
// caller remembers best.

const config = {
  businessName: "Acme Dental",
  timezone: "America/Chicago",
  allowedTasks: ["general_question", "take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
};
const extras = { greetingSpoken: false, intentMarker: false };

describe("goodbye without the business name", () => {
  it("the inbound end_call rule says 'thank them for calling' with no name", () => {
    const prompt = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, config, extras);
    expect(prompt).toContain("thank them for calling and wish them well");
    expect(prompt).not.toContain("thank them for calling Acme Dental");
  });

  it("the end_call tool description no longer asks for the business name", () => {
    const endCall = buildAllDeclarations(config, extras).find((d) => d.name === "end_call");
    expect(endCall.description).toContain("thank them for calling");
    expect(endCall.description).not.toContain("use the business name");
  });

  it("the fallback sign-off has no name, in English and Spanish", () => {
    expect(getStrings({}).signOff("Acme Dental")).toBe("Thank you for calling. Have a great day!");
    expect(getStrings({ languagesSpoken: ["es"], locale: "es-US" }).signOff("Acme Dental")).not.toContain("Acme");
  });

  it("the goodbye detector still recognises the name-free goodbye", () => {
    const S = getStrings({});
    for (const g of ["Thank you for calling. Have a great day!", "Thanks for calling, have a great day.", "Thanks for calling, take care."]) {
      expect(S.signOffRe.test(g)).toBe(true);
    }
    const es = getStrings({ languagesSpoken: ["es"], locale: "es-US" });
    expect(es.signOffRe.test(es.signOff())).toBe(true);
  });
});
