#!/usr/bin/env node
/**
 * Export the capability registry's settings schemas for the dashboard.
 *
 * The dashboard is a separate CommonJS app and cannot import the ESM registry,
 * so the schemas are generated into a JSON file it can require. That is a
 * duplicate, and duplicates drift — the reserved-tool-name list already proved
 * that by silently going stale while packs grew past it.
 *
 * So this is generated, never hand-edited, and tests/capabilitySchemaExport.test.js
 * fails when the committed file no longer matches the live packs. Adding a
 * capability means running this script; forgetting means a red test, not a
 * settings screen quietly missing a section.
 *
 *   node scripts/export-capability-schemas.js
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { listPacks } from "../capabilities/index.js";
import { listSchedulingAdapters } from "../adapters/scheduling/index.js";

export const EXPORT_PATH = new URL(
  "../AI-phone-dashboard/backend/src/generated/capabilitySchemas.json",
  import.meta.url
);

/**
 * Build the payload the dashboard renders from.
 *
 * Only presentation-relevant fields cross the boundary: the dashboard has no
 * business knowing how a pack executes, and shipping tool declarations or
 * prompt text into a browser bundle would be leaking the engine's internals to
 * a client.
 */
export function buildSchemaExport() {
  return {
    capabilities: listPacks().map((pack) => ({
      id: pack.id,
      label: pack.label || pack.id,
      description: pack.description || "",
      // Core capabilities are always on and cannot be switched off, so the UI
      // renders them as a locked row rather than a toggle.
      core: !!pack.core,
      adapterKind: pack.adapterKind || null,
      configSchema: pack.configSchema || null,
    })),
    adapters: {
      scheduling: listSchedulingAdapters().map((a) => ({
        id: a.id,
        label: a.label,
        // Whether the dashboard offers this adapter as a self-serve choice.
        // false = valid in the engine but hidden from the picker (athenahealth
        // is owner-managed; webhook is an unwired stub). Absent means true.
        selfServe: a.selfServe !== false,
        // What this backend can actually prove a caller against. The UI uses it
        // to decide which identity checks it may offer as verified rather than
        // merely collected — and to explain why, when it cannot.
        verifiableFields: a.verifiableFields || [],
      })),
    },
  };
}

const serialise = (payload) => `${JSON.stringify(payload, null, 2)}\n`;

/** True when the committed file already matches the live registry. */
export function exportIsCurrent() {
  if (!existsSync(EXPORT_PATH)) return false;
  return readFileSync(EXPORT_PATH, "utf8") === serialise(buildSchemaExport());
}

// Only write when run directly, so importing this from a test never mutates
// the working tree — a test that fixes its own failure proves nothing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  writeFileSync(EXPORT_PATH, serialise(buildSchemaExport()));
  console.log(`Wrote ${EXPORT_PATH.pathname.split("/").pop()}`);
}
