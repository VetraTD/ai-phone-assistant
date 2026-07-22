import { describe, it, expect } from "vitest";
import { normalizeAllowedTasks, CORE_TASKS, MODULE_TASKS } from "../services/supabase.js";
import { buildCallTools, buildDbAppointmentTools } from "../services/gemini.js";

// ---------------------------------------------------------------------------
// taskModel.test.js — CORE (always-on) + MODULES (opt-in) task model.
//
// CORE_TASKS = general_question, take_message, callback_request, transfer_human
// MODULE_TASKS = book_appointment, check_appointment, cancel_reschedule,
//                quote_request, directions_location, form_document_request
// ---------------------------------------------------------------------------

describe("services/supabase.js — normalizeAllowedTasks", () => {
  it("default (null raw) returns CORE + book_appointment", () => {
    const result = normalizeAllowedTasks(null);
    expect(result).toEqual(expect.arrayContaining([...CORE_TASKS, "book_appointment"]));
    expect(result).toHaveLength(CORE_TASKS.length + 1);
  });

  it("UNSET (null/undefined) returns CORE + the default module", () => {
    // Never configured -> a sensible default.
    for (const raw of [null, undefined]) {
      const result = normalizeAllowedTasks(raw);
      expect(result).toEqual(expect.arrayContaining([...CORE_TASKS, "book_appointment"]));
      expect(result).toHaveLength(CORE_TASKS.length + 1);
    }
  });

  it("an EMPTY ARRAY returns CORE only — explicitly no modules", () => {
    // Empty and unset used to be indistinguishable, both defaulting to
    // ["book_appointment"], so there was no way to express a business that does
    // not do appointments. Every non-appointment business — a plumber, a law
    // firm — was literally unrepresentable.
    const result = normalizeAllowedTasks([]);
    expect(result).toEqual([...CORE_TASKS]);
    expect(result).not.toContain("book_appointment");
  });

  it("expands legacy 'appointments' bundle into the three appointment modules", () => {
    const result = normalizeAllowedTasks(["appointments"]);
    expect(result).toEqual(
      expect.arrayContaining([...CORE_TASKS, "book_appointment", "check_appointment", "cancel_reschedule"])
    );
    expect(result).toHaveLength(CORE_TASKS.length + 3);
  });

  it("always injects CORE_TASKS even if the DB row only lists modules", () => {
    const result = normalizeAllowedTasks(["quote_request"]);
    for (const core of CORE_TASKS) {
      expect(result).toContain(core);
    }
    expect(result).toContain("quote_request");
  });

  it("drops legacy core entries (general_question/take_message/callback_request) silently — no duplicates", () => {
    const result = normalizeAllowedTasks(["general_question", "take_message", "callback_request", "book_appointment"]);
    // CORE_TASKS appear exactly once each (from the unconditional injection,
    // not from the raw legacy entries getting kept as extra module dupes).
    for (const core of CORE_TASKS) {
      expect(result.filter((t) => t === core)).toHaveLength(1);
    }
    expect(result).toContain("book_appointment");
    expect(result).toHaveLength(CORE_TASKS.length + 1);
  });

  it("drops unknown/unrecognized entries", () => {
    const result = normalizeAllowedTasks(["not_a_real_task", "book_appointment"]);
    expect(result).not.toContain("not_a_real_task");
    expect(result).toContain("book_appointment");
  });

  it("dedupes repeated module entries", () => {
    const result = normalizeAllowedTasks(["book_appointment", "book_appointment", "quote_request"]);
    expect(result.filter((t) => t === "book_appointment")).toHaveLength(1);
    expect(result.filter((t) => t === "quote_request")).toHaveLength(1);
  });

  it("MODULE_TASKS and CORE_TASKS are disjoint", () => {
    for (const t of MODULE_TASKS) {
      expect(CORE_TASKS).not.toContain(t);
    }
  });
});

describe("services/gemini.js — buildCallTools registration matrix", () => {
  function names(allowedTasks) {
    return buildCallTools(allowedTasks).functionDeclarations.map((d) => d.name);
  }

  it("set_call_intent and end_call are always registered", () => {
    expect(names([])).toEqual(expect.arrayContaining(["set_call_intent", "end_call"]));
    expect(names(["book_appointment"])).toEqual(expect.arrayContaining(["set_call_intent", "end_call"]));
  });

  it("record_customer_request is always registered, regardless of allowedTasks content", () => {
    expect(names([])).toContain("record_customer_request");
    expect(names(["book_appointment"])).toContain("record_customer_request");
    expect(names([...CORE_TASKS, "book_appointment"])).toContain("record_customer_request");
  });

  it("request_transfer is always registered, regardless of allowedTasks content", () => {
    expect(names([])).toContain("request_transfer");
    expect(names(["book_appointment"])).toContain("request_transfer");
  });

  it("request_transfer declaration requires a reason argument", () => {
    const decl = buildCallTools([]).functionDeclarations.find((d) => d.name === "request_transfer");
    expect(decl.parameters.required).toEqual(["reason"]);
    expect(decl.parameters.properties.reason).toBeDefined();
  });

  it("book_appointment is module-gated: absent when not in allowedTasks", () => {
    expect(names(["general_question"])).not.toContain("book_appointment");
  });

  it("book_appointment is module-gated: present when in allowedTasks", () => {
    expect(names(["book_appointment"])).toContain("book_appointment");
  });

  it("full CORE+MODULES allowedTasks registers book_appointment plus the always-on tools", () => {
    const result = names([...CORE_TASKS, "book_appointment"]);
    expect(result).toEqual(
      expect.arrayContaining(["set_call_intent", "end_call", "book_appointment", "record_customer_request", "request_transfer"])
    );
  });
});

describe("services/gemini.js — buildDbAppointmentTools (cancel/reschedule identity-guard name fallback)", () => {
  it("registers cancel_appointment_db/reschedule_appointment_db when cancel_reschedule is allowed and there's no EHR", () => {
    const config = { allowedTasks: [...CORE_TASKS, "cancel_reschedule"] };
    const { functionDeclarations } = buildDbAppointmentTools(config, { integrations: [] });
    const names = functionDeclarations.map((d) => d.name);
    expect(names).toContain("cancel_appointment_db");
    expect(names).toContain("reschedule_appointment_db");
  });

  it("registers when check_appointment is allowed (not just cancel_reschedule)", () => {
    const config = { allowedTasks: [...CORE_TASKS, "check_appointment"] };
    const { functionDeclarations } = buildDbAppointmentTools(config, { integrations: [] });
    expect(functionDeclarations.map((d) => d.name)).toContain("cancel_appointment_db");
  });

  it("does not register when no appointment module is allowed", () => {
    const config = { allowedTasks: [...CORE_TASKS] };
    const { functionDeclarations } = buildDbAppointmentTools(config, { integrations: [] });
    expect(functionDeclarations).toHaveLength(0);
  });

  it("does not register when an enabled athenahealth (EHR) integration is present", () => {
    const config = { allowedTasks: [...CORE_TASKS, "cancel_reschedule"] };
    const { functionDeclarations } = buildDbAppointmentTools(config, {
      integrations: [{ provider: "athenahealth", enabled: true }],
    });
    expect(functionDeclarations).toHaveLength(0);
  });

  it("cancel_appointment_db and reschedule_appointment_db both expose an optional client_name param (activates the identity guard's name fallback)", () => {
    const config = { allowedTasks: [...CORE_TASKS, "cancel_reschedule"] };
    const { functionDeclarations } = buildDbAppointmentTools(config, { integrations: [] });

    const cancelDecl = functionDeclarations.find((d) => d.name === "cancel_appointment_db");
    expect(cancelDecl.parameters.properties.client_name).toBeDefined();
    expect(cancelDecl.parameters.properties.client_name.type).toBe("string");
    expect(cancelDecl.parameters.required).not.toContain("client_name"); // optional

    const rescheduleDecl = functionDeclarations.find((d) => d.name === "reschedule_appointment_db");
    expect(rescheduleDecl.parameters.properties.client_name).toBeDefined();
    expect(rescheduleDecl.parameters.properties.client_name.type).toBe("string");
    expect(rescheduleDecl.parameters.required).not.toContain("client_name"); // optional
  });
});
