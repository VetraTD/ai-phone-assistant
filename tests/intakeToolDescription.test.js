/**
 * Fix wave I5: record_customer_request's description on the standard tier says
 * to save as soon as the caller's name and what it is about are in hand, with a
 * number only if theirs did not come through. Live reads the description on
 * every turn. The healthcare tier keeps today's text byte for byte.
 */
import { describe, it, expect } from "vitest";
import { buildAllDeclarations } from "../services/gemini.js";
import messages from "../capabilities/messages.js";

const CONFIG = {
  businessName: "Testwork Services",
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: { messages: { enabled: true } },
};
const descriptionOf = (config) =>
  buildAllDeclarations(config, {}).find((d) => d.name === "record_customer_request").description;

describe("record_customer_request description (fix wave I5)", () => {
  it("standard tier: save as soon as name and subject are in hand, a number only if needed", () => {
    for (const d of [descriptionOf(CONFIG), messages.tools(CONFIG)[0].description]) {
      expect(d).toContain("as soon as you have the caller's name and what it is about");
      expect(d).toContain("a number only if theirs did not come through");
      expect(d).not.toMatch(/after collecting/i);
      expect(d).not.toMatch(/"[^"]+\?"/);
    }
  });

  it("healthcare tier: today's text, byte for byte", () => {
    const hipaa = { ...CONFIG, complianceTier: "hipaa" };
    const expected =
      "Record a message or callback request after collecting the caller's name, " +
      "callback number, and message (and preferred callback time for callbacks). " +
      "Call this when the caller wants to leave a message or have someone call them back.";
    expect(descriptionOf(hipaa)).toBe(expected);
    expect(messages.tools(hipaa)[0].description).toBe(expected);
  });

  it("the parameters are the same on both tiers", () => {
    const hipaa = messages.tools({ ...CONFIG, complianceTier: "hipaa" })[0].parameters;
    expect(messages.tools(CONFIG)[0].parameters).toEqual(hipaa);
  });
});
