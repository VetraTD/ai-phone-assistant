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
import { loadMatrixConfigs } from "../eval/run.js";

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
});
