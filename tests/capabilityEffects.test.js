/**
 * The shared capability-effect dispatcher.
 *
 * Both voice pipelines run this: lib/voice/session.js (v2, the default) and
 * lib/mediaStream.js (v1, reachable via PIPELINE_V2=false). It is shared
 * precisely because it was NOT before — the appointment side effects were
 * duplicated in both files, and migrating one while forgetting the other left
 * the rollback path silently not notifying owners about bookings and not
 * persisting messages at all.
 */

import { describe, it, expect, vi } from "vitest";
import {
  mergeCapabilityState,
  dispatchCapabilityEffects,
} from "../lib/capabilities/effects.js";

function makeEngine() {
  const log = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const captureException = vi.fn();
  return {
    engine: { STEPS: { CONFIRM: "confirm" }, deps: { log, captureException } },
    log,
    captureException,
  };
}

describe("mergeCapabilityState", () => {
  it("creates the container on first write", () => {
    const state = {};
    mergeCapabilityState(state, { appointments: { selectedAppointmentId: "a1" } });
    expect(state.capabilityState).toEqual({ appointments: { selectedAppointmentId: "a1" } });
  });

  it("merges within a capability rather than replacing it", () => {
    // Two tools from the same capability in one turn both contribute — a lookup
    // sets the selected appointment, then a cancel adds the verified identity.
    const state = { capabilityState: { appointments: { selectedAppointmentId: "a1" } } };
    mergeCapabilityState(state, { appointments: { identityVerifiedApptId: "a1" } });
    expect(state.capabilityState.appointments).toEqual({
      selectedAppointmentId: "a1",
      identityVerifiedApptId: "a1",
    });
  });

  it("keeps capabilities isolated from each other", () => {
    const state = { capabilityState: { appointments: { lastBooked: { x: 1 } } } };
    mergeCapabilityState(state, { quotes: { lastRequested: "water heater" } });
    expect(state.capabilityState.appointments).toEqual({ lastBooked: { x: 1 } });
    expect(state.capabilityState.quotes).toEqual({ lastRequested: "water heater" });
  });

  it("a null VALUE clears one key", () => {
    // How a cancel kills the booking anchor: "cancel that, actually put me back
    // in at the same time" must perform a real insert, not short-circuit to
    // "already booked".
    const state = {
      capabilityState: { appointments: { lastBooked: { x: 1 }, identityVerifiedApptId: "a1" } },
    };
    mergeCapabilityState(state, { appointments: { lastBooked: null } });
    expect(state.capabilityState.appointments.lastBooked).toBeNull();
    expect(state.capabilityState.appointments.identityVerifiedApptId).toBe("a1");
  });

  it("a null CAPABILITY drops the whole slot", () => {
    const state = { capabilityState: { appointments: { lastBooked: { x: 1 } } } };
    mergeCapabilityState(state, { appointments: null });
    expect(state.capabilityState.appointments).toBeUndefined();
  });

  it("tolerates missing state or patch", () => {
    expect(() => mergeCapabilityState(null, { a: {} })).not.toThrow();
    expect(() => mergeCapabilityState({}, null)).not.toThrow();
  });
});

describe("dispatchCapabilityEffects", () => {
  it("returns no notes for an empty or missing list", () => {
    const { engine } = makeEngine();
    expect(dispatchCapabilityEffects([], engine)).toEqual([]);
    expect(dispatchCapabilityEffects(undefined, engine)).toEqual([]);
    expect(dispatchCapabilityEffects(null, engine)).toEqual([]);
  });

  it("routes an effect to its owning pack and collects its note", () => {
    const { engine } = makeEngine();
    const notes = dispatchCapabilityEffects(
      [
        {
          capability: "quotes",
          type: "requested",
          data: { service_description: "water heater" },
        },
      ],
      {
        ...engine,
        setStep: vi.fn(),
        call: { businessId: "b1", callerNumber: "+15551234567", config: {} },
        deps: {
          ...engine.deps,
          db: { createCustomerRequest: vi.fn().mockResolvedValue(null) },
          notifications: { notifyCustomerRequest: vi.fn(), sendCallerSms: vi.fn() },
        },
      }
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("water heater");
  });

  it("collects notes from several effects in one turn", () => {
    const { engine } = makeEngine();
    const notes = dispatchCapabilityEffects(
      [
        { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db" } },
        { capability: "appointments", type: "changed", data: { tool: "reschedule_appointment_db" } },
      ],
      { ...engine, setStep: vi.fn(), call: { businessId: "b1" } }
    );
    expect(notes).toEqual([
      "cancel_appointment_db succeeded",
      "reschedule_appointment_db succeeded",
    ]);
  });

  it("warns rather than throwing on an effect nobody owns", () => {
    const { engine, log } = makeEngine();
    expect(() =>
      dispatchCapabilityEffects([{ capability: "no_such_pack", type: "x" }], engine)
    ).not.toThrow();
    // lib/logger.js has no warn level; the convention is error + severity.
    expect(log.error).toHaveBeenCalledWith(
      "capability_effect_unhandled",
      expect.objectContaining({ capability: "no_such_pack", severity: "warn" })
    );
  });

  it("one failing capability does not stop the others", async () => {
    // The caller is mid-call. A pack that throws must not cost the turn its
    // remaining effects — especially not a booking notification.
    const { log, captureException } = makeEngine();
    const boom = new Error("pack exploded");
    const engine = {
      STEPS: { CONFIRM: "confirm" },
      deps: { log, captureException },
      setStep: vi.fn(() => {
        if (engine.setStep.mock.calls.length === 1) throw boom;
      }),
      call: { businessId: "b1" },
    };

    const notes = dispatchCapabilityEffects(
      [
        { capability: "appointments", type: "changed", data: { tool: "cancel_appointment_db" } },
        { capability: "appointments", type: "changed", data: { tool: "reschedule_appointment_db" } },
      ],
      engine
    );

    expect(log.error).toHaveBeenCalledWith(
      "capability_effect_failed",
      expect.objectContaining({ capability: "appointments" })
    );
    expect(captureException).toHaveBeenCalledWith(boom);
    // The second effect still ran.
    expect(notes).toEqual(["reschedule_appointment_db succeeded"]);
  });
});
