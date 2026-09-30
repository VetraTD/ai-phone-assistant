/**
 * Webhook integration: POST to config.url with payload.
 * No PHI in logs; HTTPS only; private IP blocking for SSRF prevention.
 */

import { log } from "../lib/logger.js";
import { IS_HIPAA_MODE } from "../lib/deploymentMode.js";
import { fetchVetted, SsrfRefusedError } from "../lib/net/ssrfGuard.js";

// Transport seam. Production is lib/net/ssrfGuard.js fetchVetted (every
// resolved record vetted, pinned IP, redirects refused, one timer over the
// whole request including the body, bounded body). Tests replace it with
// _setWebhookTransport; nothing else does.
let transport = fetchVetted;
export function _setWebhookTransport(fn) {
  transport = fn || fetchVetted;
}

// A tenant endpoint is untrusted. A tool response is a JSON blob the model
// reads, so 64 KiB is generous; past it the response is a failure, never a
// truncated parse.
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

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
  // BEFORE any DNS lookup (fetchVetted, below), not after. A blocked request must not resolve
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
    // fetchVetted vets the hostname, pins the connection to the vetted
    // address, refuses redirects and enforces the timeout over the body too.
    const res = await transport(url, {
      method,
      headers,
      body,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
    });
    const durationMs = Date.now() - start;

    if (res.truncated) {
      log.info("integration_webhook", {
        tool: integration.name,
        business_id: payload.business_id,
        status: res.status,
        duration_ms: durationMs,
        success: false,
        error: "response_too_large",
      });
      return { success: false, error: "The response was too large." };
    }

    const text = res.body;
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    const ok = res.status >= 200 && res.status < 300;

    if (ok) {
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
    const isTimeout = e?.name === "AbortError" || e?.message === "timeout";
    const refused = e instanceof SsrfRefusedError ? e.reason : null;
    const isDnsFailure = ["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(e?.code);
    log.info("integration_webhook", {
      tool: integration.name,
      business_id: payload.business_id,
      duration_ms: durationMs,
      success: false,
      error: isTimeout ? "timeout" : refused ? `refused:${refused}` : e?.message,
    });
    return {
      success: false,
      error: isTimeout
        ? "Request timed out."
        : refused === "private_address"
          ? "URL resolves to a private/reserved address"
          : refused === "redirect"
            ? "The endpoint redirected the request."
            // FINAL FIX WAVE t3: every message here is FIXED. The model reads
            // tool errors aloud, and e.message carries the resolved address,
            // TLS text and socket detail; the detail stays in the log line
            // above (`error: e?.message`) and nowhere the caller can hear.
            : refused || isDnsFailure
              ? "Cannot resolve webhook hostname."
              : "Request failed.",
    };
  }
}
