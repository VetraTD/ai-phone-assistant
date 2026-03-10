import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildIntegrationTools } from "../services/gemini.js";

describe("gemini buildIntegrationTools", () => {
  it("returns empty declarations when no integrations", () => {
    const result = buildIntegrationTools([]);
    expect(result.functionDeclarations).toEqual([]);
  });

  it("returns empty when integrations is null/undefined", () => {
    expect(buildIntegrationTools(null).functionDeclarations).toEqual([]);
    expect(buildIntegrationTools(undefined).functionDeclarations).toEqual([]);
  });

  it("builds tool declaration for webhook integration", () => {
    const integrations = [
      {
        provider: "webhook",
        name: "get_caller_appointments",
        enabled: true,
        config: {
          description: "Get the caller's upcoming appointments from our EHR.",
          params_schema: {
            type: "object",
            properties: {
              caller_name: { type: "string" },
              caller_dob: { type: "string" },
            },
            required: ["caller_name", "caller_dob"],
          },
        },
      },
    ];
    const result = buildIntegrationTools(integrations);
    expect(result.functionDeclarations).toHaveLength(1);
    expect(result.functionDeclarations[0]).toMatchObject({
      name: "get_caller_appointments",
      description: "Get the caller's upcoming appointments from our EHR.",
      parameters: {
        type: "object",
        properties: {
          caller_name: { type: "string" },
          caller_dob: { type: "string" },
        },
        required: ["caller_name", "caller_dob"],
      },
    });
  });

  it("skips disabled integrations", () => {
    const integrations = [
      { provider: "webhook", name: "enabled_tool", enabled: true, config: { description: "A" } },
      { provider: "webhook", name: "disabled_tool", enabled: false, config: { description: "B" } },
    ];
    const result = buildIntegrationTools(integrations);
    expect(result.functionDeclarations).toHaveLength(1);
    expect(result.functionDeclarations[0].name).toBe("enabled_tool");
  });

  it("skips non-webhook providers", () => {
    const integrations = [
      { provider: "athenahealth", name: "ehr_tool", enabled: true, config: {} },
    ];
    const result = buildIntegrationTools(integrations);
    expect(result.functionDeclarations).toHaveLength(0);
  });

  it("skips invalid tool names", () => {
    const integrations = [
      { provider: "webhook", name: "123invalid", enabled: true, config: {} },
      { provider: "webhook", name: "has-dash", enabled: true, config: {} },
      { provider: "webhook", name: "valid_name", enabled: true, config: { description: "OK" } },
    ];
    const result = buildIntegrationTools(integrations);
    expect(result.functionDeclarations).toHaveLength(1);
    expect(result.functionDeclarations[0].name).toBe("valid_name");
  });

  it("uses additionalProperties when params_schema is missing", () => {
    const integrations = [
      { provider: "webhook", name: "flexible_tool", enabled: true, config: { description: "Flex" } },
    ];
    const result = buildIntegrationTools(integrations);
    expect(result.functionDeclarations[0].parameters).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
  });
});
