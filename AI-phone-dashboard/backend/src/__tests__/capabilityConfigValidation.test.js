import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import schemas from "../generated/capabilitySchemas.json" with { type: "json" };

// The validator is CommonJS (module.exports), like the rest of this backend.
const require = createRequire(import.meta.url);
const { validateCapabilityConfig } = require("../capabilityConfigValidation.js");

const CALLBACK = "Sam will call you back as soon as he can.";

/**
 * Capability settings on the way in. The one property these pin down for
 * callbackLine: a dashboard save must not wipe it, and what is saved must be
 * exactly what the engine will say, so the value survives the loader unchanged.
 */
describe("capability config validation — messages.callbackLine", () => {
  const save = (raw) => validateCapabilityConfig(raw, "messages", schemas);

  it("keeps callbackLine on save, so a dashboard save does not wipe it", () => {
    const { config, errors } = save({ callbackLine: CALLBACK });
    expect(errors).toEqual([]);
    expect(config.callbackLine).toBe(CALLBACK);
  });

  it("keeps it alongside the other message settings", () => {
    const { config, errors } = save({ notes: "Ask for the department.", callbackLine: CALLBACK });
    expect(errors).toEqual([]);
    expect(config).toEqual({ notes: "Ask for the department.", callbackLine: CALLBACK });
  });

  it("rejects a non-string and names it", () => {
    const { config, errors } = save({ callbackLine: 42 });
    expect(config.callbackLine).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("rejects a line over 160 characters rather than cutting it", () => {
    const { config, errors } = save({ callbackLine: "x".repeat(161) });
    expect(config.callbackLine).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("stores the cleaned line the engine would speak: no double quotes, no newlines", () => {
    const { config, errors } = save({ callbackLine: 'Sam says "hi"\n\nthanks' });
    expect(errors).toEqual([]);
    expect(config.callbackLine).toBe("Sam says hi thanks");
  });

  it("a blank line is absence, not an error", () => {
    const { config, errors } = save({ callbackLine: "   " });
    expect(errors).toEqual([]);
    expect(config.callbackLine).toBeUndefined();
  });
});

// A save from the dashboard must never quietly drop a setting the voice engine
// honours. Every top-level choice in every pack's schema, and the required
// fields list, survive a round trip through the check unchanged.
describe("every setting the engine reads survives a dashboard save", () => {
  for (const def of schemas.capabilities) {
    const schema = def.configSchema || {};
    const choices = Object.entries(schema).filter(([key, node]) => key !== "adapter" && node?.type === "choice");
    if (!choices.length) continue;
    it(`${def.id}: each choice keeps every allowed value`, () => {
      for (const [key, node] of choices) {
        for (const option of node.options) {
          const { config, errors } = validateCapabilityConfig({ [key]: option }, def.id, schemas);
          expect(errors, `${def.id}.${key}=${option}`).toEqual([]);
          expect(config[key], `${def.id}.${key}=${option}`).toBe(option);
        }
      }
    });
    it(`${def.id}: a choice outside the options is refused, not silently dropped`, () => {
      for (const [key] of choices) {
        const { errors } = validateCapabilityConfig({ [key]: "not-an-option" }, def.id, schemas);
        expect(errors.length, key).toBeGreaterThan(0);
      }
    });
  }

  it("keeps the messages pack's intake choices together with its other settings", () => {
    const raw = { notes: "Ask which department", callbackLine: "Sam will call you back.", confirmStyle: "each", spellUpFront: "leads" };
    const { config, errors } = validateCapabilityConfig(raw, "messages", schemas);
    expect(errors).toEqual([]);
    expect(config).toEqual(raw);
  });

  it("keeps a required-fields list", () => {
    const { config, errors } = validateCapabilityConfig({ require: { requiredFields: ["company", "postcode"] } }, "messages", schemas);
    expect(errors).toEqual([]);
    expect(config.require.requiredFields).toEqual(["company", "postcode"]);
  });
});

// Fix round 2 (LVX192): an operator list on the messages pack. A dashboard save
// replaces the whole config, so a key the validator does not keep is wiped.
describe("a list setting survives a dashboard save (questionsSkipReasonPrefixes)", () => {
  const save = (raw) => validateCapabilityConfig(raw, "messages", schemas);

  it("keeps the list, trimmed", () => {
    const { config, errors } = save({ notes: "Ask for the pickup.", questionsSkipReasonPrefixes: ["URGENT", " Lost property "] });
    expect(errors).toEqual([]);
    expect(config.questionsSkipReasonPrefixes).toEqual(["URGENT", "Lost property"]);
  });

  it("refuses a value the engine would drop", () => {
    expect(save({ questionsSkipReasonPrefixes: "URGENT" }).errors.length).toBe(1);
    expect(save({ questionsSkipReasonPrefixes: ["x".repeat(41)] }).errors.length).toBe(1);
    expect(save({ questionsSkipReasonPrefixes: ["a", "b", "c", "d", "e", "f"] }).errors.length).toBe(1);
    expect(save({ questionsSkipReasonPrefixes: [7] }).errors.length).toBe(1);
  });

  it("an empty list is absence, not an error", () => {
    const { config, errors } = save({ questionsSkipReasonPrefixes: [] });
    expect(errors).toEqual([]);
    expect(config.questionsSkipReasonPrefixes).toBeUndefined();
  });
});
