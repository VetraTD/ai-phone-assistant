import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// A1.5 — the four routes that shipped without an auth check.
//
// These were named, with file and line numbers, in specs published to a PUBLIC
// repository while the routes were live. `phone-numbers/buy` spends real money
// on the owner's Twilio account, so "returns 401" is not the whole gate: the
// purchase must not happen either. Both are asserted separately, because a
// handler that 401s *after* calling Twilio still costs money.
// ---------------------------------------------------------------------------

const mockFetchBusinessById = vi.fn();
const mockUpdateBusinessPhoneNumber = vi.fn();
const mockSearchAvailableNumbers = vi.fn();
const mockPurchaseNumber = vi.fn();
const mockFetchUserByEmail = vi.fn();
const mockVerifyAccessToken = vi.fn();

vi.mock("../services/db.js", () => ({
  // Transparent. The real one opens a transaction with app.business_id set;
  // that is proven against a real database in tests/db/withTenantScoping.test.js.
  withTenantSafe: async (_businessId, fn) => fn(),
  fetchBusinessById: (...args) => mockFetchBusinessById(...args),
  updateBusinessPhoneNumber: (...args) => mockUpdateBusinessPhoneNumber(...args),
  fetchUserByEmail: (...args) => mockFetchUserByEmail(...args),
}));

// Only the network-touching half is replaced. bearerFromHeader stays REAL, so
// the malformed-header case below still exercises the parser rather than a
// stub that agrees with it.
vi.mock("../lib/auth/accessToken.js", async (importOriginal) => ({
  ...(await importOriginal()),
  verifyAccessToken: (...args) => mockVerifyAccessToken(...args),
}));

vi.mock("../services/twilioNumbers.js", () => ({
  searchAvailableNumbers: (...args) => mockSearchAvailableNumbers(...args),
  purchaseNumber: (...args) => mockPurchaseNumber(...args),
}));

// Same cold-import cost as tests/phone-numbers-api.test.js — hoisted into a
// beforeAll with a generous hookTimeout rather than left to race whichever
// it() happens to run first.
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

beforeEach(() => {
  vi.clearAllMocks();
  // A business that exists, so a 404 can never be mistaken for a 401.
  mockFetchBusinessById.mockResolvedValue({ id: BUSINESS, name: "Test Biz" });
  mockSearchAvailableNumbers.mockResolvedValue([]);
});

const OTHER_BUSINESS = "22222222-2222-2222-2222-222222222222";
const authed = (req) => req.set("Authorization", "Bearer valid-token");

describe("unauthenticated access is refused", () => {
  it("GET phone-numbers/available returns 401 without a bearer token", async () => {
    const res = await request(app).get(
      `/api/businesses/${BUSINESS}/phone-numbers/available?country=US`
    );

    expect(res.status).toBe(401);
  });

  it("GET phone-numbers/available leaks no number data without a token", async () => {
    const res = await request(app).get(
      `/api/businesses/${BUSINESS}/phone-numbers/available?country=US`
    );

    expect(res.body.numbers).toBeUndefined();
    expect(mockSearchAvailableNumbers).not.toHaveBeenCalled();
  });

  it("POST phone-numbers/buy returns 401 without a bearer token", async () => {
    const res = await request(app)
      .post(`/api/businesses/${BUSINESS}/phone-numbers/buy`)
      .send({ phone_number: "+15551234567" });

    expect(res.status).toBe(401);
  });

  it("POST phone-numbers/buy spends no money without a bearer token", async () => {
    await request(app)
      .post(`/api/businesses/${BUSINESS}/phone-numbers/buy`)
      .send({ phone_number: "+15551234567" });

    // The point of the whole item: a rejected request must not have bought
    // anything on the way to being rejected.
    expect(mockPurchaseNumber).not.toHaveBeenCalled();
    expect(mockUpdateBusinessPhoneNumber).not.toHaveBeenCalled();
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await request(app)
      .get(`/api/businesses/${BUSINESS}/phone-numbers/available?country=US`)
      .set("Authorization", "not-a-bearer-token");

    expect(res.status).toBe(401);
  });
});

describe("the dead notification endpoints are gone", () => {
  // Zero callers anywhere in the repo: NotificationsSection.jsx is a
  // presentational component taking value/onChange props and never fetches.
  // server.js called them a "placeholder for future UI". Deleting beats
  // guarding — the same call made for Google Calendar sync in A1.1.
  it("GET businesses/:id/notifications no longer exists", async () => {
    const res = await request(app).get(`/api/businesses/${BUSINESS}/notifications`);

    expect(res.status).toBe(404);
  });

  it("PUT businesses/:id/notifications no longer exists", async () => {
    const res = await request(app)
      .put(`/api/businesses/${BUSINESS}/notifications`)
      .send({ notification_email: "attacker@example.com" });

    expect(res.status).toBe(404);
  });

  it("GET businesses/:id/notifications returns no settings data", async () => {
    const res = await request(app).get(`/api/businesses/${BUSINESS}/notifications`);

    expect(res.body.notification_email).toBeUndefined();
    expect(res.body.notification_phone).toBeUndefined();
  });
});

describe("an authenticated caller is scoped to their own business", () => {
  it("allows a staff user through to their own business", async () => {
    mockVerifyAccessToken.mockResolvedValue({ email: "staff@clinic.example" });
    mockFetchUserByEmail.mockResolvedValue({ business_id: BUSINESS });
    mockSearchAvailableNumbers.mockResolvedValue([
      { phone_number: "+15551234567", friendly_name: "(555) 123-4567" },
    ]);

    const res = await authed(
      request(app).get(`/api/businesses/${BUSINESS}/phone-numbers/available?country=US`)
    );

    expect(res.status).toBe(200);
    expect(res.body.numbers).toHaveLength(1);
  });

  it("refuses a staff user reaching for a different business", async () => {
    mockVerifyAccessToken.mockResolvedValue({ email: "staff@clinic.example" });
    mockFetchUserByEmail.mockResolvedValue({ business_id: OTHER_BUSINESS });

    const res = await authed(
      request(app).get(`/api/businesses/${BUSINESS}/phone-numbers/available?country=US`)
    );

    expect(res.status).toBe(403);
  });

  it("buys nothing when a staff user reaches for a different business", async () => {
    mockVerifyAccessToken.mockResolvedValue({ email: "staff@clinic.example" });
    mockFetchUserByEmail.mockResolvedValue({ business_id: OTHER_BUSINESS });

    await authed(
      request(app).post(`/api/businesses/${BUSINESS}/phone-numbers/buy`)
    ).send({ phone_number: "+15551234567" });

    expect(mockPurchaseNumber).not.toHaveBeenCalled();
  });

  it("refuses an account that authenticated but has no staff row", async () => {
    mockVerifyAccessToken.mockResolvedValue({ email: "nobody@example.com" });
    mockFetchUserByEmail.mockResolvedValue(null);

    const res = await authed(
      request(app).get(`/api/businesses/${BUSINESS}/phone-numbers/available?country=US`)
    );

    expect(res.status).toBe(403);
  });

  it("refuses a token the auth backend will not verify", async () => {
    mockVerifyAccessToken.mockResolvedValue(null);

    const res = await authed(
      request(app).get(`/api/businesses/${BUSINESS}/phone-numbers/available?country=US`)
    );

    expect(res.status).toBe(401);
  });
});
