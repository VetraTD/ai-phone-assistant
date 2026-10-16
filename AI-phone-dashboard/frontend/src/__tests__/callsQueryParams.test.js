import { describe, it, expect } from "vitest";
import { buildCallsQueryParams } from "../callsQueryParams";

const base = {
  businessId: "b1", status: "all", callerSearch: "", fromDate: "2026-10-08", toDate: "2026-10-15",
  hasAppointments: false, sentiment: "all", hasSummary: "all", needsFollowUp: false, direction: "all",
};

describe("buildCallsQueryParams date range", () => {
  for (const preset of ["1", "7", "30"]) {
    it(`preset ${preset}: sends from, never to (the server's today is the business's)`, () => {
      const p = buildCallsQueryParams({ ...base, datePreset: preset });
      expect(p.from).toBe("2026-10-08");
      expect("to" in p).toBe(false);
    });
  }
  it("custom range: sends both from and to", () => {
    const p = buildCallsQueryParams({ ...base, datePreset: "custom" });
    expect(p.from).toBe("2026-10-08");
    expect(p.to).toBe("2026-10-15");
  });
  it("other filters still map through", () => {
    const p = buildCallsQueryParams({ ...base, datePreset: "7", status: "completed", callerSearch: " 555 ", hasAppointments: true, direction: "outbound" });
    expect(p).toMatchObject({ limit: 200, offset: 0, business_id: "b1", status: "completed", caller: "555", has_appointments: "true", direction: "outbound" });
  });
});
