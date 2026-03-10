import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateWebhookConfig,
  executeWebhook,
  executeIntegration,
} from "../services/integrations.js";

describe("integrations service", () => {
  describe("validateWebhookConfig", () => {
    it("returns error when config is missing", () => {
      expect(validateWebhookConfig(null)).toContain("required");
      expect(validateWebhookConfig(undefined)).toContain("required");
    });

    it("returns error when url is missing", () => {
      expect(validateWebhookConfig({ method: "POST" })).toContain("url");
    });

    it("returns error when url is not HTTPS", () => {
      expect(validateWebhookConfig({ url: "http://example.com", method: "POST" })).toContain("HTTPS");
    });

    it("returns error when method is invalid", () => {
      expect(validateWebhookConfig({ url: "https://example.com", method: "GET" })).toContain("method");
    });

    it("returns null for valid config", () => {
      expect(validateWebhookConfig({ url: "https://example.com/webhook", method: "POST" })).toBeNull();
      expect(validateWebhookConfig({ url: "https://example.com", method: "PUT" })).toBeNull();
    });
  });

  describe("executeWebhook", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ success: true, message: "Done." })),
          })
        )
      );
    });

    it("POSTs to config.url with payload", async () => {
      const integration = {
        provider: "webhook",
        name: "test_tool",
        config: { url: "https://example.com/hook", method: "POST" },
      };
      const payload = { tool: "test_tool", arguments: { x: 1 }, business_id: "b1", call_id: "c1", caller_phone: "+1" };

      const result = await executeWebhook(integration, payload);

      expect(fetch).toHaveBeenCalledWith(
        "https://example.com/hook",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
          body: expect.stringContaining("test_tool"),
        })
      );
      expect(result.success).toBe(true);
      expect(result.message).toBe("Done.");
    });

    it("returns error for invalid config", async () => {
      const integration = {
        provider: "webhook",
        name: "test",
        config: { url: "http://bad.com", method: "POST" },
      };
      const result = await executeWebhook(integration, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("HTTPS");
    });

    it("handles non-2xx response", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve(JSON.stringify({ error: "Internal error" })),
        })
      );
      const integration = {
        provider: "webhook",
        name: "test",
        config: { url: "https://example.com/hook", method: "POST" },
      };
      const result = await executeWebhook(integration, { tool: "test", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("executeIntegration", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ success: true, message: "OK" })),
          })
        )
      );
    });

    it("routes webhook to executeWebhook", async () => {
      const integration = {
        provider: "webhook",
        name: "my_tool",
        enabled: true,
        config: { url: "https://example.com/hook", method: "POST" },
      };
      const result = await executeIntegration(integration, { tool: "my_tool", arguments: {} });
      expect(result.success).toBe(true);
      expect(result.message).toBe("OK");
    });

    it("returns error when integration is disabled", async () => {
      const integration = {
        provider: "webhook",
        name: "my_tool",
        enabled: false,
        config: { url: "https://example.com/hook", method: "POST" },
      };
      const result = await executeIntegration(integration, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("disabled");
    });

    it("returns error for unknown provider", async () => {
      const integration = { provider: "unknown", name: "x", enabled: true, config: {} };
      const result = await executeIntegration(integration, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown");
    });

    it("returns not available for athenahealth", async () => {
      const integration = { provider: "athenahealth", name: "get_appointments", enabled: true, config: {} };
      const result = await executeIntegration(integration, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("not available");
    });
  });
});
