// tests/cloudbuildSmoke.test.js
//
// X2 (go-live pre-deploy hardening, 2026-09-26; fix round 1, Minor 2). Two
// gaps in cloudbuild.yaml's image smoke checks:
//   - M9 made the @google-cloud/tasks import lazy (lib/outbound/internalRoutes.js
//     -- loaded on the first enqueue, not at module load), so a missing or
//     broken install of it in the image would sail through the `smoke` step's
//     `await import('/app/server.js')`. The step calls the SAME exported
//     lazy importer the service calls (`importCloudTasks`), so it exercises
//     the exact resolution production takes -- the package is a dual CJS/ESM
//     build, and an earlier version resolved it a different way.
//   - scripts/outbound-admin.js's own comment (its pathToFileURL main guard)
//     claims it is smoke-imported by `smoke-verifiers`, but that step only
//     ever imported c8-rls-proof.js, c7-restore-parity.js and import-tenant.js.
//
// This file reads cloudbuild.yaml as TEXT (it is not JS/JSON) and asserts the
// two steps' inline `-e` scripts contain the imports they need, without
// executing anything -- Cloud Build's own steps are the thing that runs them,
// against the real built image.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const yamlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cloudbuild.yaml");
const yaml = readFileSync(yamlPath, "utf8");

/**
 * The text of one step's block, from its `- id: <id>` line up to (but not
 * including) the next `- id:` line or the top-level `timeout:` key.
 * Anchored on a trailing newline after the id so "smoke" does not also match
 * "smoke-migrate" / "smoke-verifiers".
 */
function stepBlock(id) {
  const re = new RegExp(`  - id: ${id}\\n([\\s\\S]*?)(?=\\n  - id: |\\ntimeout:)`);
  const m = yaml.match(re);
  if (!m) throw new Error(`cloudbuild.yaml: step "${id}" not found`);
  return m[1];
}

describe("cloudbuild.yaml smoke steps import what they need to catch a broken image (X2)", () => {
  // Fix round 1, Minor 2: `@google-cloud/tasks` is a dual package
  // (exports["."].require -> the CJS build, .import -> the ESM build).
  // internalRoutes.js's own lazy loader takes the import condition
  // (dynamic `import()`); an earlier version of this line used
  // `createRequire`, which takes the DIFFERENT (require) condition, so it
  // could pass while the resolution the service actually uses is broken.
  // Calling the service's own exported `importCloudTasks` guarantees the
  // SAME resolution, not a parallel one.
  it("the `smoke` step's script calls the service's own lazy Tasks importer, not a separate resolution", () => {
    const block = stepBlock("smoke");
    expect(block).toMatch(/importCloudTasks/);
    expect(block).toMatch(/\/app\/lib\/outbound\/internalRoutes\.js/);
    expect(block).not.toMatch(/createRequire/);
    // the pre-existing check -- the module tree still loads with no port bound.
    expect(block).toMatch(/await import\('\/app\/server\.js'\)/);
    expect(block).toMatch(/no port bound/);
  });

  it("the `smoke-verifiers` step imports scripts/outbound-admin.js, alongside the three imports it already had", () => {
    const block = stepBlock("smoke-verifiers");
    expect(block).toMatch(/\/app\/scripts\/outbound-admin\.js/);
    expect(block).toMatch(/c8-rls-proof\.js/);
    expect(block).toMatch(/c7-restore-parity\.js/);
    expect(block).toMatch(/import-tenant\.js/);
  });
});
