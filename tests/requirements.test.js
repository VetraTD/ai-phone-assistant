/**
 * The requirement kinds — the structured, code-enforced half of the config
 * model.
 *
 * The distinction these tests exist to protect: a prose `notes` line is a
 * request the model usually honors, while a requirement is a rule the tool
 * layer refuses to proceed without. If these checks pass when they should fail,
 * a clinic that configured "always get the dental number" has a guarantee that
 * is really just a suggestion.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkRequirements,
  requirementParams,
  requirementPromptLines,
  withRequirements,
  collectedIdentity,
  capabilityConfig,
  identityArgName,
  CONFIRMATION_ARG,
} from "../lib/capabilities/requirements.js";
import { executeToolCall } from "../services/tools.js";
import { buildCallTools } from "../services/gemini.js";
import { CORE_TASKS } from "../services/supabase.js";

const DENTAL = {
  key: "dental_number",
  label: "Dental number",
  ask: "And your dental number — the six digits on your card?",
  pattern: "^[0-9]{6}$",
  verify: "collect_only",
};

const CFG_DENTAL = { require: { identity: { custom: [DENTAL] } } };

describe("capabilityConfig", () => {
  it("returns an empty object for an unconfigured business", () => {
    // Enforcement is opt-in. A missing row must never lock a tenant out of a
    // capability it already had.
    expect(capabilityConfig(undefined, "appointments")).toEqual({});
    expect(capabilityConfig({}, "appointments")).toEqual({});
    expect(capabilityConfig({ capabilities: {} }, "appointments")).toEqual({});
  });

  it("returns the pack's slice when present", () => {
    const config = { capabilities: { appointments: CFG_DENTAL } };
    expect(capabilityConfig(config, "appointments")).toBe(CFG_DENTAL);
  });
});

describe("custom identity fields — the dental-number case", () => {
  it("becomes a real tool parameter, not just a prompt hint", () => {
    // This is the link that makes configuration enforceable: an operator adds a
    // field, and the model is actually asked for it.
    const { properties, required } = requirementParams(CFG_DENTAL);
    expect(properties).toHaveProperty("identity_dental_number");
    expect(required).toContain("identity_dental_number");
    expect(properties.identity_dental_number.description).toContain("six digits on your card");
  });

  it("namespaces the argument so an operator key cannot collide with a tool's own", () => {
    expect(identityArgName("client_name")).toBe("identity_client_name");
  });

  it("refuses the write when the field was not collected", () => {
    const result = checkRequirements(CFG_DENTAL, { scheduled_at: "2026-08-01T10:00:00" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Dental number");
    expect(result.message).toContain("six digits on your card");
  });

  it("allows the write once it is collected and well-formed", () => {
    expect(checkRequirements(CFG_DENTAL, { identity_dental_number: "418290" }).ok).toBe(true);
  });

  it("refuses a value that does not match the configured format", () => {
    const result = checkRequirements(CFG_DENTAL, { identity_dental_number: "41" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not look right");
    // The model must re-ask, never invent a conforming value.
    expect(result.message).toContain("Do not guess");
  });

  it("collect_only does NOT verify the value against anything", () => {
    // Honest scope: a made-up but well-formed number passes. This is a speed
    // bump, not a lock — real verification needs the adapter to hold the field.
    expect(checkRequirements(CFG_DENTAL, { identity_dental_number: "999999" }).ok).toBe(true);
  });

  it("keeps what was collected so staff can check it later", () => {
    expect(collectedIdentity(CFG_DENTAL, { identity_dental_number: "418290" })).toEqual({
      dental_number: "418290",
    });
  });

  it("a malformed operator pattern does not break the call", () => {
    // Operator input is untrusted. An unusable pattern degrades to "collected
    // but unchecked", which is the same as configuring no pattern at all —
    // never a crash mid-call, and never a silent refusal the caller cannot pass.
    const bad = { require: { identity: { custom: [{ ...DENTAL, pattern: "([" }] } } };
    expect(checkRequirements(bad, { identity_dental_number: "whatever" }).ok).toBe(true);
  });

  it("tells the model to collect it up front rather than learning by refusal", () => {
    const lines = requirementPromptLines(CFG_DENTAL);
    expect(lines.join(" ")).toContain("Dental number");
    expect(lines.join(" ")).toContain("Never guess");
  });
});

describe("confirmBeforeWrite", () => {
  const cfg = { require: { confirmBeforeWrite: true } };

  it("refuses until the model asserts an explicit confirmation", () => {
    const result = checkRequirements(cfg, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("explicit yes");
  });

  it("is not satisfied by a truthy non-true value", () => {
    // "yes" or 1 would mean the model decided what counts as confirmation.
    expect(checkRequirements(cfg, { [CONFIRMATION_ARG]: "yes" }).ok).toBe(false);
    expect(checkRequirements(cfg, { [CONFIRMATION_ARG]: 1 }).ok).toBe(false);
    expect(checkRequirements(cfg, { [CONFIRMATION_ARG]: true }).ok).toBe(true);
  });
});

describe("requiredFields", () => {
  const cfg = { require: { requiredFields: ["service_description"] } };

  it("refuses on missing, empty, or whitespace-only values", () => {
    expect(checkRequirements(cfg, {}).ok).toBe(false);
    expect(checkRequirements(cfg, { service_description: "" }).ok).toBe(false);
    expect(checkRequirements(cfg, { service_description: "   " }).ok).toBe(false);
    expect(checkRequirements(cfg, { service_description: "water heater" }).ok).toBe(true);
  });
});

describe("businessHoursOnly", () => {
  const cfg = { require: { businessHoursOnly: true } };
  const WEEKDAYS = {
    mon: { open: "09:00", close: "17:00", closed: false },
    sat: { open: null, close: null, closed: true },
    sun: { open: null, close: null, closed: true },
  };

  afterEach(() => vi.useRealTimers());

  it("allows a write during opening hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00Z")); // Monday noon UTC
    const ctx = { config: { timezone: "UTC", businessHours: WEEKDAYS } };
    expect(checkRequirements(cfg, {}, ctx).ok).toBe(true);
  });

  it("refuses outside them, and steers to a message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T22:00:00Z")); // Monday, after close
    const ctx = { config: { timezone: "UTC", businessHours: WEEKDAYS } };
    const result = checkRequirements(cfg, {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("take a message");
  });

  it("refuses on a closed day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00Z")); // Saturday
    const ctx = { config: { timezone: "UTC", businessHours: WEEKDAYS } };
    expect(checkRequirements(cfg, {}, ctx).ok).toBe(false);
  });

  it("a business with no hours configured is always available", () => {
    expect(checkRequirements(cfg, {}, { config: { businessHours: null } }).ok).toBe(true);
  });
});

describe("no configuration means no change", () => {
  it("passes everything", () => {
    expect(checkRequirements({}, {}).ok).toBe(true);
    expect(checkRequirements(undefined, {}).ok).toBe(true);
  });

  it("leaves a tool declaration byte-identical", () => {
    // What lets the golden prompt snapshots keep guarding against drift: an
    // unconfigured business must see exactly the tools it saw before.
    const decl = { name: "x", description: "d", parameters: { type: "object", properties: {} } };
    expect(withRequirements(decl, {})).toBe(decl);
  });
});

describe("the configured field reaches the model", () => {
  // The bug this locks: buildCallTools used to take only allowedTasks, so packs
  // could not see config.capabilities and the requirement never became a tool
  // parameter. The tool layer still REFUSED without it, so the model was told
  // to supply a field its schema had nowhere to put — a call that deadlocks on
  // a refusal it cannot satisfy. Enforcement and collectability have to ship
  // together, which is why this asserts the whole path rather than the check.
  const config = {
    allowedTasks: [...CORE_TASKS, "book_appointment"],
    capabilities: { appointments: CFG_DENTAL },
  };

  it("buildCallTools given the full config adds the parameter", () => {
    const decl = buildCallTools(config).functionDeclarations.find((d) => d.name === "book_appointment");
    expect(decl.parameters.properties).toHaveProperty("identity_dental_number");
    expect(decl.parameters.required).toContain("identity_dental_number");
  });

  it("the legacy array form is accepted but cannot carry requirements", () => {
    // Kept working for existing callers; documented as lossy so nobody wires
    // the live path through it again.
    const decl = buildCallTools(config.allowedTasks).functionDeclarations.find(
      (d) => d.name === "book_appointment"
    );
    expect(decl.parameters.properties).not.toHaveProperty("identity_dental_number");
  });
});

describe("enforcement is wired into tool dispatch", () => {
  const ctx = {
    businessId: "biz-1",
    callerPhone: "+15551234567",
    callId: "call-1",
    integrations: [],
    capabilityState: {},
    config: { capabilities: { quotes: CFG_DENTAL } },
  };

  it("a write tool is refused when a requirement is unmet, and does not run", async () => {
    const { functionResponse, stateEffects } = await executeToolCall(
      { id: "1", name: "record_quote_request", args: { service_description: "water heater" } },
      ctx
    );

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toContain("Dental number");
    // The pack never executed: no effect was emitted.
    expect(stateEffects.capabilityEffects).toBeUndefined();
  });

  it("the same call succeeds once the requirement is satisfied", async () => {
    const { functionResponse, stateEffects } = await executeToolCall(
      {
        id: "1",
        name: "record_quote_request",
        args: { service_description: "water heater", identity_dental_number: "418290" },
      },
      ctx
    );

    expect(functionResponse.response.success).toBe(true);
    expect(stateEffects.capabilityEffects[0].type).toBe("requested");
  });

  it("a read tool is NOT gated", async () => {
    // Gating a lookup would stop the receptionist finding the record it needs
    // in order to ask the caller about it — the key locked inside the door.
    const readCtx = { ...ctx, config: { capabilities: { appointments: CFG_DENTAL } } };
    const { functionResponse } = await executeToolCall(
      { id: "1", name: "get_caller_appointments_from_db", args: {} },
      readCtx
    );
    expect(functionResponse.response.success).toBe(true);
  });
});
