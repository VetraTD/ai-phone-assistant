import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

describe("route mounting smoke test (all split route files wired)", () => {
  let app, poolQueryMock;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
  });

  it("GET /health (public)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("GET /api/calls (calls.js)", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.startsWith("SELECT COUNT(*) AS total FROM calls")) return Promise.resolve({ rows: [{ total: "0" }] });
      if (sql.includes("FROM calls")) return Promise.resolve({ rows: [] });
      return Promise.reject(new Error("unexpected: " + sql));
    });
    const res = await request(app).get("/api/calls").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
  });

  it("GET /api/appointments (appointments.js)", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/api/appointments").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
  });

  it("GET /api/usage (analytics.js)", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      return Promise.resolve({ rows: [{ calls_this_month: 0, total_seconds: 0 }] });
    });
    const res = await request(app).get("/api/usage").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
  });

  it("GET /api/calendar/status (calendar.js)", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/api/calendar/status").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
  });

  it("GET /api/me (onboarding.js)", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/api/me").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.needsOnboarding).toBe(true);
  });

  it("GET /api/businesses/:id (settings.js)", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      return Promise.resolve({ rows: [{ id: "b1", name: "Acme" }] });
    });
    const res = await request(app).get("/api/businesses/b1").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
  });

  it("GET /api/integrations/definitions (settings.js, no auth)", async () => {
    const res = await request(app).get("/api/integrations/definitions");
    expect(res.status).toBe(200);
  });

  it("GET /api/voices (settings.js, no auth)", async () => {
    const res = await request(app).get("/api/voices");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("voiceId");
  });

  it("GET /api/knowledge (knowledge.js)", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get("/api/knowledge?businessId=b1").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
  });
});
