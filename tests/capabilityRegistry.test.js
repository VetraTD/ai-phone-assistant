import { readFileSync } from "node:fs";
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
import { collectStaticFragments, collectStepGuidance } from "../lib/capabilities/promptAssembler.js";
import { ACTION_TOOL_NAMES, buildCallTools } from "../services/gemini.js";
import { BUILTIN_TOOL_NAMES, CORE_TASKS } from "../services/supabase.js";

describe("capability registry — pack contract", () => {
  it("every pack declares an id, toolNames, and contributes something", () => {
    for (const pack of listPacks()) {
      expect(typeof pack.id, JSON.stringify(pack.id)).toBe("string");
      expect(pack.id.length).toBeGreaterThan(0);
      expect(Array.isArray(pack.toolNames), `${pack.id}.toolNames`).toBe(true);

      // A pack need not have tools — general_question, quotes, directions and
      // forms contribute only a CAPABILITIES clause, and a contract that
      // required tools would have been an appointment framework in disguise.
      // It must contribute SOMETHING, though: a pack that supplies neither
      // tools nor prompt text is registered for no reason.
      const contributes =
        typeof pack.tools === "function" ||
        typeof pack.adapterTools === "function" ||
        typeof pack.prompt === "function";
      expect(contributes, `${pack.id} contributes neither tools nor prompt text`).toBe(true);
    }
  });

  it("a pack with no tools declares no tool names", () => {
    for (const pack of listPacks()) {
      const hasToolFns =
        typeof pack.tools === "function" || typeof pack.adapterTools === "function";
      if (!hasToolFns) {
        expect(pack.toolNames, `${pack.id} declares names it cannot emit`).toEqual([]);
      }
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
  it("ACTION_TOOL_NAMES is derived from packs and still covers the legacy list", () => {
    // This list used to be hardcoded in services/gemini.js. Every name it held
    // must still be there — dropping one would silently stop that tool from
    // unlocking same-turn end_call, stranding the caller after a completed
    // action. Growing it is expected: that is a new capability being picked up
    // without an engine edit, which is the point.
    for (const name of [
      "book_appointment",
      "cancel_appointment_db",
      "reschedule_appointment_db",
      "record_customer_request",
    ]) {
      expect(ACTION_TOOL_NAMES, name).toContain(name);
    }
    expect(actionToolNames()).toEqual(ACTION_TOOL_NAMES);
  });

  it("the quotes capability was picked up without an engine edit", () => {
    // quotes was written after the engine was carved up, touching only
    // capabilities/. Its action tool reaching ACTION_TOOL_NAMES, and its tool
    // reaching the model, is the evidence the seam holds.
    expect(ACTION_TOOL_NAMES).toContain("record_quote_request");
    expect(packForTool("record_quote_request")?.id).toBe("quotes");
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
  it("every capability tool name is reserved against integration collisions", () => {
    // The reserved list used to be hand-maintained at four names while packs
    // declared twelve, so a business could create a webhook called
    // request_transfer or cancel_appointment_db and have it silently shadowed:
    // the declaration reached Gemini twice and services/tools.js dispatched the
    // builtin, so the operator's webhook never ran and never errored.
    //
    // Deriving the list from the registry is what makes this stay true as packs
    // are added — which is the whole reason to assert it here rather than
    // re-listing the names.
    const unreserved = allCapabilityToolNames().filter((n) => !BUILTIN_TOOL_NAMES.includes(n));
    expect(unreserved, `unreserved capability tools: ${unreserved.join(", ")}`).toEqual([]);
  });

  it("reserves the engine-owned tools too", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("set_call_intent");
    expect(BUILTIN_TOOL_NAMES).toContain("end_call");
  });

  it("the previously-unprotected names are now reserved", () => {
    // Regression lock on the specific collisions that were reachable.
    for (const name of ["request_transfer", "cancel_appointment_db", "get_caller_appointments"]) {
      expect(BUILTIN_TOOL_NAMES, name).toContain(name);
    }
  });

  it("the dashboard's mirrored list has not drifted from the registry", () => {
    // The dashboard is a separate CJS app that cannot import the ESM registry,
    // so it duplicates this list by hand — and it is a second write path to the
    // integrations table. A name rejected by the main app but accepted there
    // still produces the shadowing bug, so the copy is verified rather than
    // trusted. Read as text: importing a CJS Express route into this suite
    // would drag in the whole dashboard server.
    const source = readFileSync(
      new URL("../AI-phone-dashboard/backend/src/routes/settings.js", import.meta.url),
      "utf8"
    );
    const block = source.match(/const BUILTIN_TOOL_NAMES = \[([\s\S]*?)\];/);
    expect(block, "BUILTIN_TOOL_NAMES not found in the dashboard route").not.toBeNull();

    const mirrored = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const missing = BUILTIN_TOOL_NAMES.filter((n) => !mirrored.includes(n));

    expect(
      missing,
      `AI-phone-dashboard/backend/src/routes/settings.js is missing: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("the names BUILTIN_TOOL_NAMES does reserve are all real", () => {
    for (const name of BUILTIN_TOOL_NAMES) {
      const isEngineTool = name === "set_call_intent" || name === "end_call";
      const isPackTool = packForTool(name) !== null;
      expect(isEngineTool || isPackTool, `${name} is reserved but nothing owns it`).toBe(true);
    }
  });
});

describe("prompt assembler", () => {
  const config = {
    allowedTasks: [...CORE_TASKS, "book_appointment", "cancel_reschedule", "quote_request"],
    businessHours: null,
    timezone: "UTC",
  };

  it("capability clauses come from packs in registry order", () => {
    const { capabilities } = collectStaticFragments(config, {
      integrations: [],
      transferAllowed: true,
    });

    // appointments -> general_question(off) -> messages -> quotes -> transfer
    const apptIdx = capabilities.findIndex((c) => c.includes("appointments"));
    const msgIdx = capabilities.findIndex((c) => c.includes("take messages"));
    const quoteIdx = capabilities.findIndex((c) => c.includes("pricing/quotes"));
    const transferIdx = capabilities.findIndex((c) => c.includes("transfer the caller"));

    expect(apptIdx).toBeGreaterThanOrEqual(0);
    expect(apptIdx).toBeLessThan(msgIdx);
    expect(msgIdx).toBeLessThan(quoteIdx);
    expect(quoteIdx).toBeLessThan(transferIdx);
  });

  it("a disabled module contributes no clause", () => {
    const { capabilities } = collectStaticFragments(
      { ...config, allowedTasks: [...CORE_TASKS] },
      { integrations: [], transferAllowed: true }
    );
    expect(capabilities.join(" ")).not.toContain("appointments");
    expect(capabilities.join(" ")).not.toContain("pricing/quotes");
    // Core packs still contribute.
    expect(capabilities.join(" ")).toContain("take messages");
  });

  it("transferAllowed=false removes the transfer clause but not the tool", () => {
    // The receptionist must never promise a transfer the business cannot take,
    // yet the tool stays registered so a caller asking for a person in any
    // language still reaches a code path that can refuse gracefully.
    const { capabilities } = collectStaticFragments(config, {
      integrations: [],
      transferAllowed: false,
    });
    expect(capabilities.join(" ")).not.toContain("transfer the caller");
    expect(collectTools(config).map((d) => d.name)).toContain("request_transfer");
  });

  it("each intent has exactly one owning pack", () => {
    // collectStepGuidance throws on a collision. Two packs claiming an intent
    // would make the model's instructions depend on registry order, which is
    // invisible to whoever wrote the pack.
    expect(() => collectStepGuidance(config, { integrations: [], now: new Date() })).not.toThrow();

    const guidance = collectStepGuidance(config, { integrations: [], now: new Date() });
    expect(Object.keys(guidance).sort()).toEqual([
      "book_appointment",
      "callback_request",
      "cancel_reschedule",
      "quote_request",
      "take_message",
    ]);
  });

  it("EHR presence changes the cancel/reschedule flow", () => {
    const withEhr = collectStepGuidance(config, {
      integrations: [{ enabled: true, provider: "athenahealth" }],
      now: new Date(),
    });
    const withoutEhr = collectStepGuidance(config, { integrations: [], now: new Date() });

    expect(withEhr.cancel_reschedule).toContain("date of birth");
    expect(withoutEhr.cancel_reschedule).toContain("phone_last4");
    expect(withEhr.cancel_reschedule).not.toBe(withoutEhr.cancel_reschedule);
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
