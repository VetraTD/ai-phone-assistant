import { describe, it, expect } from "vitest";
import {
  listPacks,
  getPack,
  packForTool,
  allCapabilityToolNames,
  collectTools,
  collectAdapterTools,
  actionToolNames,
} from "../capabilities/index.js";
import { ACTION_TOOL_NAMES, buildCallTools } from "../services/gemini.js";
import { BUILTIN_TOOL_NAMES, CORE_TASKS } from "../services/supabase.js";

describe("capability registry — pack contract", () => {
  it("every pack declares an id, toolNames, and at least one tool source", () => {
    for (const pack of listPacks()) {
      expect(typeof pack.id, JSON.stringify(pack.id)).toBe("string");
      expect(pack.id.length).toBeGreaterThan(0);
      expect(Array.isArray(pack.toolNames), `${pack.id}.toolNames`).toBe(true);
      const hasSource =
        typeof pack.tools === "function" || typeof pack.adapterTools === "function";
      expect(hasSource, `${pack.id} contributes no tools`).toBe(true);
    }
  });

  it("toolNames is the complete set a pack can emit", () => {
    // The registry resolves a tool name to its owning pack WITHOUT consulting
    // tenant config, so a name emitted by tools()/adapterTools() but missing
    // from toolNames would be undispatchable at execution time.
    const permissive = {
      allowedTasks: [...CORE_TASKS, "book_appointment", "check_appointment", "cancel_reschedule"],
    };
    for (const pack of listPacks()) {
      const emitted = [
        ...(pack.tools?.(permissive, { integrations: [] }) || []),
        ...(pack.adapterTools?.(permissive, { integrations: [] }) || []),
        ...(pack.ehrTools?.([{ enabled: true, provider: "athenahealth" }]) || []),
      ].map((d) => d.name);

      for (const name of emitted) {
        expect(pack.toolNames, `${pack.id} emits "${name}" but does not declare it`).toContain(name);
      }
    }
  });

  it("no two packs claim the same tool name", () => {
    // Enforced at module load in capabilities/index.js (it throws), so reaching
    // this assertion at all means the guard held. Asserted explicitly so the
    // invariant is documented where a pack author will look.
    const names = allCapabilityToolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("packForTool resolves every declared name, and nothing else", () => {
    for (const name of allCapabilityToolNames()) {
      expect(packForTool(name), name).not.toBeNull();
    }
    expect(packForTool("set_call_intent")).toBeNull(); // engine-owned, not a pack
    expect(packForTool("end_call")).toBeNull();
    expect(packForTool("no_such_tool")).toBeNull();
  });

  it("core packs register their tools regardless of configuration", () => {
    const empty = collectTools({ allowedTasks: [] }).map((d) => d.name);
    for (const pack of listPacks()) {
      if (!pack.core) continue;
      for (const name of pack.toolNames) {
        expect(empty, `core pack ${pack.id} must always register ${name}`).toContain(name);
      }
    }
  });

  it("non-core packs register nothing when their module is not allowed", () => {
    const names = collectTools({ allowedTasks: [...CORE_TASKS] }).map((d) => d.name);
    expect(names).not.toContain("book_appointment");
  });
});

describe("capability registry — engine wiring", () => {
  it("ACTION_TOOL_NAMES is derived from packs and still matches the legacy list", () => {
    // Regression lock for the Step A "no behavior change" rule: this list used
    // to be hardcoded in services/gemini.js. Order matters only for readability,
    // membership is what gates same-turn end_call.
    expect(ACTION_TOOL_NAMES).toEqual([
      "book_appointment",
      "cancel_appointment_db",
      "reschedule_appointment_db",
      "record_customer_request",
    ]);
    expect(actionToolNames()).toEqual(ACTION_TOOL_NAMES);
  });

  it("every action tool is a real, declared tool", () => {
    for (const name of actionToolNames()) {
      expect(packForTool(name), `${name} is marked isAction but no pack owns it`).not.toBeNull();
    }
  });

  it("request_transfer is NOT an action tool", () => {
    // A transfer hands the call off rather than completing a task inside it,
    // so it must not unlock same-turn end_call and hang up on the handoff.
    expect(actionToolNames()).not.toContain("request_transfer");
  });

  it("engine tools come first and are never pack-owned", () => {
    const names = buildCallTools([...CORE_TASKS, "book_appointment"]).functionDeclarations.map(
      (d) => d.name
    );
    expect(names[0]).toBe("set_call_intent");
    expect(names[1]).toBe("end_call");
  });

  it("adapter tools are suppressed when an EHR owns the appointment book", () => {
    // Two systems of record for one appointment is a data-integrity bug, not a
    // preference — the model must not be able to write to both.
    const config = { allowedTasks: [...CORE_TASKS, "cancel_reschedule"] };
    const withEhr = collectAdapterTools(config, {
      integrations: [{ enabled: true, provider: "athenahealth" }],
    });
    const withoutEhr = collectAdapterTools(config, { integrations: [] });

    expect(withEhr).toHaveLength(0);
    expect(withoutEhr.map((d) => d.name)).toContain("cancel_appointment_db");
  });
});

describe("capability registry — reserved tool names", () => {
  it("KNOWN GAP: BUILTIN_TOOL_NAMES does not reserve every capability tool name", () => {
    // services/supabase.js createOrUpdateIntegration rejects a webhook whose
    // name collides with a builtin, but the reserved list was hand-maintained
    // and never grew past the original four. A business can therefore create a
    // webhook named request_transfer, cancel_appointment_db or
    // get_caller_appointments and have it silently shadowed: the declaration
    // reaches Gemini twice, and services/tools.js dispatches the builtin, so
    // the operator's webhook never runs and never errors.
    //
    // tests/gemini-integrations.test.js:19 uses "get_caller_appointments" as a
    // webhook name, which is exactly the collision, so this is reachable today.
    //
    // NOT fixed in Step A: widening the list rejects integration names that are
    // currently accepted, which is a behavior change. Step B makes the registry
    // the single source of reserved names — at which point this test flips to
    // asserting full coverage.
    const unreserved = allCapabilityToolNames().filter((n) => !BUILTIN_TOOL_NAMES.includes(n));

    expect(unreserved.length).toBeGreaterThan(0);
    expect(unreserved).toContain("request_transfer");
    expect(unreserved).toContain("cancel_appointment_db");
    expect(unreserved).toContain("get_caller_appointments");
  });

  it("the names BUILTIN_TOOL_NAMES does reserve are all real", () => {
    for (const name of BUILTIN_TOOL_NAMES) {
      const isEngineTool = name === "set_call_intent" || name === "end_call";
      const isPackTool = packForTool(name) !== null;
      expect(isEngineTool || isPackTool, `${name} is reserved but nothing owns it`).toBe(true);
    }
  });
});

describe("capability registry — pack lookup", () => {
  it("getPack returns registered packs and null otherwise", () => {
    expect(getPack("appointments")?.id).toBe("appointments");
    expect(getPack("messages")?.core).toBe(true);
    expect(getPack("transfer")?.core).toBe(true);
    expect(getPack("nope")).toBeNull();
  });
});
