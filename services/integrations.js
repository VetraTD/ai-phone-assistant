/**
 * Re-export integration router and providers from integrations/ for backward compatibility.
 * New code may import from "../integrations/index.js" or "../integrations" directly.
 */

export {
  validateWebhookConfig,
  executeWebhook,
  executeAthenahealth,
  executeIntegration,
  getAthenaAccessToken,
  clearAthenaTokenCache,
  getCallerAppointments,
  getAvailableSlots,
  bookAppointment,
} from "../integrations/index.js";
