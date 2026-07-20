import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_BUSINESS_ID = "33333333-3333-3333-3333-333333333333";
const ENTRY_ID = "44444444-4444-4444-4444-444444444444";

describe("/api/knowledge CRUD", () => {
  let app, poolQueryMock, authState;

  beforeEach(() => {
    ({ app, poolQueryMock, authState } = createTestApp());
  });

  function mockOwner(businessId = BUSINESS_ID) {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) {
        return Promise.resolve({ rows: [{ business_id: businessId }] });
      }
      return Promise.reject(new Error("unhandled query in this test: " + sql));
    });
  }

  describe("GET /api/knowledge", () => {
    it("returns rows for the caller's own business, ordered priority desc", async () => {
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.includes("FROM business_knowledge")) {
          expect(params).toEqual([BUSINESS_ID]);
          expect(sql).toMatch(/ORDER BY priority DESC/);
          return Promise.resolve({ rows: [{ id: ENTRY_ID, question: "Do you take insurance?" }] });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      const res = await request(app)
        .get(`/api/knowledge?businessId=${BUSINESS_ID}`)
        .set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("denies access to another business's knowledge base", async () => {
      mockOwner(BUSINESS_ID);
      const res = await request(app)
        .get(`/api/knowledge?businessId=${OTHER_BUSINESS_ID}`)
        .set("Authorization", "Bearer test-token");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/knowledge", () => {
    it("creates an entry with defaults for optional fields", async () => {
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.startsWith("INSERT INTO business_knowledge")) {
          expect(params).toEqual([BUSINESS_ID, "Do you take walk-ins?", "Yes, anytime.", null, 0]);
          return Promise.resolve({ rows: [{ id: ENTRY_ID, ...paramsAsRow(params) }] });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      function paramsAsRow([business_id, question, answer, category, priority]) {
        return { business_id, question, answer, category, priority };
      }

      const res = await request(app)
        .post("/api/knowledge")
        .set("Authorization", "Bearer test-token")
        .send({ businessId: BUSINESS_ID, question: "Do you take walk-ins?", answer: "Yes, anytime." });

      expect(res.status).toBe(201);
      expect(res.body.question).toBe("Do you take walk-ins?");
    });

    it("rejects an empty question with 400", async () => {
      mockOwner(BUSINESS_ID);
      const res = await request(app)
        .post("/api/knowledge")
        .set("Authorization", "Bearer test-token")
        .send({ businessId: BUSINESS_ID, question: "", answer: "Yes." });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/question/);
    });

    it("rejects priority out of 0-100 range", async () => {
      mockOwner(BUSINESS_ID);
      const res = await request(app)
        .post("/api/knowledge")
        .set("Authorization", "Bearer test-token")
        .send({ businessId: BUSINESS_ID, question: "Q?", answer: "A.", priority: 500 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/priority/);
    });

    it("denies creating an entry under another business", async () => {
      mockOwner(BUSINESS_ID);
      const res = await request(app)
        .post("/api/knowledge")
        .set("Authorization", "Bearer test-token")
        .send({ businessId: OTHER_BUSINESS_ID, question: "Q?", answer: "A." });
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/knowledge/:id", () => {
    it("applies a partial update (enabled toggle) and returns the row", async () => {
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.startsWith("SELECT * FROM business_knowledge")) {
          return Promise.resolve({ rows: [{ id: ENTRY_ID, business_id: BUSINESS_ID, enabled: true }] });
        }
        if (sql.startsWith("UPDATE business_knowledge")) {
          expect(sql).toContain("enabled = $1");
          expect(params).toEqual([false, ENTRY_ID]);
          return Promise.resolve({ rows: [{ id: ENTRY_ID, business_id: BUSINESS_ID, enabled: false }] });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      const res = await request(app)
        .put(`/api/knowledge/${ENTRY_ID}`)
        .set("Authorization", "Bearer test-token")
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
    });

    it("404s for a nonexistent entry", async () => {
      poolQueryMock.mockImplementation((sql) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.startsWith("SELECT * FROM business_knowledge")) return Promise.resolve({ rows: [] });
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      const res = await request(app)
        .put(`/api/knowledge/${ENTRY_ID}`)
        .set("Authorization", "Bearer test-token")
        .send({ enabled: false });
      expect(res.status).toBe(404);
    });

    it("denies updating an entry owned by another business", async () => {
      poolQueryMock.mockImplementation((sql) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.startsWith("SELECT * FROM business_knowledge")) {
          return Promise.resolve({ rows: [{ id: ENTRY_ID, business_id: OTHER_BUSINESS_ID }] });
        }
        return Promise.reject(new Error("should not reach UPDATE"));
      });

      const res = await request(app)
        .put(`/api/knowledge/${ENTRY_ID}`)
        .set("Authorization", "Bearer test-token")
        .send({ enabled: false });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/knowledge/:id", () => {
    it("deletes an owned entry", async () => {
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.startsWith("SELECT business_id FROM business_knowledge")) {
          return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        }
        if (sql.startsWith("DELETE FROM business_knowledge")) {
          expect(params).toEqual([ENTRY_ID]);
          return Promise.resolve({ rows: [] });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      const res = await request(app)
        .delete(`/api/knowledge/${ENTRY_ID}`)
        .set("Authorization", "Bearer test-token");
      expect(res.status).toBe(204);
    });

    it("denies deleting an entry owned by another business", async () => {
      poolQueryMock.mockImplementation((sql) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.startsWith("SELECT business_id FROM business_knowledge")) {
          return Promise.resolve({ rows: [{ business_id: OTHER_BUSINESS_ID }] });
        }
        return Promise.reject(new Error("should not reach DELETE"));
      });

      const res = await request(app)
        .delete(`/api/knowledge/${ENTRY_ID}`)
        .set("Authorization", "Bearer test-token");
      expect(res.status).toBe(403);
    });
  });
});
