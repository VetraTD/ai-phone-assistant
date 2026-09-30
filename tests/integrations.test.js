import { describe, it, expect, vi, beforeEach } from "vitest";

// The webhook talks through lib/net/ssrfGuard.js fetchVetted; these tests
// intercept at its seam (_setWebhookTransport) so nothing touches DNS or the
// network. The real vetted transport is covered in tests/webhookSsrf.test.js.
const transport = vi.fn();

import {
  validateWebhookConfig,
  executeWebhook,
  executeIntegration,
} from "../services/integrations.js";
import { _setWebhookTransport } from "../integrations/webhook.js";

const okResponse = (obj, status = 200) => ({ status, headers: {}, body: JSON.stringify(obj), truncated: false });

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
      transport.mockReset();
      transport.mockResolvedValue(okResponse({ success: true, message: "Done." }));
      _setWebhookTransport(transport);
    });

    it("POSTs to config.url with payload", async () => {
      const integration = {
        provider: "webhook",
        name: "test_tool",
        config: { url: "https://example.com/hook", method: "POST" },
      };
      const payload = { tool: "test_tool", arguments: { x: 1 }, business_id: "b1", call_id: "c1", caller_phone: "+1" };

      const result = await executeWebhook(integration, payload);

      expect(transport).toHaveBeenCalledWith(
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
      transport.mockResolvedValue(okResponse({ error: "Internal error" }, 500));
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
      transport.mockReset();
      transport.mockResolvedValue(okResponse({ success: true, message: "OK" }));
      _setWebhookTransport(transport);
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

    it("routes athenahealth to executeAthenahealth and returns error when practice_id missing", async () => {
      const integration = { provider: "athenahealth", name: "athenahealth", enabled: true, config: {} };
      const result = await executeIntegration(integration, { tool: "get_caller_appointments", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/practice_id|Missing/);
    });

    it("returns not available for mcp", async () => {
      const integration = { provider: "mcp", name: "mcp_tool", enabled: true, config: {} };
      const result = await executeIntegration(integration, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("not available");
    });
  });
});
