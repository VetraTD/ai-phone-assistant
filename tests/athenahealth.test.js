import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAthenaAccessToken,
  executeAthenahealth,
  getCallerAppointments,
  getAvailableSlots,
  bookAppointment,
  clearAthenaTokenCache,
} from "../integrations/athenahealth.js";

describe("athenahealth service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    clearAthenaTokenCache();
    vi.stubGlobal("fetch", vi.fn());
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe("getAthenaAccessToken", () => {
    it("returns null when env is missing", async () => {
      delete process.env.ATHENA_CLIENT_ID;
      delete process.env.ATHENA_CLIENT_SECRET;
      delete process.env.ATHENA_TOKEN_URL;
      const token = await getAthenaAccessToken();
      expect(token).toBeNull();
    });

    it("returns access_token when token endpoint returns 200", async () => {
      process.env.ATHENA_CLIENT_ID = "test-client";
      process.env.ATHENA_CLIENT_SECRET = "test-secret";
      process.env.ATHENA_TOKEN_URL = "https://api.preview.platform.athenahealth.com/oauth2/v1/token";
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "mock-token", expires_in: 3600 }),
      });
      const token = await getAthenaAccessToken();
      expect(token).toMatchObject({ access_token: "mock-token" });
      expect(token).toHaveProperty("api_base");
      expect(fetch).toHaveBeenCalledWith(
        process.env.ATHENA_TOKEN_URL,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: expect.stringContaining("Basic "),
          }),
          body: "grant_type=client_credentials",
        })
      );
    });

    it("returns null when token endpoint returns non-2xx", async () => {
      process.env.ATHENA_CLIENT_ID = "test-client";
      process.env.ATHENA_CLIENT_SECRET = "test-secret";
      process.env.ATHENA_TOKEN_URL = "https://api.example.com/token";
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "unauthorized" }),
      });
      const token = await getAthenaAccessToken();
      expect(token).toBeNull();
    });

    it("uses ECC_ATHENA_* env when config.use_ecc_app is true", async () => {
      process.env.ECC_ATHENA_CLIENT_ID = "ecc-client";
      process.env.ECC_ATHENA_CLIENT_SECRET = "ecc-secret";
      process.env.ECC_ATHENA_TOKEN_URL = "https://ecc-api.example.com/oauth2/v1/token";
      process.env.ECC_ATHENA_API_BASE = "https://ecc-api.example.com";
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "ecc-token", expires_in: 3600 }),
      });
      const token = await getAthenaAccessToken({ use_ecc_app: true });
      expect(token).toMatchObject({ access_token: "ecc-token", api_base: "https://ecc-api.example.com" });
      expect(fetch).toHaveBeenCalledWith(
        "https://ecc-api.example.com/oauth2/v1/token",
        expect.any(Object)
      );
    });
  });

  describe("executeAthenahealth", () => {
    it("returns error when practice_id is missing", async () => {
      const integration = { config: {} };
      const result = await executeAthenahealth(integration, { tool: "get_caller_appointments", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/practice_id|Missing/);
    });

    it("returns error when token cannot be obtained", async () => {
      process.env.ATHENA_CLIENT_ID = "";
      process.env.ATHENA_CLIENT_SECRET = "";
      process.env.ATHENA_TOKEN_URL = "";
      const integration = { config: { practice_id: "195900" } };
      const result = await executeAthenahealth(integration, { tool: "get_caller_appointments", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.message).toBeDefined();
    });

    it("returns error for unknown tool", async () => {
      process.env.ATHENA_CLIENT_ID = "c";
      process.env.ATHENA_CLIENT_SECRET = "s";
      process.env.ATHENA_TOKEN_URL = "https://api.example.com/token";
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
      });
      const integration = { config: { practice_id: "195900" } };
      const result = await executeAthenahealth(integration, { tool: "unknown_tool", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown athena tool");
    });
  });

  describe("getCallerAppointments", () => {
    it("returns message when name is missing", async () => {
      const result = await getCallerAppointments("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/name/);
    });
  });

  describe("getAvailableSlots", () => {
    it("returns message when date is missing", async () => {
      const result = await getAvailableSlots("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/date/);
    });
  });

  describe("bookAppointment", () => {
    it("returns message when scheduled_at or name is missing", async () => {
      const result = await bookAppointment("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/name|date|time/);
    });
  });
});
