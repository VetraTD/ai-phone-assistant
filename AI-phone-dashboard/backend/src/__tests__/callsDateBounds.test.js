import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

// The Calls list bounds its date range in the BUSINESS timezone. A UTC `::date`
// cast hid every call made after 00:00 UTC of the business's today (7 PM CDT).
describe("GET /api/calls date bounds", () => {
  let app, poolQueryMock, seen, tzRow, tzLookups;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
    seen = [];
    tzLookups = 0;
    tzRow = { timezone: "America/Chicago" };
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.includes("SELECT timezone FROM businesses")) {
        tzLookups += 1;
        return Promise.resolve({ rows: [tzRow] });
      }
      if (sql.startsWith("SELECT COUNT(*) AS total FROM calls")) {
        seen.push({ kind: "count", sql, params });
        return Promise.resolve({ rows: [{ total: "0" }] });
      }
      if (sql.includes("FROM calls")) {
        seen.push({ kind: "list", sql, params });
        return Promise.resolve({ rows: [] });
      }
      return Promise.reject(new Error("unexpected: " + sql));
    });
  });

  const get = (qs) => request(app).get("/api/calls" + qs).set("Authorization", "Bearer t");

  it("from+to: list and count bound in the business timezone, tz as a parameter", async () => {
    const res = await get("?from=2026-10-15&to=2026-10-15");
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.kind).sort()).toEqual(["count", "list"]);
    for (const s of seen) {
      expect(s.params).toEqual(["b1", "America/Chicago", "2026-10-15", "2026-10-15"]);
      expect(s.sql).toMatch(/started_at >= \(\$3::date::timestamp AT TIME ZONE \$2\)/);
      expect(s.sql).toMatch(/started_at < \(\(\$4::date \+ 1\)::timestamp AT TIME ZONE \$2\)/);
      expect(s.sql).not.toContain("America/Chicago");
    }
  });

  it("only from: lower bound with tz param, no upper bound", async () => {
    await get("?from=2026-10-15");
    for (const s of seen) {
      expect(s.params).toEqual(["b1", "America/Chicago", "2026-10-15"]);
      expect(s.sql).toMatch(/started_at >= \(\$3::date::timestamp AT TIME ZONE \$2\)/);
      expect(s.sql).not.toMatch(/started_at </);
    }
  });

  it("only to: upper bound with tz param, no lower bound", async () => {
    await get("?to=2026-10-15");
    for (const s of seen) {
      expect(s.params).toEqual(["b1", "America/Chicago", "2026-10-15"]);
      expect(s.sql).toMatch(/started_at < \(\(\$3::date \+ 1\)::timestamp AT TIME ZONE \$2\)/);
      expect(s.sql).not.toMatch(/started_at >=/);
    }
  });

  it("falls back to the default timezone when the business row names none", async () => {
    tzRow = { timezone: null };
    await get("?from=2026-10-15");
    for (const s of seen) expect(s.params[1]).toBe("America/Chicago");
    tzRow = undefined;
    seen.length = 0;
    await get("?from=2026-10-15");
    for (const s of seen) expect(s.params[1]).toBe("America/Chicago");
  });

  it("uses the business's own timezone", async () => {
    tzRow = { timezone: "Europe/London" };
    await get("?from=2026-10-15");
    for (const s of seen) expect(s.params).toEqual(["b1", "Europe/London", "2026-10-15"]);
  });

  it("no from/to: no date clause and no timezone lookup", async () => {
    await get("");
    expect(tzLookups).toBe(0);
    for (const s of seen) {
      expect(s.sql).not.toMatch(/AT TIME ZONE/);
      expect(s.sql).not.toMatch(/started_at (>=|<) /);
      expect(s.params).toEqual(["b1"]);
    }
  });
});
