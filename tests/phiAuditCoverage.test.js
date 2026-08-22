import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "../services/db.js";

const DB_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "db.js"),
  "utf8"
);

/**
 * The body of one exported function, from its declaration to the next one.
 *
 * Crude on purpose. It only has to be good enough to answer "does THIS function
 * record its own access", and a parser would be a dependency and a second thing
 * that can be wrong.
 */
function bodyOf(name) {
  const start = DB_SOURCE.indexOf(`export async function ${name}(`);
  if (start === -1) return null;
  const next = DB_SOURCE.indexOf("\nexport ", start + 1);
  return DB_SOURCE.slice(start, next === -1 ? DB_SOURCE.length : next);
}

// The list that must not go stale.
//
// §164.312(b) is only satisfied if the classification covers everything. A new
// exported data function that is neither classified as PHI nor named as exempt
// would silently read patient data with no audit row — and nobody would find
// out, because the absence of a log line is not an error anyone sees.
//
// So this fails in BOTH directions, the same shape tests/envInventory.test.js
// settled on for environment variables: an unclassified export fails, and a
// classification naming a function that no longer exists fails too.

/**
 * Exports that are not data-layer functions at all: the module's own plumbing,
 * pure helpers, and constants. Named individually rather than pattern-matched,
 * because "looks like a helper" is exactly the judgement this test exists to
 * stop people making at 2am.
 */
const NOT_DATA_FUNCTIONS = new Set([
  "isEnabled",
  "close",
  "withTenant",
  "withTenantSafe",
  "currentTenant",
  "recordPhiAccess",
  "normalizeAllowedTasks",
  "loadConfig",
  "CORE_TASKS",
  "MODULE_TASKS",
  "BUILTIN_TOOL_NAMES",
  "PHI_ACCESS",
  "NON_PHI_EXPORTS",
]);

describe("PHI-access classification covers every data-layer export", () => {
  it("classifies every exported data function", () => {
    const unclassified = Object.keys(db)
      .filter((name) => !NOT_DATA_FUNCTIONS.has(name))
      .filter((name) => typeof db[name] === "function")
      .filter((name) => !(name in db.PHI_ACCESS) && !db.NON_PHI_EXPORTS.has(name));

    expect(unclassified).toEqual([]);
  });

  it("names no function that has stopped existing", () => {
    const stale = [...Object.keys(db.PHI_ACCESS), ...db.NON_PHI_EXPORTS].filter(
      (name) => typeof db[name] !== "function"
    );
    expect(stale).toEqual([]);
  });

  it("gives every PHI entry a resource list and an action", () => {
    for (const [name, entry] of Object.entries(db.PHI_ACCESS)) {
      expect(Array.isArray(entry.resources), `${name}.resources`).toBe(true);
      expect(entry.resources.length, `${name}.resources`).toBeGreaterThan(0);
      expect(
        ["read", "write", "export", "erase"],
        `${name}.action`
      ).toContain(entry.action);
    }
  });

  it("makes every classified function actually record its own access", () => {
    // The map being complete is not the same as the code being instrumented.
    // Without this check a function could be classified, listed, reviewed and
    // still never emit a thing — and the failure would be an ABSENT log line,
    // which nobody notices. Same shape as tests/logPhiLint.test.js: scan the
    // source, because a runtime test only covers the paths it happens to call.
    const silent = Object.keys(db.PHI_ACCESS).filter((name) => {
      const body = bodyOf(name);
      return !body || !body.includes(`noteAccess("${name}"`);
    });
    expect(silent).toEqual([]);
  });

  it("does not classify a config read as a PHI access", () => {
    // These read the tenant's own configuration and identity, not patient data.
    // If one ever appears in PHI_ACCESS it is either a mistake or the function
    // changed shape, and both are worth stopping on.
    for (const name of [
      "fetchBusinessById",
      "fetchBusinessCapabilities",
      "fetchBusinessKnowledge",
      "lookupBusinessByPhone",
      "fetchUserByAuthUid",
      "listIntegrationsForBusiness",
    ]) {
      expect(name in db.PHI_ACCESS, `${name} must not be a PHI access`).toBe(false);
    }
  });
});
