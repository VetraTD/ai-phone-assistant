import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp, DEFAULT_TEST_USER } from "./harness.js";

// Mark a call's open item done, and reopen it. The real-database half (tenant A
// cannot touch tenant B's call; the first person to press Done keeps it) is in
// tests/db/dashboardTenantScoping.test.js.
const CALL = "3f1a2b3c-4d5e-4f60-8a71-b2c3d4e5f601";

describe("PUT/DELETE /api/calls/:id/handled", () => {
  let app, poolQueryMock, authState, seen;

  beforeEach(() => {
    ({ app, poolQueryMock, authState } = createTestApp());
    seen = [];
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (/UPDATE calls/i.test(sql)) {
        seen.push({ sql, params });
        return Promise.resolve({ rows: [{ id: params[0], handled_at: "2026-11-23T10:00:00Z", handled_by: params[2] ?? null }] });
      }
      return Promise.reject(new Error("unexpected: " + sql));
    });
  });

  const put = (id = CALL) => request(app).put(`/api/calls/${id}/handled`).set("Authorization", "Bearer t");
  const del = (id = CALL) => request(app).delete(`/api/calls/${id}/handled`).set("Authorization", "Bearer t");

  it("Done keeps the first time and person, scoped to the caller's business", async () => {
    const res = await put();
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toMatch(/business_id = \$2/);
    // Takes effect only when not done yet, or when a request arrived after Done;
    // otherwise the first person and time stand.
    expect(seen[0].sql).toMatch(/CASE WHEN \(calls\.handled_at IS NULL OR EXISTS/);
    expect(seen[0].sql).toMatch(/cr\.created_at > calls\.handled_at/);
    expect(seen[0].params).toEqual([CALL, "b1", DEFAULT_TEST_USER.id]);
    expect(res.body).toEqual({ id: CALL, handled_at: "2026-11-23T10:00:00Z", handled_by: DEFAULT_TEST_USER.id });
  });

  it("Done on a call that is not this business's says it was not found", async () => {
    poolQueryMock.mockImplementation((sql) =>
      sql.includes("app_lookup_user_by_auth_uid") ? Promise.resolve({ rows: [{ business_id: "b1" }] }) : Promise.resolve({ rows: [] })
    );
    const res = await put();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Call not found" });
  });

  it("Reopen clears both columns, scoped the same way", async () => {
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      seen.push({ sql, params });
      return Promise.resolve({ rows: [{ id: params[0], handled_at: null, handled_by: null }] });
    });
    const res = await del();
    expect(res.status).toBe(200);
    expect(seen[0].sql).toMatch(/SET handled_at = NULL, handled_by = NULL/);
    expect(seen[0].sql).toMatch(/business_id = \$2/);
    expect(seen[0].params).toEqual([CALL, "b1"]);
    expect(res.body).toEqual({ id: CALL, handled_at: null, handled_by: null });
  });

  it("a malformed id is not found, and no call is queried", async () => {
    for (const r of [await put("not-a-uuid"), await del("not-a-uuid")]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Call not found" });
    }
    expect(seen).toHaveLength(0);
    expect(poolQueryMock.mock.calls.filter(([sql]) => /calls/i.test(sql) && !sql.includes("app_lookup"))).toHaveLength(0);
  });

  it("needs a sign-in", async () => {
    authState.user = null;
    expect((await put()).status).toBe(401);
    expect((await del()).status).toBe(401);
  });
});
