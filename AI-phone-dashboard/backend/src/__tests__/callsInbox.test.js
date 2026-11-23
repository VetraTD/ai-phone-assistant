import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

// The Inbox's reads: the "Needs you" view, search, and the caller's history on
// a call. Search text is caller-influenced, so its wildcards are escaped.
const CALL = "4f1a2b3c-4d5e-4f60-8a71-b2c3d4e5f602";

describe("GET /api/calls for the Inbox", () => {
  let app, poolQueryMock, seen;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
    seen = [];
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      seen.push({ sql, params });
      if (sql.includes("COUNT(*) AS total")) return Promise.resolve({ rows: [{ total: "0" }] });
      return Promise.resolve({ rows: [] });
    });
  });

  const get = (qs) => request(app).get("/api/calls" + qs).set("Authorization", "Bearer t");

  it("search escapes the wildcards a caller could type", async () => {
    const res = await get("?q=50%25_off");
    expect(res.status).toBe(200);
    for (const s of seen) {
      expect(s.params).toContain("%50\\%\\_off%");
      expect(s.sql).toMatch(/ILIKE \$2 ESCAPE '\\'/);
    }
  });

  it("search looks at the number, the summary, and the names callers gave", async () => {
    await get("?q=sample");
    const list = seen.find((s) => !s.sql.includes("COUNT(*)"));
    expect(list.sql).toMatch(/calls\.caller_number ILIKE \$2/);
    expect(list.sql).toMatch(/calls\.summary ILIKE \$2/);
    expect(list.sql).toMatch(/cr\.caller_name ILIKE \$2/);
    expect(list.sql).toMatch(/a\.client_name ILIKE \$2/);
  });

  it("view=open keeps calls with a request nobody has marked done, after the tenant clause", async () => {
    await get("?view=open");
    for (const s of seen) {
      // Open = a request nobody has marked done, or one that arrived after Done.
      expect(s.sql).toMatch(/WHERE business_id = \$1 AND EXISTS \(\s*SELECT 1 FROM customer_requests cr/);
      expect(s.sql).toMatch(/calls\.handled_at IS NULL OR cr\.created_at > calls\.handled_at/);
      expect(s.params[0]).toBe("b1");
    }
  });

  it("any other view means all calls", async () => {
    await get("?view=all");
    const count = seen.find((s) => s.sql.includes("COUNT(*)"));
    expect(count.sql).not.toMatch(/handled_at/);
  });

  it("every request and booking subquery names the business, not RLS alone", async () => {
    await get("?q=sample&view=open");
    const list = seen.find((s) => !s.sql.includes("COUNT(*)"));
    const subqueries = list.sql.match(/FROM (customer_requests|appointments) \w+ WHERE [^)]*/g) || [];
    expect(subqueries.length).toBeGreaterThan(3);
    for (const q of subqueries) expect(q, q).toMatch(/business_id = calls\.business_id/);
  });

  it("each row says whether it left a request, its latest kind, and the best name", async () => {
    await get("");
    const list = seen.find((s) => !s.sql.includes("COUNT(*)"));
    expect(list.sql).toMatch(/AS has_request/);
    expect(list.sql).toMatch(/AS request_type/);
    expect(list.sql).toMatch(/COALESCE\(\s*\(SELECT cr\.caller_name/);
    expect(list.sql).toMatch(/AS caller_name_guess/);
  });
});

describe("GET /api/calls/:id caller history", () => {
  let app, poolQueryMock, seen, callRow;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
    seen = [];
    callRow = { id: CALL, business_id: "b1", caller_number: "+15550100199", status: "completed" };
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      seen.push({ sql, params });
      if (sql.startsWith("select * from calls where id")) return Promise.resolve({ rows: [callRow] });
      if (/caller_history_calls/.test(sql)) return Promise.resolve({ rows: [{ id: "other", started_at: "2026-11-20T10:00:00Z", summary: "Earlier call", status: "completed" }] });
      if (/caller_history_bookings/.test(sql)) return Promise.resolve({ rows: [{ id: "bk1", scheduled_at: "2026-11-25T15:00:00Z", status: "scheduled", client_name: "Sample Caller" }] });
      return Promise.resolve({ rows: [] });
    });
  });

  const get = (id = CALL) => request(app).get(`/api/calls/${id}`).set("Authorization", "Bearer t");

  it("adds the caller's other calls and this week's bookings, scoped to the business", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.caller_history).toEqual({
      calls: [{ id: "other", started_at: "2026-11-20T10:00:00Z", summary: "Earlier call", status: "completed" }],
      bookings: [{ id: "bk1", scheduled_at: "2026-11-25T15:00:00Z", status: "scheduled", client_name: "Sample Caller" }],
    });
    const history = seen.filter((s) => /caller_history_/.test(s.sql));
    expect(history).toHaveLength(2);
    for (const h of history) {
      expect(h.sql).toMatch(/business_id = \$1/);
      expect(h.params[0]).toBe("b1");
      expect(h.params).toContain("+15550100199");
    }
    const calls = history.find((h) => /caller_history_calls/.test(h.sql));
    expect(calls.sql).toMatch(/id <> \$3/);
    expect(calls.sql).toMatch(/ORDER BY started_at DESC/);
    expect(calls.sql).toMatch(/LIMIT 10/);
  });

  it("a withheld number has no history and runs no history query", async () => {
    for (const number of [null, "", "   "]) {
      seen = [];
      callRow.caller_number = number;
      const res = await get();
      expect(res.body.caller_history).toEqual({ calls: [], bookings: [] });
      expect(seen.filter((s) => /caller_history_/.test(s.sql))).toHaveLength(0);
    }
  });

  it("a malformed id is not found, without querying", async () => {
    const res = await get("not-a-uuid");
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
