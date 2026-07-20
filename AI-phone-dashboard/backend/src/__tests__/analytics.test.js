import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";

describe("GET /api/analytics/:businessId", () => {
  let app, poolQueryMock;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
  });

  it("counts transferred_today from status='transferred' with no summary ILIKE inference", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
      if (sql.includes("FROM calls") && sql.includes("status = 'transferred'")) {
        // The old inference bug OR'd in a summary ILIKE '%transfer%' clause —
        // assert it's gone entirely.
        expect(sql).not.toMatch(/ILIKE/i);
        return Promise.resolve({ rows: [{ count: "3" }] });
      }
      if (sql.includes("FROM calls") && sql.includes("started_at::date = CURRENT_DATE")) {
        return Promise.resolve({ rows: [{ count: "10" }] });
      }
      if (sql.includes("FROM appointments")) return Promise.resolve({ rows: [{ count: "2" }] });
      if (sql.includes("FROM customer_requests")) return Promise.resolve({ rows: [{ count: "1" }] });
      return Promise.reject(new Error("unexpected query: " + sql));
    });

    const res = await request(app)
      .get(`/api/analytics/${BUSINESS_ID}`)
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(res.body.transferred_today).toBe(3);
  });
});
