/**
 * How a scenario gets its business config, and where scenarios are read from.
 *
 * Free to run: no model is called. A scenario can name a fixture (and patch it)
 * or carry a complete `config` of its own — the second is how a real tenant's
 * import payload is tested before it goes live (see payloadToConfig in
 * scripts/render-tenant-prompt.js).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { resolveScenarioConfig, loadScenarios } from "../eval/run.js";

const FIXTURES = {
  base: {
    config: { businessName: "Fixture Co", onlyInFixture: "leaks if merged", capabilities: {} },
    extras: { knowledge: ["fixture fact"], transferAllowed: true },
  },
};

describe("resolveScenarioConfig", () => {
  it("a scenario with its own config uses it as is and needs no fixture", () => {
    const own = { businessName: "Own Co" };
    const { config, extras } = resolveScenarioConfig({ config: own, extrasPatch: { callerPhone: "+447700900123" } }, FIXTURES);
    expect(config).toEqual(own);
    expect(extras).toEqual({ callerPhone: "+447700900123" });
  });

  it("without its own config, the fixture is patched as before", () => {
    const { config, extras } = resolveScenarioConfig(
      { fixture: "base", configPatch: { businessName: "Patched" }, extrasPatch: { transferAllowed: false } },
      FIXTURES
    );
    expect(config.businessName).toBe("Patched");
    expect(config.onlyInFixture).toBe("leaks if merged");
    expect(extras).toEqual({ knowledge: ["fixture fact"], transferAllowed: false });
  });

  it("refuses a scenario that names both its own config and a fixture", () => {
    // The fixture's extras (knowledge, caller history, integrations) belong to
    // another business; inheriting them would test a different agent.
    expect(() => resolveScenarioConfig({ fixture: "base", config: { businessName: "Own Co" } }, FIXTURES)).toThrow(
      /both "config" and "fixture"/
    );
  });

  it("an unknown fixture with no config of its own still fails loudly", () => {
    expect(() => resolveScenarioConfig({ fixture: "nope" }, FIXTURES)).toThrow(/unknown fixture "nope"/);
  });
});

describe("loadScenarios", () => {
  it("reads scenarios from the folder it is given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-scenarios-"));
    try {
      fs.writeFileSync(path.join(dir, "01-one.js"), 'export default { name: "from-custom-dir", fixture: "x" };\n');
      fs.writeFileSync(path.join(dir, "notes.txt"), "not a scenario\n");
      const scenarios = await loadScenarios(dir);
      expect(scenarios.map((s) => s.name)).toEqual(["from-custom-dir"]);
      expect(scenarios[0]._file).toBe("01-one.js");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the folder when it does not exist, instead of a bare ENOENT", async () => {
    await expect(loadScenarios(path.join(os.tmpdir(), "no-such-eval-dir-xyz"))).rejects.toThrow(
      /scenarios folder not found: .*no-such-eval-dir-xyz/
    );
  });

  it("defaults to the built-in scenarios", async () => {
    const scenarios = await loadScenarios();
    expect(scenarios.length).toBeGreaterThan(10);
    expect(scenarios.some((s) => s.name === "messages-notes")).toBe(true);
  });
});
