#!/usr/bin/env node
/**
 * Export the outbound campaign config schema for the dashboard (spec §7).
 *
 * The dashboard is a separate CommonJS app and cannot import the ESM
 * `lib/outbound/campaignSchema.js`, so the schema is generated into a JSON
 * file it can require. That is a duplicate, and duplicates drift, so this is
 * generated, never hand-edited, and tests/outboundCampaignSchemaExport.test.js
 * fails when the committed file no longer matches what the engine enforces.
 * Adding or changing a campaign rule means running this script; forgetting
 * means a red test, not a settings screen quietly out of sync with what save
 * actually accepts.
 *
 *   node scripts/export-campaign-schema.js
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { buildCampaignSchemaExport } from "../lib/outbound/campaignSchema.js";

export const EXPORT_PATH = new URL(
  "../AI-phone-dashboard/backend/src/generated/campaignSchema.json",
  import.meta.url
);

const serialise = (payload) => `${JSON.stringify(payload, null, 2)}\n`;

/** True when the committed file already matches the live schema. */
export function exportIsCurrent() {
  if (!existsSync(EXPORT_PATH)) return false;
  return readFileSync(EXPORT_PATH, "utf8") === serialise(buildCampaignSchemaExport());
}

// Only write when run directly, so importing this from a test never mutates
// the working tree -- a test that fixes its own failure proves nothing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  writeFileSync(EXPORT_PATH, serialise(buildCampaignSchemaExport()));
  console.log(`Wrote ${EXPORT_PATH.pathname.split("/").pop()}`);
}
