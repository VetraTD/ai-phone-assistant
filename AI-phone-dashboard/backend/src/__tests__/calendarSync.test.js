import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";

// calendarSync is CommonJS and requires ../db at load. Inject a no-op db into
// the require cache first so loading it never touches a real pool — every test
// passes its own fake pool as an explicit dep anyway.
const require = createRequire(import.meta.url);
const dbResolved = require.resolve("../db/index.js");
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: { query: () => {} } };

const calendarSync = require("../services/calendarSync.js");
const { syncPendingAppointments, GOOGLE_TOKEN_URL } = calendarSync;

const NOW = 1_800_000_000_000; // fixed clock
const FUTURE = new Date(NOW + 3600_000).toISOString();
const PAST = new Date(NOW - 3600_000).toISOString();

// A fake pool whose responses are chosen by matching the SQL. Records every
// call so tests can assert what was written back.
function makePool({ connections, tokenRow, appts, onUpdate, apptError }) {
  const calls = [];
  return {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/DISTINCT business_id FROM calendar_connections/.test(sql)) return { rows: connections };
      if (/access_token, refresh_token, expires_at/.test(sql)) return { rows: tokenRow ? [tokenRow] : [] };
      if (/UPDATE calendar_connections SET access_token/.test(sql)) return { rows: [] };
      if (/FROM businesses WHERE id/.test(sql)) return { rows: [{ timezone: "UTC" }] };
      if (/FROM appointments/.test(sql)) {
        if (apptError) throw new Error(apptError);
        return { rows: appts };
      }
      if (/UPDATE appointments SET google_event_id/.test(sql)) {
        onUpdate?.(params);
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

// Fake axios: token refreshes vs calendar event creates, told apart by URL.
function makeAxios() {
  let eventSeq = 0;
  const post = vi.fn(async (url) => {
    if (url === GOOGLE_TOKEN_URL) return { data: { access_token: "refreshed-token", expires_in: 3600 } };
    return { data: { id: `evt-${++eventSeq}` } };
  });
  return { post };
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
});

describe("calendarSync.syncPendingAppointments", () => {
  it("pushes each unsynced appointment once and records its google_event_id", async () => {
    const updates = [];
    const pool = makePool({
      connections: [{ business_id: "biz1" }],
      tokenRow: { access_token: "at", refresh_token: "rt", expires_at: FUTURE },
      appts: [
        { id: "a1", client_name: "Jane", scheduled_at: FUTURE },
        { id: "a2", client_name: "Bob", scheduled_at: FUTURE },
      ],
      onUpdate: (p) => updates.push(p),
    });
    const axios = makeAxios();

    const result = await syncPendingAppointments({ pool, axios, now: () => NOW });

    expect(result).toEqual({ created: 2, businesses: 1 });
    // One calendar event created per appointment...
    const eventPosts = axios.post.mock.calls.filter(([url]) => url.includes("/calendars/"));
    expect(eventPosts).toHaveLength(2);
    // ...and each appointment stamped with the returned event id (idempotency).
    expect(updates).toEqual([
      ["evt-1", "a1"],
      ["evt-2", "a2"],
    ]);
  });

  it("skips a business with no usable connection (no refresh token)", async () => {
    const pool = makePool({
      connections: [{ business_id: "biz1" }],
      tokenRow: { access_token: "at", refresh_token: null, expires_at: FUTURE },
      appts: [],
    });
    const axios = makeAxios();

    const result = await syncPendingAppointments({ pool, axios, now: () => NOW });

    expect(result).toEqual({ created: 0, businesses: 0 });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token before creating events", async () => {
    const pool = makePool({
      connections: [{ business_id: "biz1" }],
      tokenRow: { access_token: "stale", refresh_token: "rt", expires_at: PAST },
      appts: [{ id: "a1", client_name: "Jane", scheduled_at: FUTURE }],
    });
    const axios = makeAxios();

    const result = await syncPendingAppointments({ pool, axios, now: () => NOW });

    expect(result.created).toBe(1);
    expect(axios.post.mock.calls.some(([url]) => url === GOOGLE_TOKEN_URL)).toBe(true);
  });

  it("creates nothing when there are no unsynced appointments", async () => {
    const pool = makePool({
      connections: [{ business_id: "biz1" }],
      tokenRow: { access_token: "at", refresh_token: "rt", expires_at: FUTURE },
      appts: [],
    });
    const axios = makeAxios();

    const result = await syncPendingAppointments({ pool, axios, now: () => NOW });

    expect(result).toEqual({ created: 0, businesses: 1 });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("surfaces a missing-migration error so the worker can self-disable", async () => {
    const pool = makePool({
      connections: [{ business_id: "biz1" }],
      tokenRow: { access_token: "at", refresh_token: "rt", expires_at: FUTURE },
      apptError: 'column "google_event_id" does not exist',
    });
    const axios = makeAxios();

    await expect(syncPendingAppointments({ pool, axios, now: () => NOW })).rejects.toThrow(/google_event_id/);
  });

  it("isolates one business's failure from the rest", async () => {
    // Two businesses; the first errors on a live Google call, the second succeeds.
    let firstBiz = true;
    const pool = {
      query: vi.fn(async (sql, params) => {
        if (/DISTINCT business_id/.test(sql)) return { rows: [{ business_id: "bizA" }, { business_id: "bizB" }] };
        if (/access_token, refresh_token, expires_at/.test(sql))
          return { rows: [{ access_token: "at", refresh_token: "rt", expires_at: FUTURE }] };
        if (/FROM businesses/.test(sql)) return { rows: [{ timezone: "UTC" }] };
        if (/FROM appointments/.test(sql)) return { rows: [{ id: params[0] === "bizA" ? "aFail" : "aOk", scheduled_at: FUTURE }] };
        if (/UPDATE appointments/.test(sql)) return { rows: [] };
        return { rows: [] };
      }),
    };
    const axios = {
      post: vi.fn(async () => {
        if (firstBiz) {
          firstBiz = false;
          throw new Error("Google 500");
        }
        return { data: { id: "evt-ok" } };
      }),
    };
    const log = { error: vi.fn() };

    const result = await syncPendingAppointments({ pool, axios, now: () => NOW, log });

    expect(result.created).toBe(1); // bizB still synced
    expect(log.error).toHaveBeenCalled(); // bizA's failure logged, not thrown
  });
});
