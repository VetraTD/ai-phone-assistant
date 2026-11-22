import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

// Migration 036 resolves a login by the account id, never the email address.
// This pins that closure at the dashboard API: an address is something a
// stranger can choose at sign-up, an account id is not.
describe("sign-in cannot be claimed by email", () => {
  let app, poolQueryMock, authState;
  beforeEach(() => {
    ({ app, poolQueryMock, authState } = createTestApp());
  });

  it("a fresh account using a client's email address gets no business", async () => {
    authState.user = { id: "fresh-account-uid", email: "owner@brightwork.example" };
    poolQueryMock.mockImplementation((sql) =>
      sql.includes("app_lookup_user_by_auth_uid") ? Promise.resolve({ rows: [] }) : Promise.reject(new Error("unexpected " + sql)));
    const res = await request(app).get("/api/calls").set("Authorization", "Bearer t");
    expect(res.status).toBe(403);
    const lookups = poolQueryMock.mock.calls.filter(([sql]) => sql.includes("app_lookup_user_by_auth_uid"));
    expect(lookups[0][1]).toEqual(["fresh-account-uid"]);
    expect(poolQueryMock.mock.calls.flatMap(([, p]) => p || [])).not.toContain("owner@brightwork.example");
  });
});
