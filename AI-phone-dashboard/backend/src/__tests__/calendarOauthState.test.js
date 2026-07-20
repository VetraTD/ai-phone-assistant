// Security regression tests for the Google Calendar OAuth connect flow.
//
// The callback is unauthenticated by necessity (Google redirects the browser
// to it), so `state` is attacker-controllable. It must therefore carry no
// identity: the business a set of tokens is stored against comes from the
// server-side oauth_states row, and a state value that is unknown, already
// consumed or expired must be rejected outright.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp, injectFakeAxios, DEFAULT_TEST_USER } from "./harness.js";

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";
const VICTIM_BUSINESS_ID = "33333333-3333-3333-3333-333333333333";
const FRONTEND = "https://frontend.example/app";

describe("Google Calendar OAuth state", () => {
  let app, poolQueryMock, restoreAxios, axiosPost;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.CALENDAR_FRONTEND_REDIRECT = FRONTEND;
    axiosPost = vi.fn();
    restoreAxios = injectFakeAxios({ post: axiosPost });
    ({ app, poolQueryMock } = createTestApp());
  });

  afterEach(() => {
    restoreAxios();
    vi.restoreAllMocks();
  });

  describe("GET /api/calendar/auth-url", () => {
    it("stores an opaque single-use nonce for the caller's business and puts only that in state", async () => {
      const inserts = [];
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("from users")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
        if (sql.includes("INSERT INTO oauth_states")) {
          inserts.push(params);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      const res = await request(app)
        .get("/api/calendar/auth-url")
        .set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      const state = new URL(res.body.url).searchParams.get("state");
      expect(state).toBeTruthy();

      // The nonce is opaque: it must not decode to anything containing an id.
      expect(state).not.toContain(BUSINESS_ID);
      expect(Buffer.from(state, "base64url").toString("utf8")).not.toContain(BUSINESS_ID);

      // ...and it must have been recorded server-side against this business.
      expect(inserts).toHaveLength(1);
      const [storedState, storedBusinessId, storedUserId, provider] = inserts[0];
      expect(storedState).toBe(state);
      expect(storedBusinessId).toBe(BUSINESS_ID);
      expect(storedUserId).toBe(DEFAULT_TEST_USER.id);
      expect(provider).toBe("google");
    });
  });

  describe("GET /api/calendar/callback", () => {
    function mockConsume(rows, { onConnectionUpsert } = {}) {
      const consumeCalls = [];
      const upserts = [];
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("UPDATE oauth_states")) {
          consumeCalls.push({ sql, params });
          return Promise.resolve({ rows, rowCount: rows.length });
        }
        if (sql.includes("INSERT INTO calendar_connections")) {
          upserts.push(params);
          if (onConnectionUpsert) onConnectionUpsert(params);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });
      return { consumeCalls, upserts };
    }

    it("stores tokens against the business recorded server-side, ignoring any id in state", async () => {
      axiosPost.mockResolvedValue({
        data: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      });
      const { consumeCalls, upserts } = mockConsume([{ business_id: BUSINESS_ID }]);

      // State whose *payload* names a different (victim) business — the old
      // scheme would have trusted this.
      const forgedPayload = Buffer.from(
        JSON.stringify({ businessId: VICTIM_BUSINESS_ID })
      ).toString("base64url");

      const res = await request(app).get(
        `/api/calendar/callback?code=auth-code&state=${forgedPayload}`
      );

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${FRONTEND}?calendar=connected`);

      // Consume was a single atomic UPDATE guarded on consumed_at IS NULL.
      expect(consumeCalls).toHaveLength(1);
      expect(consumeCalls[0].sql).toMatch(/consumed_at IS NULL/);
      expect(consumeCalls[0].sql).toMatch(/RETURNING business_id/);
      expect(consumeCalls[0].params[0]).toBe(forgedPayload);

      // Tokens landed on the server-side business, not the one in `state`.
      expect(upserts).toHaveLength(1);
      expect(upserts[0][0]).toBe(BUSINESS_ID);
      expect(JSON.stringify(upserts[0])).not.toContain(VICTIM_BUSINESS_ID);
    });

    it("rejects a forged/unknown state without touching calendar_connections", async () => {
      axiosPost.mockResolvedValue({ data: { access_token: "at" } });
      const { upserts } = mockConsume([]); // no matching row

      const forged = Buffer.from(
        JSON.stringify({ businessId: VICTIM_BUSINESS_ID })
      ).toString("base64url");

      const res = await request(app).get(`/api/calendar/callback?code=c&state=${forged}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("calendar=error");
      expect(res.headers.location).toContain("invalid_state");
      expect(upserts).toHaveLength(0);
      expect(axiosPost).not.toHaveBeenCalled(); // no code exchange either
    });

    it("rejects a replayed state (second use returns no row)", async () => {
      axiosPost.mockResolvedValue({
        data: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      });
      let consumed = false;
      const upserts = [];
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("UPDATE oauth_states")) {
          // Emulate `WHERE consumed_at IS NULL`: only the first use matches.
          if (consumed) return Promise.resolve({ rows: [], rowCount: 0 });
          consumed = true;
          return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }], rowCount: 1 });
        }
        if (sql.includes("INSERT INTO calendar_connections")) {
          upserts.push(params);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      const first = await request(app).get("/api/calendar/callback?code=c&state=nonce");
      expect(first.headers.location).toBe(`${FRONTEND}?calendar=connected`);

      const second = await request(app).get("/api/calendar/callback?code=c&state=nonce");
      expect(second.headers.location).toContain("invalid_state");
      expect(upserts).toHaveLength(1); // replay stored nothing
    });

    it("rejects an expired state (older than the 10 minute TTL)", async () => {
      axiosPost.mockResolvedValue({ data: { access_token: "at" } });
      const captured = [];
      const upserts = [];
      poolQueryMock.mockImplementation((sql, params) => {
        if (sql.includes("UPDATE oauth_states")) {
          captured.push(sql);
          // The TTL predicate is in SQL; a stale row simply doesn't match.
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes("INSERT INTO calendar_connections")) {
          upserts.push(params);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.reject(new Error("unexpected query: " + sql));
      });

      const res = await request(app).get("/api/calendar/callback?code=c&state=stale-nonce");

      expect(res.headers.location).toContain("invalid_state");
      expect(upserts).toHaveLength(0);
      expect(captured[0]).toMatch(/10 minutes/);
    });

    it("never reads a business id from request input", async () => {
      axiosPost.mockResolvedValue({
        data: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      });
      const { upserts } = mockConsume([{ business_id: BUSINESS_ID }]);

      // Every plausible injection point carries the victim's id.
      const res = await request(app).get(
        `/api/calendar/callback?code=c&state=nonce&businessId=${VICTIM_BUSINESS_ID}&business_id=${VICTIM_BUSINESS_ID}`
      );

      expect(res.headers.location).toBe(`${FRONTEND}?calendar=connected`);
      expect(upserts[0][0]).toBe(BUSINESS_ID);
      const allParams = JSON.stringify(poolQueryMock.mock.calls);
      expect(allParams).not.toContain(VICTIM_BUSINESS_ID);
    });
  });
});
