import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

describe("GET /api/calls direction filter", () => {
  let app, poolQueryMock, seen;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
    seen = [];
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
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

  for (const dir of ["inbound", "outbound"]) {
    it(`?direction=${dir} adds a parameterised clause to list and count, after the tenant clause`, async () => {
      const res = await get(`?direction=${dir}`);
      expect(res.status).toBe(200);
      expect(seen.map((s) => s.kind).sort()).toEqual(["count", "list"]);
      for (const s of seen) {
        expect(s.sql).toMatch(/business_id = \$1/);
        expect(s.sql).toMatch(/direction = \$2/);
        expect(s.sql).not.toContain(dir);
        expect(s.params).toEqual(["b1", dir]);
      }
    });
  }

  it("no direction param adds no direction clause", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    for (const s of seen) expect(s.sql).not.toMatch(/direction/);
  });

  it("direction=all adds no direction clause", async () => {
    const res = await get("?direction=all");
    expect(res.status).toBe(200);
    for (const s of seen) expect(s.sql).not.toMatch(/direction/);
  });

  it("a bad direction value is rejected with 400 and never reaches the database", async () => {
    const res = await get("?direction=sideways");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/direction/i);
    expect(seen).toEqual([]);
  });

  it("an injection-shaped direction value is rejected with 400", async () => {
    const res = await get("?direction=" + encodeURIComponent("outbound' OR '1'='1"));
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("a repeated direction param (array) is rejected with 400", async () => {
    const res = await get("?direction=inbound&direction=outbound");
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });
});
