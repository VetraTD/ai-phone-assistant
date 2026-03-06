import { describe, it, expect, vi, beforeEach } from "vitest";

const mockList = vi.fn();
const mockCreate = vi.fn();

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    availablePhoneNumbers: (country) => ({
      local: {
        list: (opts) => mockList(opts),
      },
      tollFree: {
        list: (opts) => mockList(opts),
      },
    }),
    incomingPhoneNumbers: {
      create: (opts) => mockCreate(opts),
    },
  })),
}));

describe("twilioNumbers service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "test";
  });

  describe("searchAvailableNumbers", () => {
    it("returns normalized list from Twilio local search", async () => {
      const { searchAvailableNumbers } = await import("../services/twilioNumbers.js");
      mockList.mockResolvedValue([
        {
          phoneNumber: "+15551234567",
          friendlyName: "(555) 123-4567",
          locality: "San Francisco",
          region: "CA",
        },
      ]);

      const result = await searchAvailableNumbers({ country: "US", areaCode: "555", type: "local" });

      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, areaCode: "555" }));
      expect(result).toEqual([
        {
          phone_number: "+15551234567",
          friendly_name: "(555) 123-4567",
          locality: "San Francisco",
          region: "CA",
        },
      ]);
    });

    it("uses default country US and limit 20", async () => {
      const { searchAvailableNumbers } = await import("../services/twilioNumbers.js");
      mockList.mockResolvedValue([]);

      await searchAvailableNumbers({});

      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    });

    it("throws when Twilio client is not configured", async () => {
      const origSid = process.env.TWILIO_ACCOUNT_SID;
      const origToken = process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      vi.resetModules();
      const { searchAvailableNumbers } = await import("../services/twilioNumbers.js");

      await expect(searchAvailableNumbers({ country: "US" })).rejects.toThrow(
        "Twilio client not configured"
      );

      process.env.TWILIO_ACCOUNT_SID = origSid;
      process.env.TWILIO_AUTH_TOKEN = origToken;
      vi.resetModules();
    });
  });

  describe("purchaseNumber", () => {
    it("calls Twilio create with voice and status URLs and returns sid and phone_number", async () => {
      const { purchaseNumber } = await import("../services/twilioNumbers.js");
      mockCreate.mockResolvedValue({
        sid: "PNabc123",
        phoneNumber: "+15559876543",
      });

      const result = await purchaseNumber({
        phoneNumber: "+15559876543",
        voiceUrl: "https://example.com/voice",
        statusCallback: "https://example.com/status",
      });

      expect(mockCreate).toHaveBeenCalledWith({
        phoneNumber: "+15559876543",
        voiceUrl: "https://example.com/voice",
        statusCallback: "https://example.com/status",
        voiceMethod: "POST",
        statusCallbackMethod: "POST",
      });
      expect(result).toEqual({ sid: "PNabc123", phone_number: "+15559876543" });
    });

    it("throws when phoneNumber, voiceUrl, or statusCallback is missing", async () => {
      const { purchaseNumber } = await import("../services/twilioNumbers.js");

      await expect(
        purchaseNumber({ phoneNumber: "+15551234567", voiceUrl: "https://x.com", statusCallback: "" })
      ).rejects.toThrow("required");

      await expect(
        purchaseNumber({ phoneNumber: "", voiceUrl: "https://x.com", statusCallback: "https://x.com" })
      ).rejects.toThrow("required");
    });
  });
});
