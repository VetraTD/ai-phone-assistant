/**
 * KNOWN CALLER FACTS (plan step 2.2).
 *
 * Facts the call has already established — the caller's confirmed name, a
 * booking made this call — are surfaced to the model every turn via the DYNAMIC
 * tail, so it stops re-asking and stops contradicting completed actions.
 *
 * The mechanism is a convention: any pack may write a flat string->string map
 * under `capabilityState.<packId>.callerFacts`. `collectCallerFacts` gathers
 * them in registry order, and buildDynamicTail renders them — but ONLY when
 * there is at least one fact, so every existing (fact-free) tail snapshot stays
 * byte-identical.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collectCallerFacts } from "../lib/capabilities/promptAssembler.js";
import { buildDynamicTail } from "../services/gemini.js";
import appointments from "../capabilities/appointments.js";
import { loadConfig } from "../services/supabase.js";

describe("collectCallerFacts", () => {
  it("returns [] for empty / missing / malformed state", () => {
    expect(collectCallerFacts({})).toEqual([]);
    expect(collectCallerFacts(undefined)).toEqual([]);
    expect(collectCallerFacts(null)).toEqual([]);
    // A pack with state but no callerFacts contributes nothing.
    expect(collectCallerFacts({ appointments: { lastBooked: { x: 1 } } })).toEqual([]);
    // callerFacts present but not an object is ignored, not thrown on.
    expect(collectCallerFacts({ appointments: { callerFacts: "nope" } })).toEqual([]);
  });

  it("emits facts in registry order, then key-insertion order within a pack", () => {
    // quotes comes AFTER appointments in the registry (capabilities/index.js),
    // so appointments' facts must sort first regardless of object key order.
    const state = {
      quotes: { callerFacts: { Quote: "$200 for a water heater" } },
      appointments: { callerFacts: { Name: "Marcus", "Booked this call": "Tue 10 AM" } },
    };
    const facts = collectCallerFacts(state);
    expect(facts.map((f) => f.packId)).toEqual(["appointments", "appointments", "quotes"]);
    expect(facts.map((f) => f.label)).toEqual(["Name", "Booked this call", "Quote"]);
    expect(facts.map((f) => f.value)).toEqual(["Marcus", "Tue 10 AM", "$200 for a water heater"]);
  });

  it("skips non-string values defensively, keeping string ones", () => {
    const state = {
      appointments: {
        callerFacts: { Name: "Marcus", Count: 3, Meta: { a: 1 }, Nil: null, Ok: "yes" },
      },
    };
    const facts = collectCallerFacts(state);
    expect(facts.map((f) => f.label)).toEqual(["Name", "Ok"]);
    expect(facts.map((f) => f.value)).toEqual(["Marcus", "yes"]);
  });
});

describe("buildDynamicTail — KNOWN CALLER FACTS section", () => {
  const config = {
    businessName: "Acme Dental",
    timezone: "America/Chicago",
    businessHours: { open_time: "09:00", close_time: "17:00" },
    allowedTasks: ["book_appointment", "general_question", "take_message"],
    afterHoursPolicy: "take_message",
    mainPhone: "555-1234",
  };
  const extras = { integrations: [] };

  it("renders the header and one '- Label: value' line per fact, after CURRENT TASK AND STATE", () => {
    const tail = buildDynamicTail("confirm", "book_appointment", config, {
      ...extras,
      capabilityState: {
        appointments: {
          callerFacts: {
            Name: "Priya Nair",
            "Booked this call": "Thu Jul 30, 2:00 PM (checkup)",
          },
        },
      },
    });

    expect(tail).toContain(
      "=== KNOWN CALLER FACTS (already established this call — do not re-ask) ==="
    );
    expect(tail).toContain("- Name: Priya Nair");
    expect(tail).toContain("- Booked this call: Thu Jul 30, 2:00 PM (checkup)");

    // The section must come AFTER the current-task section, so per-turn state
    // reads as the most recent context the model sees.
    expect(tail.indexOf("=== KNOWN CALLER FACTS")).toBeGreaterThan(
      tail.indexOf("=== CURRENT TASK AND STATE ===")
    );
  });

  it("emits NOTHING when there are zero facts — the empty-case snapshot contract", () => {
    // No capabilityState at all.
    expect(buildDynamicTail("confirm", "book_appointment", config, extras)).not.toContain(
      "KNOWN CALLER FACTS"
    );
    // capabilityState present but fact-free.
    const tail = buildDynamicTail("confirm", "book_appointment", config, {
      ...extras,
      capabilityState: { appointments: { lastBooked: { scheduled_at: "x" } } },
    });
    expect(tail).not.toContain("KNOWN CALLER FACTS");
  });
});

describe("appointments producer — a successful booking writes caller facts", () => {
  const WEEKLY = {
    mon: { open: "09:00", close: "17:00", closed: false },
    tue: { open: "09:00", close: "17:00", closed: false },
    wed: { open: "09:00", close: "17:00", closed: false },
    thu: { open: "09:00", close: "17:00", closed: false },
    fri: { open: "09:00", close: "17:00", closed: false },
    sat: { open: null, close: null, closed: true },
    sun: { open: null, close: null, closed: true },
  };
  // Tue 2026-07-21 10:00 America/Chicago (CDT, UTC-5) -> 15:00Z, future vs the
  // frozen Monday "now".
  const REQUESTED = "2026-07-21T10:00:00";

  function makeConfig() {
    return loadConfig({
      id: "b1",
      name: "Testwork Dental",
      timezone: "America/Chicago",
      business_hours: WEEKLY,
      allowed_tasks: ["book_appointment", "check_appointment", "cancel_reschedule"],
      business_capabilities: [
        { capability_id: "appointments", enabled: true, adapter: "internal", adapter_config: {}, config: {} },
      ],
    });
  }

  function makeDeps() {
    return {
      countScheduledOverlapping: vi.fn().mockResolvedValue(0),
      listScheduledBetween: vi.fn().mockResolvedValue([]),
      createAppointmentIfAvailable: vi.fn().mockResolvedValue({ id: "appt-1" }),
      createAppointment: vi.fn().mockResolvedValue("appt-1"),
      captureException: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T15:00:00Z")); // Monday
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes Name + a human-readable 'Booked this call' (local time + service), merged with lastBooked", async () => {
    const res = await appointments.execute(
      { id: "1", name: "book_appointment", args: { scheduled_at: REQUESTED, client_name: "Jane", service_type: "consultation" } },
      {
        businessId: "b1",
        config: makeConfig(),
        integrations: [],
        callerPhone: "+15551234567",
        capabilityState: {},
        deps: makeDeps(),
      }
    );

    expect(res.functionResponse.response.success).toBe(true);
    const apptState = res.stateEffects.capabilityState.appointments;
    // The booking anchor is untouched...
    expect(apptState.lastBooked).toBeTruthy();
    // ...and the caller facts sit beside it.
    const facts = apptState.callerFacts;
    expect(facts.Name).toBe("Jane");
    // 15:00Z rendered in America/Chicago is 10:00 AM, with the service appended.
    expect(facts["Booked this call"]).toMatch(/10:00.?AM/);
    expect(facts["Booked this call"]).toContain("(consultation)");

    // Those facts flow straight into the tail on the next turn.
    const tail = buildDynamicTail("confirm", "book_appointment", makeConfig(), {
      integrations: [],
      capabilityState: res.stateEffects.capabilityState,
    });
    expect(tail).toContain("- Name: Jane");
  });

  it("omits the Name fact when the caller gave no name", async () => {
    const res = await appointments.execute(
      { id: "1", name: "book_appointment", args: { scheduled_at: REQUESTED } },
      {
        businessId: "b1",
        config: makeConfig(),
        integrations: [],
        callerPhone: "+15551234567",
        capabilityState: {},
        deps: makeDeps(),
      }
    );
    expect(res.functionResponse.response.success).toBe(true);
    const facts = res.stateEffects.capabilityState.appointments.callerFacts;
    expect(facts.Name).toBeUndefined();
    expect(facts["Booked this call"]).toBeTruthy();
  });
});
