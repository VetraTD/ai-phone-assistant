/**
 * Webhook integration: POST to config.url with payload.
 * No PHI in logs; HTTPS only; private IP blocking for SSRF prevention.
 */

import dns from "dns";
import { log } from "../lib/logger.js";
import { IS_HIPAA_MODE } from "../lib/deploymentMode.js";

/**
 * Check if an IP address is private/reserved.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIP(ip) {
  if (!ip) return true;
  // IPv6 loopback and link-local
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7
  if (ip.startsWith("fe80")) return true; // fe80::/10

  // IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 127) return true; // 127.0.0.0/8
  if (parts[0] === 10) return true; // 10.0.0.0/8
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
  if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16
  if (parts[0] === 0) return true; // 0.0.0.0/8
  return false;
}

// Must stay comfortably inside the LLM turn budget that wraps it
// (lib/voice/llmTurn.js: 8s base, extended per tool round). At the old 10s a
// slow endpoint blew the whole turn before its own timeout could fire, so the
// caller heard "Sorry, I'm taking a bit longer. Could you repeat that?"
// instead of the answer — a worse outcome than a clean tool failure, which
// the model can at least explain. Env-overridable for a slow integration.
const WEBHOOK_TIMEOUT_MS = Number.parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 6_000;
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
 * Whether a BAA is recorded for this integration's endpoint.
 *
 * A timestamp in a database is a record that somebody asserted an agreement
 * exists, not evidence that it does. Its value is that the assertion is
 * explicit, attributable and auditable — and that its absence is a refusal
 * rather than a silent send.
 *
 * Empty and whitespace strings count as absent. A column that is `text`-ish in
 * transit through JSON can arrive as "" from a form that submitted a blank
 * field, and "" is not a date.
 *
 * @param {{ baa_recorded_at?: unknown }} integration
 * @returns {boolean}
 */
function hasRecordedBaa(integration) {
  const v = integration?.baa_recorded_at;
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
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

  // A webhook posts the tool's arguments and the caller's phone number to a URL
  // the tenant typed into a settings form. In a HIPAA deployment that is a
  // disclosure of PHI to a third party, which is what a Business Associate
  // Agreement exists to authorise — so without a recorded one, it does not go.
  //
  // BEFORE the DNS lookup below, not after. A blocked request must not resolve
  // the hostname either: a DNS query for a tenant's endpoint tells that
  // endpoint's operator (and their resolver) that a call is happening, which is
  // a smaller disclosure than the payload but the same kind. Nothing leaves.
  //
  // Mode-scoped, so `standard` deployments are unaffected. The record lives on
  // integrations.baa_recorded_at (migration 027) and every existing row is NULL,
  // which is the correct direction to fail: an unrecorded BAA is
  // indistinguishable from no BAA.
  if (IS_HIPAA_MODE && !hasRecordedBaa(integration)) {
    log.error("webhook_blocked_no_baa", {
      integrationId: integration.id || null,
      businessId: payload?.business_id || null,
    });
    // `error` is handed to the model (services/tools.js shapes it into the
    // functionResponse), so it is deliberately caller-neutral. "no Business
    // Associate Agreement is recorded" is internal vocabulary, and a
    // receptionist that paraphrases internal vocabulary out loud is a defect
    // this codebase has already shipped once. The diagnosis goes to the log
    // above and to `reason`, which nothing speaks.
    return {
      success: false,
      reason: "baa_not_recorded",
      error: "That isn't available right now.",
    };
  }

  const url = config.url;

  // SSRF protection: resolve hostname and block private/reserved IPs
  try {
    const hostname = new URL(url).hostname;
    const { address } = await dns.promises.lookup(hostname);
    if (isPrivateIP(address)) {
      return { success: false, error: "URL resolves to a private/reserved address" };
    }
  } catch (e) {
    return { success: false, error: `Cannot resolve webhook hostname: ${e.message}` };
  }

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
      log.info("integration_webhook", {
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

    log.info("integration_webhook", {
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
    log.info("integration_webhook", {
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
