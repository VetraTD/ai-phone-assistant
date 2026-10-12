import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));

describe("dashboard vendor copies are byte-identical", () => {
  const pairs = [
    ["lib/dialCost.js", "AI-phone-dashboard/backend/src/dialCost.mjs"],
    ["lib/dialCostTable.json", "AI-phone-dashboard/backend/src/dialCostTable.json"],
  ];
  for (const [a, b] of pairs) {
    it(`${a} == ${b}`, () => {
      const same = Buffer.compare(read(a), read(b)) === 0;
      expect(same, `${a} and ${b} differ; re-copy (or re-run scripts/refresh-dial-costs.mjs)`).toBe(true);
    });
  }
});
