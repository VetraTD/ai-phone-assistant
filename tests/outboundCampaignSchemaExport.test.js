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
    // Fix round 1 (Important 3, controller ruling): template_key is refused
    // for every value except speed_to_lead in Part 1 -- reactivation would
    // otherwise dodge the marketing_consented refusal entirely.
    //
    // S3-6 (spec §19, S3-D4): `custom` joins speed_to_lead as allowed --
    // deliberately updated here (controller ruling), not a drift the test
    // caught by accident.
    expect(s.refusedInPart1).toEqual({
      compliance_class: ["marketing_consented"],
      audience: ["patient"],
      template_key: ["missed_call_callback", "reminder", "no_show", "aftercare", "review_request", "reactivation"],
    });
  });
});
