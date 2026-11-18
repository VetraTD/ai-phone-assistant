// A1.1 gate: Google Calendar sync is DELETED, not disabled.
//
// The distinction matters. A feature flag or an unset GOOGLE_CLIENT_ID leaves
// the code, the OAuth client and the token columns in place, so "no PHI leaves
// for Google" holds only while the config stays wrong. Deletion makes it a
// property of the codebase.
//
// Why it went rather than got fixed: the write path pushes appointment details
// — a patient name and a reason for visit — into a third-party calendar under
// an OAuth grant Google classes as a sensitive scope, which needs a multi-week
// verification review to keep. Clinics run a practice-management system for
// this anyway. Deleting is faster AND removes a PHI egress.
//
// KEPT deliberately, and this test does not object to any of it:
//   - the `calendar_connections` table and migration 021's columns. Migrations
//     are append-only history; dropping them rewrites the past and buys nothing
//     while the rows are inert.
//   - the `oauth_states` table, for the same reason.
// Nothing in the running system reads or writes them once these tests pass.
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createTestApp } from "./harness.js";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every .js file under src/, excluding the tests that describe the removal. */
function sourceFiles(dir = SRC_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

describe("A1.1 — no code path can write to a Google Calendar", () => {
  let app, poolQueryMock;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
    // Any query at all is a failure here: a 404 must be decided by the router
    // before a handler can touch the database.
    poolQueryMock.mockImplementation((sql) => Promise.reject(new Error("unexpected query: " + sql)));
  });

  const routes = [
    ["get", "/api/calendar/auth-url"],
    ["get", "/api/calendar/callback?code=x&state=y"],
    ["get", "/api/calendar/status"],
    ["post", "/api/calendar/sync"],
    ["delete", "/api/calendar/disconnect"],
  ];

  it.each(routes)("%s %s is gone (404)", async (method, url) => {
    const res = await request(app)[method](url).set("Authorization", "Bearer t");
    expect(res.status).toBe(404);
  });

  it("the route module and the sync service no longer exist", () => {
    expect(fs.existsSync(path.join(SRC_DIR, "routes", "calendar.js"))).toBe(false);
    expect(fs.existsSync(path.join(SRC_DIR, "services", "calendarSync.js"))).toBe(false);
  });

  // The background worker is the path that ran without anyone asking it to,
  // every 90 seconds, whenever GOOGLE_CLIENT_ID happened to be set. Its absence
  // is the part of this that is hardest to verify by reading a route table.
  it("server.js starts no calendar sync worker", () => {
    const server = fs.readFileSync(path.join(SRC_DIR, "server.js"), "utf8");
    expect(server).not.toMatch(/calendar/i);
  });

  it.each([
    ["googleapis.com/calendar", /googleapis\.com\/calendar/],
    ["the Google Calendar OAuth scope", /auth\/calendar/],
    ["GOOGLE_CLIENT_SECRET", /GOOGLE_CLIENT_SECRET/],
    ["the calendar_connections table", /calendar_connections/],
    ["the oauth_states table", /oauth_states/],
  ])("no source file under src/ references %s", (_label, pattern) => {
    const offenders = sourceFiles().filter((f) => pattern.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });
});
