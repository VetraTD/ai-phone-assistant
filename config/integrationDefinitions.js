/**
 * Integration definitions catalog.
 * v1: Only Custom webhook is usable. athenahealth, mcp reserved for future.
 * Add providers to this list when we ship their connectors.
 */

/** @typedef {{ id: string, name: string, authType: string, configSchema?: object }} IntegrationDefinition */

/** @type {IntegrationDefinition[]} */
export const INTEGRATION_DEFINITIONS = [
  {
    id: "webhook",
    name: "Custom webhook",
    authType: "webhook",
    configSchema: {
      type: "object",
      required: ["url", "method"],
      properties: {
        url: { type: "string", format: "uri", description: "HTTPS URL to call when the AI invokes this tool" },
        method: { type: "string", enum: ["POST", "PUT"], default: "POST" },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "Optional HTTP headers (e.g. Authorization)" },
        params_schema: { type: "object", description: "JSON Schema for tool parameters" },
        description: { type: "string", description: "Human-readable description for the AI" },
      },
    },
  },
];

/**
 * Get definition by provider id.
 * @param {string} providerId
 * @returns {IntegrationDefinition | null}
 */
export function getIntegrationDefinition(providerId) {
  return INTEGRATION_DEFINITIONS.find((d) => d.id === providerId) ?? null;
}

/**
 * List all available (usable) integration definitions.
 * @returns {IntegrationDefinition[]}
 */
export function listIntegrationDefinitions() {
  return [...INTEGRATION_DEFINITIONS];
}
