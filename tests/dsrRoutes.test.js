import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// A5 — the data-subject request routes, at the HTTP boundary.
//
// What they actually do to the database is asserted against a real PostgreSQL
// in tests/db/dsr.test.js, where it means something. This file asks the other
// question, and it is the one A1.5 makes unavoidable: can anyone who is not
// the tenant reach them.
//
// The route these replace was DELETED for exactly that reason. It served a
// caller's call history and upcoming appointments to anyone holding a business
// UUID and a phone number, both of which are identifiers rather than secrets.
// These two are strictly more sensitive — one returns every transcript, the
// other destroys them — so "401 when anonymous" and "403 across tenants" are
// asserted before anything else about them.
// ---------------------------------------------------------------------------

const mockExportCallerData = vi.fn();
const mockEraseCallerData = vi.fn();
const mockFetchUserByEmail = vi.fn();
const mockVerifyAccessToken = vi.fn();

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  exportCallerData: (...a) => mockExportCallerData(...a),
  eraseCallerData: (...a) => mockEraseCallerData(...a),
  fetchUserByEmail: (...a) => mockFetchUserByEmail(...a),
}));

vi.mock("../lib/auth/accessToken.js", async (importOriginal) => ({
  ...(await importOriginal()),
  verifyAccessToken: (...a) => mockVerifyAccessToken(...a),
}));

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 20000);

const BUSINESS = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const PHONE = "+15551234567";

const EMPTY = { calls: [], transcripts: [], appointments: [], customerRequests: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAccessToken.mockResolvedValue({ email: "staff@example.com" });
  mockFetchUserByEmail.mockResolvedValue({ id: "user-1", business_id: BUSINESS });
  mockExportCallerData.mockResolvedValue(EMPTY);
  mockEraseCallerData.mockResolvedValue({ transcripts: 0, calls: 0, appointments: 0, customerRequests: 0 });
});

const routes = [
  ["get", `/api/businesses/${BUSINESS}/callers/${encodeURIComponent(PHONE)}/export`],
  ["delete", `/api/businesses/${BUSINESS}/callers/${encodeURIComponent(PHONE)}`],
];

describe.each(routes)("%s %s", (method, url) => {
  it("401s with no authorization header, and never touches the database", async () => {
    const res = await request(app)[method](url);

    expect(res.status).toBe(401);
    expect(mockExportCallerData).not.toHaveBeenCalled();
    expect(mockEraseCallerData).not.toHaveBeenCalled();
  });

  it("401s on an unverifiable token", async () => {
    mockVerifyAccessToken.mockResolvedValue(null);

    const res = await request(app)[method](url).set("Authorization", "Bearer nonsense");

    expect(res.status).toBe(401);
    expect(mockExportCallerData).not.toHaveBeenCalled();
    expect(mockEraseCallerData).not.toHaveBeenCalled();
  });

  // The one that matters most for erasure: a valid session for the WRONG
  // tenant. A 403 after the delete would satisfy a status-code assertion and
  // still have destroyed another clinic's transcripts.
  it("403s for a staff user of a different business, before doing anything", async () => {
    mockFetchUserByEmail.mockResolvedValue({ id: "user-2", business_id: OTHER });

    const res = await request(app)[method](url).set("Authorization", "Bearer t");

    expect(res.status).toBe(403);
    expect(mockExportCallerData).not.toHaveBeenCalled();
    expect(mockEraseCallerData).not.toHaveBeenCalled();
  });

  it("400s on a business id that is not a UUID", async () => {
    const res = await request(app)
      [method](url.replace(BUSINESS, "not-a-uuid"))
      .set("Authorization", "Bearer t");

    expect([400, 403]).toContain(res.status);
    expect(mockExportCallerData).not.toHaveBeenCalled();
    expect(mockEraseCallerData).not.toHaveBeenCalled();
  });
});

describe("GET export, authorised", () => {
  it("returns the export scoped to the caller and the tenant", async () => {
    mockExportCallerData.mockResolvedValue({
      ...EMPTY,
      calls: [{ id: "c1", summary: "s" }],
    });

    const res = await request(app)
      .get(`/api/businesses/${BUSINESS}/callers/${encodeURIComponent(PHONE)}/export`)
      .set("Authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(mockExportCallerData).toHaveBeenCalledWith(BUSINESS, PHONE);
    expect(res.body.subject.phone).toBe(PHONE);
    expect(res.body.calls).toHaveLength(1);
  });

  it("rejects a phone number too short to be one, without querying", async () => {
    const res = await request(app)
      .get(`/api/businesses/${BUSINESS}/callers/123/export`)
      .set("Authorization", "Bearer t");

    expect(res.status).toBe(400);
    expect(mockExportCallerData).not.toHaveBeenCalled();
  });

  // Loose on purpose: the stored spellings are inconsistent, matching is on the
  // last ten digits, and demanding E.164 here would reject the format a member
  // of staff is most likely to paste out of a ticket.
  it("accepts a hand-typed national format", async () => {
    const res = await request(app)
      .get(`/api/businesses/${BUSINESS}/callers/${encodeURIComponent("(555) 123-4567")}/export`)
      .set("Authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(mockExportCallerData).toHaveBeenCalledWith(BUSINESS, "(555) 123-4567");
  });

  it("500s rather than returning a partial export when the read fails", async () => {
    mockExportCallerData.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/businesses/${BUSINESS}/callers/${encodeURIComponent(PHONE)}/export`)
      .set("Authorization", "Bearer t");

    expect(res.status).toBe(500);
  });
});

describe("DELETE erasure, authorised", () => {
  it("reports what was erased", async () => {
    mockEraseCallerData.mockResolvedValue({ transcripts: 3, calls: 1, appointments: 1, customerRequests: 2 });

    const res = await request(app)
      .delete(`/api/businesses/${BUSINESS}/callers/${encodeURIComponent(PHONE)}`)
      .set("Authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.erased).toEqual({ transcripts: 3, calls: 1, appointments: 1, customerRequests: 2 });
  });

  // A partial erasure that reported success is the worst outcome available: it
  // satisfies nobody and leaves the controller believing the request was
  // honoured. The data layer runs it in one transaction and returns null on
  // failure; this asserts the route does not dress that up as a 200.
  it("500s when the erasure failed, rather than reporting success", async () => {
    mockEraseCallerData.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/businesses/${BUSINESS}/callers/${encodeURIComponent(PHONE)}`)
      .set("Authorization", "Bearer t");

    expect(res.status).toBe(500);
    expect(res.body.erased).toBeUndefined();
  });
});
