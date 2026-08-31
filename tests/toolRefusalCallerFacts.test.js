/**
 * A refused write must not cost us the caller's name.
 *
 * checkRequirements fails CLOSED and one reason at a time — the receptionist
 * should ask for the missing thing rather than recite a list. The cost of that
 * design was invisible: the refusal returned only a message, so `fc.args` (and
 * with it a name the caller had already said out loud) was discarded. The
 * model then had nothing but raw chat history to remember it by, and on a long
 * call it re-asked — which is the documented nine-consecutive-turn spelling
 * livelock, and the "looped asking the caller to spell a name it already had"
 * report from the quotes flow.
 *
 * KNOWN CALLER FACTS is the block that stops re-asking. Before this, only a
 * COMPLETED booking ever wrote to it.
 */

import { describe, it, expect } from "vitest";
import { executeToolCall } from "../services/tools.js";
import { loadConfig } from "../services/db.js";

const WEEKLY = {
  monday: { open: "09:00", close: "17:00" },
  tuesday: { open: "09:00", close: "17:00" },
  wednesday: { open: "09:00", close: "17:00" },
  thursday: { open: "09:00", close: "17:00" },
  friday: { open: "09:00", close: "17:00" },
};

/** A business that demands a date of birth, so every booking below is refused. */
function configRequiringDob() {
  return loadConfig({
    id: "b1",
    name: "Testwork Dental",
    timezone: "America/Chicago",
    business_hours: WEEKLY,
    allowed_tasks: ["book_appointment"],
    business_capabilities: [
      {
        capability_id: "appointments",
        enabled: true,
        adapter: "internal",
        adapter_config: {},
        config: { require: { identity: { builtin: ["dob"] } } },
      },
    ],
  });
}

const bookCall = (args) => ({ id: "call-1", name: "book_appointment", args });

describe("a refused write keeps the caller's name", () => {
  it("records the name from a booking refused for a DIFFERENT missing field", async () => {
    const config = configRequiringDob();
    const result = await executeToolCall(
      bookCall({ client_name: "Marcus Bell", scheduled_at: "2099-01-05T10:00:00" }),
      { config, capabilityState: {}, callerPhone: "+15551234567", spellingAlreadyAsked: true },
    );

    // The refusal itself must be unchanged.
    expect(result.functionResponse.response.success).toBe(false);
    expect(result.functionResponse.response.message).toMatch(/date of birth|dob/i);

    // ...but the name survives into the block the model re-reads every turn.
    expect(result.stateEffects.capabilityState.appointments.callerFacts.Name).toBe("Marcus Bell");
  });

  it("does not overwrite a name the pack already recorded", async () => {
    const config = configRequiringDob();
    const result = await executeToolCall(
      bookCall({ client_name: "Mis Heard", scheduled_at: "2099-01-05T10:00:00" }),
      {
        config,
        capabilityState: { appointments: { callerFacts: { Name: "Marcus Bell" } } },
        callerPhone: "+15551234567", spellingAlreadyAsked: true,
      },
    );

    // A later, worse transcription must not clobber the established name —
    // the first one was read back to the caller and survived that check.
    expect(result.stateEffects.capabilityState).toBeUndefined();
  });

  it("writes nothing when the model supplied no name at all", async () => {
    const config = configRequiringDob();
    const result = await executeToolCall(bookCall({ scheduled_at: "2099-01-05T10:00:00" }), {
      config,
      capabilityState: {},
      callerPhone: "+15551234567", spellingAlreadyAsked: true,
    });

    expect(result.functionResponse.response.success).toBe(false);
    // An absent name must not render as the string "null" in the prompt.
    expect(result.stateEffects.capabilityState).toBeUndefined();
  });

  it("bridges the other parameter spelling (caller_name) too", async () => {
    // The message/quote/EHR tools call it caller_name, not client_name.
    const config = loadConfig({
      id: "b2",
      name: "Testwork Dental",
      timezone: "America/Chicago",
      business_hours: WEEKLY,
      allowed_tasks: ["take_message"],
      business_capabilities: [
        {
          capability_id: "messages",
          enabled: true,
          config: { require: { identity: { builtin: ["callback_number"] } } },
        },
      ],
    });

    const result = await executeToolCall(
      { id: "call-2", name: "record_customer_request", args: { request_type: "message", caller_name: "Ilija Eftimov" } },
      { config, capabilityState: {}, callerPhone: "+15551234567", spellingAlreadyAsked: true },
    );

    expect(result.functionResponse.response.success).toBe(false);
    expect(result.stateEffects.capabilityState.messages.callerFacts.Name).toBe("Ilija Eftimov");
  });
});

// ---------------------------------------------------------------------------
// ...including the spelling refusal itself, added 2026-08-29.
//
// The gate that exists to get the name RIGHT is now the FIRST refusal a new
// caller's booking hits, and a refusal discards fc.args. Without this it would
// be the single biggest cause of the re-asking loop the rest of this file
// guards against: refuse for spelling, lose the name, ask for the name again,
// refuse for spelling again.
// ---------------------------------------------------------------------------
describe("the spelling refusal keeps the name too", () => {
  it("records the name it is asking the caller to spell", async () => {
    const config = configRequiringDob();
    const result = await executeToolCall(
      bookCall({ client_name: "Marcus Bell", scheduled_at: "2099-01-05T10:00:00" }),
      { config, capabilityState: {}, callerPhone: "+15551234567", spellingAlreadyAsked: false },
    );

    expect(result.functionResponse.response.success).toBe(false);
    expect(result.functionResponse.response.message).toMatch(/spell/i);
    expect(result.stateEffects.capabilityState.appointments.callerFacts.Name).toBe("Marcus Bell");
  });

  it("does not clobber a name the pack already established", async () => {
    const config = configRequiringDob();
    const result = await executeToolCall(
      bookCall({ client_name: "Mis Heard", scheduled_at: "2099-01-05T10:00:00" }),
      {
        config,
        capabilityState: { appointments: { callerFacts: { Name: "Marcus Bell" } } },
        callerPhone: "+15551234567",
        spellingAlreadyAsked: false,
      },
    );
    // The refusal DOES emit capabilityState now - it records that the gate has
    // spent its one refusal, which is the phrasing-independent livelock
    // backstop. What it must not do is overwrite the established name with a
    // later, worse transcription.
    expect(result.stateEffects.capabilityState.appointments.spellingRefused).toBe(true);
    expect(result.stateEffects.capabilityState.appointments.callerFacts).toBeUndefined();
  });
});
