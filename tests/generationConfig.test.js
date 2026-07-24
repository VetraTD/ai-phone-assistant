import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveGenerationConfig, buildThinkingConfig } from "../services/gemini.js";

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

describe("services/gemini.js — buildThinkingConfig", () => {
  // Full model × budget matrix from the task brief: gemini-2.5-flash keeps the
  // legacy shape byte-identical; gemini-3.x models (matched by a `gemini-3`
  // prefix) get thinkingLevel instead, since Task 6 found tools+thinkingBudget
  // 400s INVALID_ARGUMENT on gemini-3.6-flash.
  const MODELS = ["gemini-2.5-flash", "gemini-3.6-flash", "gemini-3-flash-preview"];
  const BUDGETS = [0, 128, 512, undefined];

  it("gemini-2.x models always get the legacy { thinkingBudget } shape, byte-identical", () => {
    expect(buildThinkingConfig("gemini-2.5-flash", 0)).toEqual({ thinkingBudget: 0 });
    expect(buildThinkingConfig("gemini-2.5-flash", 128)).toEqual({ thinkingBudget: 128 });
    expect(buildThinkingConfig("gemini-2.5-flash", 512)).toEqual({ thinkingBudget: 512 });
    // undefined (no override resolved) falls back to 0 — same as the resolved
    // generationConfig default; this branch is never hit via the real
    // resolveGenerationConfig path (which always returns a number), but the
    // pure helper stays defined for it rather than emitting `NaN`/`undefined`.
    expect(buildThinkingConfig("gemini-2.5-flash", undefined)).toEqual({ thinkingBudget: 0 });
  });

  it("gemini-3.x models never receive a thinkingBudget key", () => {
    for (const model of ["gemini-3.6-flash", "gemini-3-flash-preview"]) {
      for (const budget of BUDGETS) {
        const result = buildThinkingConfig(model, budget);
        expect(result).not.toHaveProperty("thinkingBudget");
        expect(result).toHaveProperty("thinkingLevel");
      }
    }
  });

  it("maps our budget semantic to a thinkingLevel for gemini-3.x models", () => {
    for (const model of ["gemini-3.6-flash", "gemini-3-flash-preview"]) {
      expect(buildThinkingConfig(model, 0)).toEqual({ thinkingLevel: "minimal" });
      expect(buildThinkingConfig(model, undefined)).toEqual({ thinkingLevel: "minimal" });
      expect(buildThinkingConfig(model, 128)).toEqual({ thinkingLevel: "low" });
      expect(buildThinkingConfig(model, 512)).toEqual({ thinkingLevel: "medium" });
      expect(buildThinkingConfig(model, 2048)).toEqual({ thinkingLevel: "high" });
    }
  });

  it("full model x budget matrix produces a defined, model-appropriate shape for every combination", () => {
    for (const model of MODELS) {
      for (const budget of BUDGETS) {
        const result = buildThinkingConfig(model, budget);
        if (model.startsWith("gemini-3")) {
          expect(Object.keys(result)).toEqual(["thinkingLevel"]);
          expect(["minimal", "low", "medium", "high"]).toContain(result.thinkingLevel);
        } else {
          expect(Object.keys(result)).toEqual(["thinkingBudget"]);
          expect(typeof result.thinkingBudget).toBe("number");
        }
      }
    }
  });

  it("matches a gemini-3.x prefix regardless of point-release suffix", () => {
    expect(buildThinkingConfig("gemini-3.1-pro-preview", 0)).toEqual({ thinkingLevel: "minimal" });
    expect(buildThinkingConfig("gemini-3-pro", 0)).toEqual({ thinkingLevel: "minimal" });
  });

  it("leaves other model generations (2.0, 1.5, ...) on the legacy shape", () => {
    expect(buildThinkingConfig("gemini-2.0-flash", 128)).toEqual({ thinkingBudget: 128 });
    expect(buildThinkingConfig("gemini-1.5-pro", 0)).toEqual({ thinkingBudget: 0 });
  });
});
