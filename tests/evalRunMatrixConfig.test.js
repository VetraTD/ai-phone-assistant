/**
 * Unit tests for eval/run.js's --matrix-file loading/validation
 * (loadMatrixConfigs). Pure file-parsing logic, no network — importing
 * eval/run.js is safe here because it guards `main()` behind an
 * argv[1]===this-module check (see the bottom of eval/run.js), so importing
 * it for its exports never runs the CLI or requires GEMINI_API_KEY.
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMatrixConfigs, computeMatrixExitCode } from "../eval/run.js";

describe("loadMatrixConfigs", () => {
  it("returns the built-in default matrix when no file path is given", async () => {
    const configs = await loadMatrixConfigs(null);
    expect(configs.length).toBeGreaterThanOrEqual(5);
    expect(configs.every((c) => typeof c.label === "string" && c.label)).toBe(true);
    expect(configs.map((c) => c.model)).toContain("gemini-2.5-flash");
  });

  it("loads and returns a valid JSON array from --matrix-file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-matrix-"));
    const file = path.join(dir, "configs.json");
    const custom = [{ label: "custom-a", model: "gemini-2.5-flash" }];
    await writeFile(file, JSON.stringify(custom));
    try {
      const configs = await loadMatrixConfigs(file);
      expect(configs).toEqual(custom);
    } finally {
      await unlink(file);
    }
  });

  it("throws a clear error when the file is not a JSON array", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-matrix-"));
    const file = path.join(dir, "configs.json");
    await writeFile(file, JSON.stringify({ label: "not-an-array" }));
    try {
      await expect(loadMatrixConfigs(file)).rejects.toThrow(/non-empty JSON array/);
    } finally {
      await unlink(file);
    }
  });

  it("throws a clear error when an entry is missing a label", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-matrix-"));
    const file = path.join(dir, "configs.json");
    await writeFile(file, JSON.stringify([{ model: "gemini-2.5-flash" }]));
    try {
      await expect(loadMatrixConfigs(file)).rejects.toThrow(/needs a non-empty string "label"/);
    } finally {
      await unlink(file);
    }
  });

  it("throws a clear error for malformed JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-matrix-"));
    const file = path.join(dir, "configs.json");
    await writeFile(file, "{ not valid json");
    try {
      await expect(loadMatrixConfigs(file)).rejects.toThrow(/not valid JSON/);
    } finally {
      await unlink(file);
    }
  });

  it("throws a clear 'missing model' error when an entry has no model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-matrix-"));
    const file = path.join(dir, "configs.json");
    await writeFile(file, JSON.stringify([{ label: "no-model-here" }]));
    try {
      await expect(loadMatrixConfigs(file)).rejects.toThrow(/entry 0 missing model/);
    } finally {
      await unlink(file);
    }
  });

  it("throws a clear 'missing model' error when model is present but not a non-empty string", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-matrix-"));
    const file = path.join(dir, "configs.json");
    await writeFile(file, JSON.stringify([{ label: "bad-model", model: "" }, { label: "b", model: "x" }]));
    try {
      await expect(loadMatrixConfigs(file)).rejects.toThrow(/entry 0 missing model/);
    } finally {
      await unlink(file);
    }
  });

  it("every DEFAULT_MATRIX entry (returned with no file arg) has a non-empty string model", async () => {
    const configs = await loadMatrixConfigs(null);
    expect(configs.every((c) => typeof c.model === "string" && c.model)).toBe(true);
  });
});

describe("computeMatrixExitCode", () => {
  it("exits 0 with no message when every servable config's scenarios all hard-pass", () => {
    const configEntries = [
      { results: [{ hardPass: true }, { hardPass: true }] },
      { results: [{ hardPass: true }] },
    ];
    const { exitCode, message } = computeMatrixExitCode(configEntries);
    expect(exitCode).toBe(0);
    expect(message).toBeNull();
  });

  it("exits 1 when any servable config has a hard-assertion failure", () => {
    const configEntries = [
      { results: [{ hardPass: true }] },
      { results: [{ hardPass: false }] },
    ];
    const { exitCode } = computeMatrixExitCode(configEntries);
    expect(exitCode).toBe(1);
  });

  it("exits 1 with a clear message when every config was unavailable (probe-skipped, empty results everywhere)", () => {
    const configEntries = [
      { results: [] },
      { results: [] },
    ];
    const { exitCode, message } = computeMatrixExitCode(configEntries);
    expect(exitCode).toBe(1);
    expect(message).toMatch(/unavailable/i);
    expect(message).toMatch(/no scenario data/i);
  });

  it("does not treat a mix of skipped and servable configs as all-unavailable", () => {
    const configEntries = [
      { results: [] }, // skipped
      { results: [{ hardPass: true }] }, // servable, all pass
    ];
    const { exitCode, message } = computeMatrixExitCode(configEntries);
    expect(exitCode).toBe(0);
    expect(message).toBeNull();
  });

  it("treats an empty configEntries list the same as all-unavailable (nothing ran)", () => {
    const { exitCode, message } = computeMatrixExitCode([]);
    expect(exitCode).toBe(1);
    expect(message).toMatch(/unavailable/i);
  });

  it("judge pass/fail never affects the exit code either way", () => {
    // judgePassCount/judgePass aren't even part of the shape computeMatrixExitCode reads —
    // confirm a config carrying judge-fail-shaped data alongside a hard pass still exits 0.
    const configEntries = [{ results: [{ hardPass: true, judgePass: false }] }];
    const { exitCode } = computeMatrixExitCode(configEntries);
    expect(exitCode).toBe(0);
  });
});
