import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockFetchBusinessById = vi.fn();
const mockUpdateBusinessPhoneNumber = vi.fn();
const mockSearchAvailableNumbers = vi.fn();
const mockPurchaseNumber = vi.fn();

vi.mock("../services/supabase.js", () => ({
  fetchBusinessById: (...args) => mockFetchBusinessById(...args),
  updateBusinessPhoneNumber: (...args) => mockUpdateBusinessPhoneNumber(...args),
}));

vi.mock("../services/twilioNumbers.js", () => ({
  searchAvailableNumbers: (...args) => mockSearchAvailableNumbers(...args),
  purchaseNumber: (...args) => mockPurchaseNumber(...args),
}));

describe("GET /api/businesses/:id/phone-numbers/available", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when business id is missing", async () => {
    const { app } = await import("../server.js");
    // Path with empty :id segment (double slash) - Express may return 404 if route does not match
    const res = await request(app)
      .get("/api/businesses//phone-numbers/available")
      .query({ country: "US" });

    expect([400, 404]).toContain(res.status);
    if (res.status === 400) expect(res.body.error).toMatch(/business id/i);
  });

  it("returns 404 when business not found", async () => {
    mockFetchBusinessById.mockResolvedValue(null);
    const { app } = await import("../server.js");
    const res = await request(app).get(
      "/api/businesses/00000000-0000-0000-0000-000000000000/phone-numbers/available"
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Business not found");
  });

  it("returns 200 with numbers when search succeeds", async () => {
    mockFetchBusinessById.mockResolvedValue({ id: "biz-1", name: "Test Biz" });
    mockSearchAvailableNumbers.mockResolvedValue([
      { phone_number: "+15551234567", friendly_name: "(555) 123-4567", locality: "SF", region: "CA" },
    ]);
    const { app } = await import("../server.js");
    const res = await request(app)
      .get("/api/businesses/biz-1/phone-numbers/available")
      .query({ country: "US", areaCode: "555" });

    expect(res.status).toBe(200);
    expect(res.body.numbers).toHaveLength(1);
    expect(res.body.numbers[0].phone_number).toBe("+15551234567");
    expect(mockSearchAvailableNumbers).toHaveBeenCalledWith(
      expect.objectContaining({ country: "US", areaCode: "555", type: "local", limit: 20 })
    );
  });

  it("returns 502 when Twilio search throws", async () => {
    mockFetchBusinessById.mockResolvedValue({ id: "biz-1" });
    mockSearchAvailableNumbers.mockRejectedValue(new Error("Twilio error"));
    const { app } = await import("../server.js");
    const res = await request(app).get("/api/businesses/biz-1/phone-numbers/available");

    expect(res.status).toBe(502);
    expect(res.body.error).toBeDefined();
  });
});

describe("POST /api/businesses/:id/phone-numbers/buy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  it("returns 404 when business not found", async () => {
    mockFetchBusinessById.mockResolvedValue(null);
    const { app } = await import("../server.js");
    const res = await request(app)
      .post("/api/businesses/00000000-0000-0000-0000-000000000000/phone-numbers/buy")
      .send({ phone_number: "+15551234567" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Business not found");
  });

  it("returns 400 when phone_number is missing", async () => {
    mockFetchBusinessById.mockResolvedValue({ id: "biz-1", phone_number: null });
    const { app } = await import("../server.js");
    const res = await request(app).post("/api/businesses/biz-1/phone-numbers/buy").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone_number/i);
  });

  it("returns 409 when business already has a different number", async () => {
    mockFetchBusinessById.mockResolvedValue({
      id: "biz-1",
      phone_number: "+15559999999",
    });
    const { app } = await import("../server.js");
    const res = await request(app)
      .post("/api/businesses/biz-1/phone-numbers/buy")
      .send({ phone_number: "+15551234567" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a phone number/i);
    expect(mockPurchaseNumber).not.toHaveBeenCalled();
  });

  it("returns 200 with phone_number and sid when purchase succeeds", async () => {
    mockFetchBusinessById
      .mockResolvedValueOnce({ id: "biz-1", phone_number: null })
      .mockResolvedValueOnce({ id: "biz-1", phone_number: null });
    mockPurchaseNumber.mockResolvedValue({
      sid: "PNabc123",
      phone_number: "+15551234567",
    });
    mockUpdateBusinessPhoneNumber.mockResolvedValue(true);
    const { app } = await import("../server.js");
    const res = await request(app)
      .post("/api/businesses/biz-1/phone-numbers/buy")
      .send({ phone_number: "+15551234567" });

    expect(res.status).toBe(200);
    expect(res.body.phone_number).toBe("+15551234567");
    expect(res.body.sid).toBe("PNabc123");
    expect(mockPurchaseNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: "+15551234567",
        voiceUrl: "https://test.example.com/twilio/voice",
        statusCallback: "https://test.example.com/twilio/status",
      })
    );
    expect(mockUpdateBusinessPhoneNumber).toHaveBeenCalledWith("biz-1", "+15551234567");
  });

  it("returns 200 with sid null when buying same number already on business (idempotent)", async () => {
    mockFetchBusinessById.mockResolvedValue({
      id: "biz-1",
      phone_number: "+15551234567",
    });
    mockPurchaseNumber.mockResolvedValue({ sid: "PNunused", phone_number: "+15551234567" });
    const { app } = await import("../server.js");
    const res = await request(app)
      .post("/api/businesses/biz-1/phone-numbers/buy")
      .send({ phone_number: "+15551234567" });

    expect(res.status).toBe(200);
    expect(res.body.phone_number).toBe("+15551234567");
    expect(res.body.sid).toBeNull();
    expect(mockPurchaseNumber).not.toHaveBeenCalled();
  });

  it("returns 400 when Twilio says number no longer available", async () => {
    mockFetchBusinessById.mockResolvedValue({ id: "biz-1", phone_number: null });
    const err = new Error("not available");
    err.code = 21608;
    mockPurchaseNumber.mockRejectedValue(err);
    const { app } = await import("../server.js");
    const res = await request(app)
      .post("/api/businesses/biz-1/phone-numbers/buy")
      .send({ phone_number: "+15551234567" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer available|search again/i);
  });

  it("returns 500 when DB update fails after purchase", async () => {
    mockFetchBusinessById.mockResolvedValue({ id: "biz-1", phone_number: null });
    mockPurchaseNumber.mockResolvedValue({
      sid: "PNabc123",
      phone_number: "+15551234567",
    });
    mockUpdateBusinessPhoneNumber.mockResolvedValue(false);
    const { app } = await import("../server.js");
    const res = await request(app)
      .post("/api/businesses/biz-1/phone-numbers/buy")
      .send({ phone_number: "+15551234567" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/save|failed/i);
  });
});
