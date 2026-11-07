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
