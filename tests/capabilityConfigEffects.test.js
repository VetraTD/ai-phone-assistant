/**
 * THE GUARANTEE: every knob a business can configure actually does something on
 * a call.
 *
 * This test exists because config repeatedly shipped ahead of wiring — a
 * checkbox in the dashboard that the engine never read (built-in identity,
 * notes, the quotes webhook adapter). Two layers stop that recurring:
 *
 *   1. COVERAGE TRIPWIRE — every `configSchema` leaf must be registered in
 *      WIRED_KEYS. Add a knob to a schema without registering it → this fails,
 *      forcing you to wire it.
 *   2. EFFECT ASSERTIONS — each registered knob must produce an observable
 *      effect (a tool parameter, a prompt line, a refusal, an adapter call).
 *
 * If you add a capability setting, you add it in both places — which means you
 * cannot add a setting that does nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listPacks } from "../capabilities/index.js";
import appointments from "../capabilities/appointments.js";
import { buildCallTools, buildIntegrationTools, buildSystemInstruction } from "../services/gemini.js";
import { loadConfig } from "../services/supabase.js";
import { checkRequirements, CONFIRMATION_ARG } from "../lib/capabilities/requirements.js";
import { resolveSchedulingAdapter } from "../adapters/scheduling/index.js";

// Every configSchema leaf (a node with a `type`) that the engine actually reads,
// per capability. Keep sorted. A mismatch here is the tripwire.
const WIRED_KEYS = {
  appointments: [
    "adapter",
    "availability.capacity",
    "availability.length",
    "notes",
    "require.businessHoursOnly",
    "require.confirmBeforeWrite",
    "require.identity",
  ],
  quotes: ["notes", "require.identity"],
  messages: ["notes", "require.identity"],
};

/** Dot-paths of every schema node that declares a `type`. */
function schemaLeaves(schema, prefix = "") {
  const out = [];
  for (const [key, node] of Object.entries(schema || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (node && typeof node === "object" && typeof node.type === "string") out.push(path);
    else if (node && typeof node === "object") out.push(...schemaLeaves(node, path));
  }
  return out;
}

describe("COVERAGE TRIPWIRE — no configSchema knob may be unregistered", () => {
  for (const pack of listPacks()) {
    if (!pack.configSchema) continue;
    it(`${pack.id}: schema leaves exactly match WIRED_KEYS (wire + register any new knob)`, () => {
      expect(
        WIRED_KEYS[pack.id],
        `capability "${pack.id}" has a configSchema but no WIRED_KEYS entry — wire its knobs and register them here`
      ).toBeDefined();
      expect(schemaLeaves(pack.configSchema).sort()).toEqual([...WIRED_KEYS[pack.id]].sort());
    });
  }
});

// --- shared fixtures ---
const WEEKLY = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "17:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};
const FUTURE = "2026-07-21T10:00:00"; // Tue 10:00 Chicago, future relative to the frozen Monday

function apptConfig(apptCfg, { adapter = "internal", allowed = ["book_appointment", "check_appointment", "cancel_reschedule"] } = {}) {
  return loadConfig({
    id: "b1",
    name: "Testwork Dental",
    timezone: "America/Chicago",
    business_hours: WEEKLY,
    allowed_tasks: allowed,
    business_capabilities: [
      { capability_id: "appointments", enabled: true, adapter, adapter_config: {}, config: apptCfg },
    ],
  });
}
const promptOf = (config, extras = {}) =>
  buildSystemInstruction("gather_details", "book_appointment", config, { knowledge: [], integrations: [], transferAllowed: true, ...extras });
const bookTool = (config) => buildCallTools(config).functionDeclarations.find((d) => d.name === "book_appointment");

describe("appointments — every knob has an effect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T15:00:00Z")); // Mon 10:00 Chicago
  });
  afterEach(() => vi.useRealTimers());

  it("adapter → resolves the configured backend", () => {
    const internal = resolveSchedulingAdapter({ adapter: "internal" }, []);
    const athena = resolveSchedulingAdapter({ adapter: "athenahealth" }, []);
    expect(internal.id).toBe("internal");
    expect(athena.id).toBe("athenahealth");
  });

  it("require.identity (builtin dob) → tool param + prompt line + refusal", () => {
    const config = apptConfig({ require: { identity: { builtin: ["dob"] } } });
    expect(bookTool(config).parameters.required).toContain("identity_dob");
    expect(promptOf(config)).toMatch(/date of birth/i);
    const cfg = config.capabilities.appointments;
    expect(checkRequirements(cfg, { client_name: "X", scheduled_at: FUTURE }, { toolName: "book_appointment", callerPhone: "+1555", config }).ok).toBe(false);
    expect(checkRequirements(cfg, { identity_dob: "1990-01-01" }, { toolName: "book_appointment", callerPhone: "+1555", config }).ok).toBe(true);
  });

  it("require.confirmBeforeWrite → caller_confirmed param + refusal until true", () => {
    const config = apptConfig({ require: { confirmBeforeWrite: true } });
    expect(bookTool(config).parameters.required).toContain(CONFIRMATION_ARG);
    const cfg = config.capabilities.appointments;
    expect(checkRequirements(cfg, {}, { toolName: "book_appointment", config }).ok).toBe(false);
    expect(checkRequirements(cfg, { [CONFIRMATION_ARG]: true }, { toolName: "book_appointment", config }).ok).toBe(true);
  });

  it("require.businessHoursOnly → refuses at the tool AND steers the model to decline when closed", () => {
    const config = apptConfig({ require: { businessHoursOnly: true } });
    const cfg = config.capabilities.appointments;
    // Mon 10:00 Chicago = open → allowed, and normal booking guidance.
    expect(checkRequirements(cfg, {}, { toolName: "book_appointment", config }).ok).toBe(true);
    expect(appointments.prompt(config, { now: new Date("2026-07-20T15:00:00Z"), integrations: [] }).dynamic.stepGuidance.book_appointment)
      .not.toMatch(/office is closed right now/i);
    // Sunday (closed) → tool refuses AND the prompt tells the model to decline up front.
    const sun = new Date("2026-07-26T18:00:00Z");
    vi.setSystemTime(sun);
    expect(checkRequirements(cfg, {}, { toolName: "book_appointment", config }).ok).toBe(false);
    expect(appointments.prompt(config, { now: sun, integrations: [] }).dynamic.stepGuidance.book_appointment)
      .toMatch(/office is closed right now/i);
  });

  it("availability.length + capacity → reach the adapter's availability check", async () => {
    const config = apptConfig({ availability: { length: 45, capacity: 3 } });
    const deps = {
      countScheduledOverlapping: vi.fn().mockResolvedValue(2),
      listScheduledBetween: vi.fn().mockResolvedValue([]),
      captureException: vi.fn(),
    };
    const res = await appointments.execute(
      { id: "1", name: "check_appointment_availability", args: { requested_at: FUTURE } },
      { businessId: "b1", config, integrations: [], deps }
    );
    // length reached the overlap query…
    expect(deps.countScheduledOverlapping).toHaveBeenCalledWith("b1", expect.any(String), 45);
    // …and capacity 3 > 2 booked ⇒ still available (capacity had an effect).
    expect(res.functionResponse.response.available).toBe(true);
  });

  it("notes → appears in the prompt as guidance", () => {
    const config = apptConfig({ notes: "Ask about the world cup first." });
    expect(promptOf(config)).toContain("Ask about the world cup first.");
  });
});

describe("EHR write tools now carry + enforce requirements (bug fix)", () => {
  const athena = [{ enabled: true, provider: "athenahealth", name: "athena", config: {} }];
  const ehrConfig = (apptCfg) => apptConfig(apptCfg, { adapter: "athenahealth" });

  it("configured confirmBeforeWrite adds caller_confirmed to book_appointment_in_ehr", () => {
    const config = ehrConfig({ require: { confirmBeforeWrite: true } });
    const decls = buildIntegrationTools(athena, config).functionDeclarations;
    const book = decls.find((d) => d.name === "book_appointment_in_ehr");
    expect(book.parameters.required).toContain(CONFIRMATION_ARG);
  });

  it("unconfigured EHR clinic keeps byte-identical tools (no params added)", () => {
    const config = ehrConfig({});
    const decls = buildIntegrationTools(athena, config).functionDeclarations;
    const book = decls.find((d) => d.name === "book_appointment_in_ehr");
    expect(book.parameters.properties).not.toHaveProperty(CONFIRMATION_ARG);
  });

  it("EHR write tools are gated by checkRequirements (in actionTools)", () => {
    expect(appointments.actionTools).toEqual(
      expect.arrayContaining(["book_appointment_in_ehr", "cancel_appointment", "reschedule_appointment"])
    );
  });
});

describe("quotes & messages — identity + notes have effect", () => {
  function packConfig(id, cfg, task) {
    return loadConfig({
      id: "b1",
      name: "Co",
      allowed_tasks: task ? [task] : [],
      business_capabilities: [{ capability_id: id, enabled: true, adapter: null, adapter_config: {}, config: cfg }],
    });
  }
  const toolNamed = (config, name) => buildCallTools(config).functionDeclarations.find((d) => d.name === name);

  it("quotes require.identity → param on record_quote_request + refusal", () => {
    const config = packConfig("quotes", { require: { identity: { builtin: ["callback_number"] } } }, "quote_request");
    expect(toolNamed(config, "record_quote_request").parameters.required).toContain("callback_number");
    const cfg = config.capabilities.quotes;
    expect(checkRequirements(cfg, { service_description: "x" }, { toolName: "record_quote_request" }).ok).toBe(false);
  });

  it("quotes notes → appears in prompt", () => {
    const config = packConfig("quotes", { notes: "Never quote a price on the phone." }, "quote_request");
    const p = buildSystemInstruction("gather_details", "quote_request", config, { knowledge: [], integrations: [], transferAllowed: true });
    expect(p).toContain("Never quote a price on the phone.");
  });

  it("messages require.identity → param on record_customer_request + refusal", () => {
    const config = packConfig("messages", { require: { identity: { builtin: ["callback_number"] } } });
    expect(toolNamed(config, "record_customer_request").parameters.required).toContain("callback_number");
    const cfg = config.capabilities.messages;
    expect(checkRequirements(cfg, {}, { toolName: "record_customer_request" }).ok).toBe(false);
  });

  it("messages notes → appears in prompt", () => {
    const config = packConfig("messages", { notes: "Always ask which department." });
    const p = buildSystemInstruction("gather_details", "take_message", config, { knowledge: [], integrations: [], transferAllowed: true });
    expect(p).toContain("Always ask which department.");
  });
});
