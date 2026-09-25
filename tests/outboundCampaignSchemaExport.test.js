import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { buildCampaignSchemaExport } from "../lib/outbound/campaignSchema.js";

const FILE = "AI-phone-dashboard/backend/src/generated/campaignSchema.json";

describe("campaign schema export (the dashboard's copy)", () => {
  it("exists and matches what the engine enforces -- run `node scripts/export-campaign-schema.js` if this fails", () => {
    expect(JSON.parse(fs.readFileSync(FILE, "utf8"))).toEqual(buildCampaignSchemaExport());
  });
  it("carries the Part 1 refusals, so the dashboard can grey them out", () => {
    const s = buildCampaignSchemaExport();
    expect(s.refusedInPart1).toEqual({ compliance_class: ["marketing_consented"], audience: ["patient"] });
  });
});
