import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

// Call data must not sit in a browser's disk cache after someone signs out of a
// shared front-desk PC: every API response says not to store it.
describe("API responses are never stored by the browser", () => {
  it("a signed-in read carries Cache-Control: no-store", async () => {
    const { app, poolQueryMock } = createTestApp();
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      return Promise.resolve({ rows: [{ calls_this_month: 0, total_seconds: 0 }] });
    });
    const res = await request(app).get("/api/usage").set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("so does a refusal", async () => {
    const { app, authState } = createTestApp();
    authState.user = null;
    const res = await request(app).get("/api/calls");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
