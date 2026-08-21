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
const mockListCallerRecordingMessages = vi.fn();
const mockDeleteRecordings = vi.fn();

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  // Transparent here. The real one opens a transaction with app.business_id
  // set and rethrows on rollback — proven against a real database in
  // tests/db/withTenantScoping.test.js. These tests are about authorisation
  // and response shape.
  withTenant: async (_businessId, fn) => fn(),
  exportCallerData: (...a) => mockExportCallerData(...a),
  eraseCallerData: (...a) => mockEraseCallerData(...a),
  fetchUserByEmail: (...a) => mockFetchUserByEmail(...a),
  listCallerRecordingMessages: (...a) => mockListCallerRecordingMessages(...a),
}));

// O28. Mocked at the MODULE boundary, which is why services/twilioRecordings.js
// is a module rather than a few functions inside server.js: an erasure test
// must never be one misconfigured environment variable away from issuing a real
// DELETE against Twilio.
vi.mock("../services/twilioRecordings.js", async (importOriginal) => ({
  // The parser is pure and worth exercising for real — mocking it would let a
  // route test pass while the SID extraction was broken.
  ...(await importOriginal()),
  deleteRecordings: (...a) => mockDeleteRecordings(...a),
}));

vi.mock("../lib/auth/accessToken.js", async (importOriginal) => ({
  ...(await importOriginal()),
  verifyAccessToken: (...a) => mockVerifyAccessToken(...a),
}));

let app;
// Cold-importing server.js pulls the whole app graph — supabase-free now, but
// still the genai SDK, twilio and ws — and measures ~3s on an idle machine.
// FOUR test files pay that cost (callersRoute, routeAuth, dsrRoutes,
// phone-numbers-api), and under real contention one of them exceeded a 20s
// hook timeout during a concurrent docker build. A0's own findings say a flaky
// gate trains you to ignore the gate, so the ceiling is raised rather than the
// flake tolerated. A genuinely broken import still fails fast, with an error
// rather than a timeout, so nothing is masked.
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 40000);

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
  mockListCallerRecordingMessages.mockResolvedValue([]);
  mockDeleteRecordings.mockResolvedValue({
    ok: true,
    deleted: [],
    alreadyGone: [],
    failed: [],
    reason: null,
  });
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

// ---------------------------------------------------------------------------
// O28 — the erasure has to reach Twilio.
//
// The degraded voicemail path files a RecordingUrl into a customer_requests
// message and the audio lives at Twilio. Before this, an Art. 17 erasure
// reported success while leaving the data subject's recorded voice with a third
// party indefinitely.
// ---------------------------------------------------------------------------
describe("DELETE erasure reaches the recordings at Twilio", () => {
  const SID = "REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const MESSAGE = `Voicemail recording: https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/${SID}`;

  async function erase() {
    return request(app)
      .delete(`/api/businesses/${BUSINESS}/callers/${encodeURIComponent(PHONE)}`)
      .set("Authorization", "Bearer t");
  }

  it("deletes the recording the stored message points at", async () => {
    mockListCallerRecordingMessages.mockResolvedValue([MESSAGE]);
    const res = await erase();

    expect(mockDeleteRecordings).toHaveBeenCalledWith([SID]);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("complete");
  });

  it("deletes at Twilio BEFORE erasing our rows", async () => {
    // The order is the design, not a coincidence. Erasing first NULLs the
    // message column, destroying the only pointer to audio that still exists —
    // and for these rows there is no second pointer, because the degraded
    // voicemail path never creates a `calls` row to recover a SID from.
    const order = [];
    mockListCallerRecordingMessages.mockImplementation(async () => {
      order.push("read");
      return [MESSAGE];
    });
    mockDeleteRecordings.mockImplementation(async () => {
      order.push("twilio");
      return { ok: true, deleted: [SID], alreadyGone: [], failed: [], reason: null };
    });
    mockEraseCallerData.mockImplementation(async () => {
      order.push("erase");
      return { transcripts: 1, calls: 1, appointments: 0, customerRequests: 1 };
    });

    await erase();
    expect(order).toEqual(["read", "twilio", "erase"]);
  });

  it("still erases our rows when Twilio fails", async () => {
    // One vendor's outage must not become a total refusal of a statutory right.
    mockListCallerRecordingMessages.mockResolvedValue([MESSAGE]);
    mockDeleteRecordings.mockResolvedValue({
      ok: false,
      deleted: [],
      alreadyGone: [],
      failed: [SID],
      reason: "503: service unavailable",
    });
    mockEraseCallerData.mockResolvedValue({ transcripts: 1, calls: 1, appointments: 0, customerRequests: 1 });

    const res = await erase();
    expect(mockEraseCallerData).toHaveBeenCalled();
    expect(res.body.erased).toEqual({ transcripts: 1, calls: 1, appointments: 0, customerRequests: 1 });
  });

  it("does NOT report success when Twilio failed", async () => {
    // The failure this prevents is a member of staff ticking "erasure complete"
    // off a green response. 207 Multi-Status was considered and rejected for
    // being 2xx — every default `res.ok` check would read it as success.
    mockListCallerRecordingMessages.mockResolvedValue([MESSAGE]);
    mockDeleteRecordings.mockResolvedValue({
      ok: false,
      deleted: [],
      alreadyGone: [],
      failed: [SID],
      reason: "503: service unavailable",
    });

    const res = await erase();
    expect(res.status).toBe(502);
    expect(res.status).toBeGreaterThan(299); // the property that matters: not 2xx
    expect(res.body.status).toBe("partial");
    expect(res.body.outstanding).toMatchObject({ vendor: "twilio", recordings: 1 });
  });

  it("reports what WAS erased even on the partial path, so nobody re-runs blindly", async () => {
    mockListCallerRecordingMessages.mockResolvedValue([MESSAGE]);
    mockDeleteRecordings.mockResolvedValue({
      ok: false, deleted: [], alreadyGone: [], failed: [SID], reason: "boom",
    });
    mockEraseCallerData.mockResolvedValue({ transcripts: 3, calls: 1, appointments: 1, customerRequests: 2 });

    const res = await erase();
    expect(res.body.erased).toEqual({ transcripts: 3, calls: 1, appointments: 1, customerRequests: 2 });
  });

  it("does not call Twilio at all when the subject left no recording", async () => {
    mockListCallerRecordingMessages.mockResolvedValue(["Please call me back about my results"]);
    const res = await erase();

    expect(mockDeleteRecordings).toHaveBeenCalledWith([]);
    expect(res.status).toBe(200);
  });

  it("aborts before touching Twilio or the rows when the pointer read fails", async () => {
    // Without the pointers there is no way to know what Twilio holds, so
    // proceeding would erase the rows and lose the only index of the audio.
    mockListCallerRecordingMessages.mockResolvedValue(null);

    const res = await erase();
    expect(res.status).toBe(500);
    expect(mockDeleteRecordings).not.toHaveBeenCalled();
    expect(mockEraseCallerData).not.toHaveBeenCalled();
  });

  it("leaks no phone number into the response on any path", async () => {
    mockListCallerRecordingMessages.mockResolvedValue([MESSAGE]);
    mockDeleteRecordings.mockResolvedValue({
      ok: false, deleted: [], alreadyGone: [], failed: [SID], reason: "boom",
    });
    const res = await erase();
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
  });
});
