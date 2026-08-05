import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// GET /api/businesses/:id/callers/:phone must not serve caller data.
//
// It used to return a caller's prior-call count, their last call's summary, and
// the times and names on their upcoming appointments, to anyone who knew a
// business UUID and a phone number — no authentication of any kind, and a UUID
// is an identifier rather than a secret. It was removed; this test is written
// so it passes under EITHER remedy (deletion, or a fail-closed guard), because
// what matters is that the data does not come back, not which mechanism stops
// it.
// ---------------------------------------------------------------------------

const mockFetchCallerContext = vi.fn();

vi.mock("../services/supabase.js", () => ({
  fetchBusinessById: vi.fn(async () => ({ id: "11111111-1111-1111-1111-111111111111", name: "Test Biz" })),
  updateBusinessPhoneNumber: vi.fn(),
  fetchCallerContext: (...args) => mockFetchCallerContext(...args),
}));

vi.mock("../services/twilioNumbers.js", () => ({
  searchAvailableNumbers: vi.fn(),
  purchaseNumber: vi.fn(),
}));

// See the note in tests/phone-numbers-api.test.js — server.js's import graph is
// slow enough to race a per-test timeout, so pay it once in setup.
let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

describe("GET /api/businesses/:id/callers/:phone", () => {
  const url = "/api/businesses/11111111-1111-1111-1111-111111111111/callers/%2B15551234567";

  it("does not serve a caller profile", async () => {
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
  });

  it("returns no call history and no appointment data, whatever the status", async () => {
    // The load-bearing assertion. A route that 404s but still leaks in the body
    // (or one restored later behind a broken guard) fails here.
    mockFetchCallerContext.mockResolvedValue({
      callCount: 7,
      lastCallSummary: "booked a cleaning",
      upcomingAppointments: [{ id: "a1", client_name: "Jane Doe", scheduled_at: "2026-09-10T15:00:00.000Z" }],
    });

    const res = await request(app).get(url);
    const body = JSON.stringify(res.body ?? "");

    expect(body).not.toMatch(/callCount/);
    expect(body).not.toMatch(/upcomingAppointments/);
    expect(body).not.toMatch(/lastCallSummary/);
    expect(body).not.toMatch(/Jane Doe/);
    expect(body).not.toMatch(/booked a cleaning/);
  });

  it("never reaches the database at all", async () => {
    mockFetchCallerContext.mockClear();
    await request(app).get(url);
    expect(mockFetchCallerContext).not.toHaveBeenCalled();
  });
});
