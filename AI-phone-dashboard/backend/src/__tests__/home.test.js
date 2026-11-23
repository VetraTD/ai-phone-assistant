import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

// GET /api/home: what needs the owner, today's counts, today's bookings and the
// week so far, in one request. The real-database half (business timezone around
// midnight, tenant isolation, launch-marked items) is tests/db/dashboardHome.test.js.
describe("GET /api/home", () => {
  let app, poolQueryMock, authState, seen;

  beforeEach(() => {
    ({ app, poolQueryMock, authState } = createTestApp());
    seen = [];
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.includes("SELECT timezone FROM businesses")) return Promise.resolve({ rows: [{ timezone: "America/Chicago" }] });
      seen.push({ sql, params });
      if (/AS answered/.test(sql)) return Promise.resolve({ rows: [{ answered: 3, bookings_made: 1, week_calls: 9, week_bookings_made: 2 }] });
      return Promise.resolve({ rows: [] });
    });
  });

  const get = () => request(app).get("/api/home").set("Authorization", "Bearer t");

  it("answers with exactly the documented shape", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["doneToday", "openItems", "timezone", "today", "todaysBookings", "week"]);
    expect(res.body.timezone).toBe("America/Chicago");
    expect(res.body.today).toEqual({ answered: 3, bookingsMade: 1 });
    expect(res.body.week).toEqual({ calls: 9, bookingsMade: 2 });
    expect(res.body.openItems).toEqual([]);
    expect(res.body.doneToday).toEqual([]);
    expect(res.body.todaysBookings).toEqual([]);
  });

  it("scopes every statement to the signed-in business, explicitly", async () => {
    await get();
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const s of seen) {
      expect(s.sql).toMatch(/business_id = \$1/);
      expect(s.params[0]).toBe("b1");
    }
  });

  it("measures every day and week bound in the business's timezone", async () => {
    await get();
    // Only statements that measure time take the timezone (Postgres rejects an
    // unused parameter): done today, the counts, today's bookings.
    const timed = seen.filter((s) => /now\(\)/.test(s.sql));
    expect(timed.length).toBeGreaterThanOrEqual(3);
    for (const s of timed) {
      expect(s.params[1]).toBe("America/Chicago");
      expect(s.sql).toMatch(/AT TIME ZONE \$2/);
    }
  });

  it("lists open items oldest first", async () => {
    await get();
    const open = seen.find((s) => /handled_at IS NULL/.test(s.sql) && /LATERAL/.test(s.sql));
    expect(open, "an open-items statement").toBeDefined();
    expect(open.sql).toMatch(/ORDER BY c\.started_at ASC/);
    expect(open.sql).toMatch(/LIMIT 200/);
  });

  it("maps rows to camelCase items with the request inside", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.includes("SELECT timezone FROM businesses")) return Promise.resolve({ rows: [{ timezone: "America/Chicago" }] });
      if (/AS answered/.test(sql)) return Promise.resolve({ rows: [{ answered: 0, bookings_made: 0, week_calls: 0, week_bookings_made: 0 }] });
      if (/LATERAL/.test(sql) && /handled_at IS NULL/.test(sql)) {
        return Promise.resolve({
          rows: [{
            call_id: "c1", started_at: "2026-11-23T15:00:00Z", caller_number: "+15550100", caller_name: "Sample Caller",
            summary: "Wants a call back.", request_type: "callback", request_caller_name: "Sample Caller",
            callback_number: "+15550199", preferred_time: "after 3 pm", message: "About a filling",
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await get();
    expect(res.body.openItems).toEqual([{
      callId: "c1", startedAt: "2026-11-23T15:00:00Z", callerNumber: "+15550100", callerName: "Sample Caller", summary: "Wants a call back.",
      request: { type: "callback", callerName: "Sample Caller", callbackNumber: "+15550199", preferredTime: "after 3 pm", message: "About a filling" },
    }]);
  });

  it("needs a sign-in", async () => {
    authState.user = null;
    expect((await get()).status).toBe(401);
  });
});
