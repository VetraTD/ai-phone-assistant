import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";

describe("GET /api/analytics/:businessId", () => {
  let app, poolQueryMock;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
  });

  /**
   * Answer every query the handler makes, keyed on what the SQL contains.
   *
   * @param {object} [over] per-tile overrides, plus `timezone`
   */
  function stubTiles(over = {}) {
    const counts = { calls: "10", appointments: "2", followups: "1", transferred: "3", ...over };
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid"))
        return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
      if (sql.includes("FROM businesses"))
        return Promise.resolve({ rows: [{ timezone: over.timezone ?? "Europe/London" }] });
      if (sql.includes("FROM calls") && sql.includes("status = 'transferred'"))
        return Promise.resolve({ rows: [{ count: counts.transferred }] });
      if (sql.includes("FROM calls")) return Promise.resolve({ rows: [{ count: counts.calls }] });
      if (sql.includes("FROM appointments"))
        return Promise.resolve({ rows: [{ count: counts.appointments }] });
      if (sql.includes("FROM customer_requests"))
        return Promise.resolve({ rows: [{ count: counts.followups }] });
      return Promise.reject(new Error("unexpected query: " + sql));
    });
  }

  it("counts transferred_today from status='transferred' with no summary ILIKE inference", async () => {
    stubTiles();
    const res = await request(app)
      .get(`/api/analytics/${BUSINESS_ID}`)
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(res.body.transferred_today).toBe(3);
    const transferSql = poolQueryMock.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("status = 'transferred'"));
    // The old inference bug OR'd in a summary ILIKE '%transfer%' clause.
    expect(transferSql).not.toMatch(/ILIKE/i);
  });

  // -------------------------------------------------------------------------
  // "Today" is the BUSINESS's today.
  //
  // Every tile filtered `started_at::date = CURRENT_DATE`, which casts in the
  // database session timezone -- UTC on Cloud SQL. For a Europe/London tenant
  // that is right for most of the year by luck and wrong for an hour either
  // side of midnight in summer; for the American tenant it is wrong for most of
  // the evening, every day. A call at 23:30 in London on BST belongs to the
  // day the person who took it would name, not to tomorrow.
  //
  // The pattern is not new -- the breakdown endpoint further down this same
  // file already reads businesses.timezone and applies AT TIME ZONE. The tiles
  // simply never did.
  // -------------------------------------------------------------------------
  describe("day boundaries", () => {
    it("asks the database for the business timezone", async () => {
      stubTiles();
      await request(app)
        .get(`/api/analytics/${BUSINESS_ID}`)
        .set("Authorization", "Bearer test-token");

      const tzSql = poolQueryMock.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes("timezone") && sql.includes("FROM businesses"));
      expect(tzSql).toBeTruthy();
    });

    it("compares dates in the business timezone, never the session's", async () => {
      stubTiles();
      await request(app)
        .get(`/api/analytics/${BUSINESS_ID}`)
        .set("Authorization", "Bearer test-token");

      const tileSql = poolQueryMock.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => /FROM (calls|appointments|customer_requests)/.test(sql));

      expect(tileSql.length).toBeGreaterThanOrEqual(4);
      for (const sql of tileSql) {
        expect(sql).toContain("AT TIME ZONE");
        expect(sql).not.toContain("CURRENT_DATE");
      }
    });

    it("passes the tenant's timezone as a parameter, not as interpolated text", async () => {
      stubTiles({ timezone: "America/Chicago" });
      await request(app)
        .get(`/api/analytics/${BUSINESS_ID}`)
        .set("Authorization", "Bearer test-token");

      const tileCall = poolQueryMock.mock.calls.find(
        ([sql]) => sql.includes("FROM calls") && !sql.includes("status = 'transferred'")
      );
      expect(tileCall[1]).toEqual([BUSINESS_ID, "America/Chicago"]);
    });

    it("falls back to a timezone rather than failing when the row has none", async () => {
      stubTiles({ timezone: null });
      const res = await request(app)
        .get(`/api/analytics/${BUSINESS_ID}`)
        .set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      const tileCall = poolQueryMock.mock.calls.find(
        ([sql]) => sql.includes("FROM calls") && !sql.includes("status = 'transferred'")
      );
      expect(typeof tileCall[1][1]).toBe("string");
      expect(tileCall[1][1].length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // The follow-ups tile had no date bound at all, so it was a lifetime total
  // sitting in a row of three "today" counts. It also reached customer_requests
  // through a join to calls, which silently drops any request whose call row
  // was deleted -- call_id is ON DELETE SET NULL, so those rows still exist and
  // still need returning.
  // -------------------------------------------------------------------------
  it("bounds follow-ups to the same day and scopes them directly", async () => {
    stubTiles();
    await request(app)
      .get(`/api/analytics/${BUSINESS_ID}`)
      .set("Authorization", "Bearer test-token");

    const sql = poolQueryMock.mock.calls
      .map(([s]) => s)
      .find((s) => s.includes("FROM customer_requests"));
    expect(sql).toContain("AT TIME ZONE");
    expect(sql).toMatch(/customer_requests\s*\n?\s*WHERE business_id/);
    expect(sql).not.toContain("JOIN calls");
  });

  // -------------------------------------------------------------------------
  // Every other route in this app answers JSON {error}. This one answered
  // text/plain "Server Error", and the dashboard reads err.response.data.error
  // -- so an analytics failure rendered as a permanent loading skeleton with
  // nothing in the console. A failure that looks like slowness is worse than
  // one that looks like a failure.
  // -------------------------------------------------------------------------
  it("reports a failure as JSON, so the dashboard can show it", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid"))
        return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
      return Promise.reject(new Error("relation \"calls\" does not exist"));
    });

    const res = await request(app)
      .get(`/api/analytics/${BUSINESS_ID}`)
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
    // Not the raw Postgres message -- that goes to the log, not the browser.
    expect(res.body.error).not.toContain("relation");
  });
});
