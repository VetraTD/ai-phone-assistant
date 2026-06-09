/**
 * Integration router and provider exports.
 * Provider implementations live in integrations/*.js; this module routes by provider.
 */

import { executeWebhook, validateWebhookConfig } from "./webhook.js";
import { executeAthenahealth } from "./athenahealth.js";

export { validateWebhookConfig, executeWebhook } from "./webhook.js";
export { executeAthenahealth, getAthenaAccessToken, clearAthenaTokenCache, getCallerAppointments, getAvailableSlots, bookAppointment, cancelAppointment, rescheduleAppointment } from "./athenahealth.js";

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
      return executeAthenahealth(integration, payload);
    case "mcp":
      return { success: false, error: "Integration not available yet." };
    default:
      return { success: false, error: "Unknown integration provider." };
  }
}
