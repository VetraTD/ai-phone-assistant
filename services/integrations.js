/**
 * Integration executor: webhook runner and generic router.
 * Switches on provider: webhook (implemented), athenahealth/mcp (reserved for future).
 */

import { log } from "../lib/logger.js";

const WEBHOOK_TIMEOUT_MS = 10_000;
const ALLOWED_METHODS = ["POST", "PUT"];

/**
 * Validate webhook config. Returns error message or null if valid.
 * @param {object} config
 * @returns {string | null}
 */
export function validateWebhookConfig(config) {
  if (!config || typeof config !== "object") return "config is required";
  const url = config.url;
  if (!url || typeof url !== "string") return "url is required";
  if (!url.startsWith("https://")) return "url must be HTTPS";
  const method = (config.method || "POST").toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) return `method must be one of: ${ALLOWED_METHODS.join(", ")}`;
  return null;
}

/**
 * Execute a webhook integration: POST to config.url with payload.
 * @param {object} integration - { provider, name, config }
 * @param {object} payload - { tool, arguments, business_id, call_id, caller_phone }
 * @returns {Promise<{ success: boolean, message?: string, error?: string, data?: unknown }>}
 */
export async function executeWebhook(integration, payload) {
  const config = integration.config || {};
  const err = validateWebhookConfig(config);
  if (err) {
    return { success: false, error: `Invalid webhook config: ${err}` };
  }

  const url = config.url;
  const method = (config.method || "POST").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    ...(config.headers && typeof config.headers === "object" ? config.headers : {}),
  };

  const body = JSON.stringify({
    tool: payload.tool,
    arguments: payload.arguments || {},
    business_id: payload.business_id || null,
    call_id: payload.call_id || null,
    caller_phone: payload.caller_phone || null,
    metadata: payload.metadata || {},
  });

  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Date.now() - start;

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (res.ok) {
      const message = data?.message ?? (typeof data?.success === "boolean" ? (data.success ? "Done." : data?.error ?? "Request failed") : "Done.");
      log("integration_webhook", {
        tool: integration.name,
        business_id: payload.business_id,
        status: res.status,
        duration_ms: durationMs,
        success: true,
      });
      return {
        success: data?.success !== false,
        message: typeof message === "string" ? message : "Done.",
        data: data?.data,
      };
    }

    log("integration_webhook", {
      tool: integration.name,
      business_id: payload.business_id,
      status: res.status,
      duration_ms: durationMs,
      success: false,
    });
    return {
      success: false,
      error: data?.error || data?.message || `HTTP ${res.status}`,
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    const isTimeout = e?.name === "AbortError";
    log("integration_webhook", {
      tool: integration.name,
      business_id: payload.business_id,
      duration_ms: durationMs,
      success: false,
      error: isTimeout ? "timeout" : e?.message,
    });
    return {
      success: false,
      error: isTimeout ? "Request timed out." : (e?.message || "Request failed."),
    };
  }
}

/**
 * Execute an integration based on provider.
 * @param {object} integration - { id, business_id, provider, name, enabled, config }
 * @param {object} payload - { tool, arguments, business_id, call_id, caller_phone }
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
export async function executeIntegration(integration, payload) {
  if (!integration || !integration.provider) {
    return { success: false, error: "Invalid integration" };
  }
  if (!integration.enabled) {
    return { success: false, error: "Integration is disabled" };
  }

  switch (integration.provider) {
    case "webhook":
      return executeWebhook(integration, payload);
    case "athenahealth":
    case "mcp":
      return { success: false, error: "Integration not available yet." };
    default:
      return { success: false, error: "Unknown integration provider." };
  }
}
