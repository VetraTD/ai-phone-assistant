/**
 * Disabling a capability must stop the receptionist ACTING like it has that
 * capability, not just drop its tool.
 *
 * The bug this guards: appointments was turned off (no book_appointment tool),
 * but the system prompt still hardcoded "I can book appointments" and a stack of
 * booking guardrails, so the model told callers it could book and asked for a
 * day/time it could never fulfil. Tool-gating already worked; the PROMPT leaked.
 */

import { describe, it, expect } from "vitest";
import {
  buildStaticSystemPrefix,
  buildDynamicTail,
  buildCallTools,
  buildIntegrationTools,
} from "../services/gemini.js";
import { loadConfig } from "../services/supabase.js";

/** Build a business config with a set of capability rows. */
function configWith(rows, allowedTasks = ["book_appointment", "check_appointment", "cancel_reschedule", "quote_request"]) {
  return loadConfig({
    id: "b1",
    name: "Testwork Dental",
    allowed_tasks: allowedTasks,
    business_capabilities: rows,
  });
}

const cap = (id, enabled, adapter = null) => ({
  capability_id: id,
  enabled,
  adapter,
  adapter_config: {},
  config: {},
});

const toolNames = (t) => (t.functionDeclarations || []).map((d) => d.name);
const promptOf = (config) =>
  buildStaticSystemPrefix(config, { knowledge: [], integrations: [], transferAllowed: true }) +
  "\n\n" +
  buildDynamicTail("in_call", null, config, {});

describe("appointments disabled — prompt stops advertising booking", () => {
  const config = configWith([cap("appointments", false, "internal")]);

  it("strips the booking tool", () => {
    expect(toolNames(buildCallTools(config))).not.toContain("book_appointment");
  });

  it("does not claim it can book in the identity line", () => {
    expect(promptOf(config)).not.toContain("I can book appointments");
  });

  it("drops the booking tool-contract and scheduling instructions", () => {
    const p = promptOf(config);
    expect(p).not.toMatch(/before calling book_appointment/i);
    expect(p).not.toContain("When scheduling, always calculate");
  });

  it("tells the model to decline booking and offer an alternative", () => {
    expect(promptOf(config)).toContain(
      "You cannot book, check, cancel, or reschedule appointments for this business"
    );
  });

  it("suppresses EHR booking tools even with an athena integration", () => {
    const athena = [{ enabled: true, provider: "athenahealth", name: "athena", config: {} }];
    expect(toolNames(buildIntegrationTools(athena, config))).toHaveLength(0);
  });
});

describe("appointments enabled — booking is advertised, no decline", () => {
  const config = configWith([cap("appointments", true, "internal")]);

  it("keeps the booking tool and identity claim", () => {
    expect(toolNames(buildCallTools(config))).toContain("book_appointment");
    expect(promptOf(config)).toContain("I can book appointments");
  });

  it("emits no appointment decline line", () => {
    expect(promptOf(config)).not.toContain("You cannot book, check, cancel, or reschedule");
  });

  it("keeps EHR booking tools with an athena integration", () => {
    const athena = [{ enabled: true, provider: "athenahealth", name: "athena", config: {} }];
    expect(toolNames(buildIntegrationTools(athena, config)).length).toBeGreaterThan(0);
  });
});

describe("quotes decline mirrors appointments (tool-backed pack)", () => {
  it("declines quotes when disabled", () => {
    const config = configWith([cap("appointments", true, "internal"), cap("quotes", false)]);
    expect(promptOf(config)).toContain("You cannot give price quotes for this business");
  });

  it("does not decline quotes when enabled", () => {
    const config = configWith([cap("appointments", true, "internal"), cap("quotes", true)]);
    expect(promptOf(config)).not.toContain("You cannot give price quotes");
  });
});

