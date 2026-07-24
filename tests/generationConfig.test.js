import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveGenerationConfig } from "../services/gemini.js";

// Env vars this helper reads. Saved/restored around every test so a value set
// in one test (or already present in the shell) never leaks into another.
const ENV_KEYS = [
  "GEMINI_MODEL",
  "GEMINI_TEMPERATURE",
  "GEMINI_THINKING_BUDGET",
  "GEMINI_MAX_OUTPUT_TOKENS",
];

describe("services/gemini.js — resolveGenerationConfig", () => {
  const savedEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("returns hardcoded defaults when nothing is set", () => {
    expect(resolveGenerationConfig()).toEqual({
      model: "gemini-2.5-flash",
      temperature: 0.4,
      thinkingBudget: 0,
      maxOutputTokens: 200,
    });
  });

  it("applies env var overrides", () => {
    process.env.GEMINI_MODEL = "gemini-2.0-flash";
    process.env.GEMINI_TEMPERATURE = "0.7";
    process.env.GEMINI_THINKING_BUDGET = "128";
    process.env.GEMINI_MAX_OUTPUT_TOKENS = "500";

    expect(resolveGenerationConfig()).toEqual({
      model: "gemini-2.0-flash",
      temperature: 0.7,
      thinkingBudget: 128,
      maxOutputTokens: 500,
    });
  });

  it("explicit overrides beat env vars, which beat defaults", () => {
    process.env.GEMINI_MODEL = "gemini-2.0-flash";
    process.env.GEMINI_TEMPERATURE = "0.7";

    const result = resolveGenerationConfig({ model: "gemini-2.5-pro", maxOutputTokens: 1000 });

    expect(result).toEqual({
      model: "gemini-2.5-pro", // override beats env
      temperature: 0.7, // env beats default
      thinkingBudget: 0, // default (no env, no override)
      maxOutputTokens: 1000, // override, no env set for this key
    });
  });

  it("ignores empty-string env vars, falling through to defaults", () => {
    process.env.GEMINI_MODEL = "";
    process.env.GEMINI_TEMPERATURE = "";
    process.env.GEMINI_THINKING_BUDGET = "";
    process.env.GEMINI_MAX_OUTPUT_TOKENS = "";

    expect(resolveGenerationConfig()).toEqual({
      model: "gemini-2.5-flash",
      temperature: 0.4,
      thinkingBudget: 0,
      maxOutputTokens: 200,
    });
  });

  it("ignores an unparseable numeric env var (NaN after parse), falling through to defaults", () => {
    process.env.GEMINI_MAX_OUTPUT_TOKENS = "abc";
    process.env.GEMINI_TEMPERATURE = "not-a-number";
    process.env.GEMINI_THINKING_BUDGET = "nope";

    expect(resolveGenerationConfig()).toEqual({
      model: "gemini-2.5-flash",
      temperature: 0.4,
      thinkingBudget: 0,
      maxOutputTokens: 200,
    });
  });

  it("ignores undefined/null override values, falling through to env/defaults", () => {
    process.env.GEMINI_TEMPERATURE = "0.9";

    const result = resolveGenerationConfig({
      model: undefined,
      temperature: null,
      thinkingBudget: undefined,
      maxOutputTokens: null,
    });

    expect(result).toEqual({
      model: "gemini-2.5-flash",
      temperature: 0.9,
      thinkingBudget: 0,
      maxOutputTokens: 200,
    });
  });
});
