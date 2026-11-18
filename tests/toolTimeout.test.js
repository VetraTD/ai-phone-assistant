import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeToolCallGuarded } from "../services/tools.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

// ---------------------------------------------------------------------------
// A tool that never returns must not take the caller with it.
//
// NOT the cause of the 2026-08-04 incident — that was the model writing its
// call as text. This is the neighbouring defect found while investigating it:
// nothing anywhere bounded a tool. services/gemini.js awaited executeToolCall
// bare, services/tools.js added no timeout, and the Supabase client was built
// with no AbortSignal, so a hung query hung forever. The only thing that ever
// ended such a turn was the LLM deadline — after which the tool kept running,
// so a reschedule could still land AFTER the caller was told it had failed.
// ---------------------------------------------------------------------------

const CONFIG = FIXTURES["appointments-db"].config;

/** Every dep the internal scheduling adapter reaches for, none of which ever returns. */
function hangingDeps() {
  const hang = () => new Promise(() => {});
  return {
    listAppointmentsByCaller: hang,
    listScheduledBetween: hang,
    createAppointmentIfAvailable: hang,
    updateAppointmentStatus: hang,
    updateAppointment: hang,
    countScheduledOverlapping: hang,
    getAppointmentById: hang,
  };
}

const ctx = (deps) => ({
  businessId: "biz-1",
  callerPhone: "+15558675309",
  config: CONFIG,
  integrations: [],
  capabilityState: {},
  step: "gather_details",
  depsOverride: deps,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("executeToolCallGuarded", () => {
  it("resolves with a failure instead of hanging when a tool never returns", async () => {
    const promise = executeToolCallGuarded(
      { id: "fc1", name: "get_caller_appointments_from_db", args: {} },
      ctx(hangingDeps()),
      { timeoutMs: 8000 }
    );

    await vi.advanceTimersByTimeAsync(8100);
    const { functionResponse, stateEffects } = await promise;

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.reason_code).toBe("TIMEOUT");
    expect(stateEffects.toolResult.success).toBe(false);
  });

  it("tells the caller nothing about why", async () => {
    // The failure text reaches the model, and from there the caller. It must
    // carry no tool name, no vendor, no duration, no mechanism.
    const promise = executeToolCallGuarded(
      { id: "fc1", name: "reschedule_appointment_db", args: { new_scheduled_at: "2026-08-06T14:00:00" } },
      ctx(hangingDeps()),
      { timeoutMs: 8000 }
    );
    await vi.advanceTimersByTimeAsync(8100);
    const { functionResponse, stateEffects } = await promise;

    // functionResponse.name is protocol — the SDK matches it to the call, and
    // the model never paraphrases it. What has to stay clean is everything it
    // WILL paraphrase: the response body and the message written for it.
    const surface = JSON.stringify(functionResponse.response) + stateEffects.toolResult.message;
    expect(surface).not.toMatch(/reschedule_appointment_db|supabase|postgres|8000|\bms\b|deadline/i);
  });

  it("marks a timed-out result as unsafe to read aloud", async () => {
    const promise = executeToolCallGuarded(
      { id: "fc1", name: "get_caller_appointments_from_db", args: {} },
      ctx(hangingDeps()),
      { timeoutMs: 8000 }
    );
    await vi.advanceTimersByTimeAsync(8100);
    const { stateEffects } = await promise;

    expect(stateEffects.toolResult.callerSafe).not.toBe(true);
  });

  it("turns a thrown tool into a failure rather than killing the turn", async () => {
    const boom = { listAppointmentsByCaller: () => { throw new Error("connection reset by peer"); } };
    const { functionResponse, stateEffects } = await executeToolCallGuarded(
      { id: "fc1", name: "get_caller_appointments_from_db", args: {} },
      ctx(boom),
      { timeoutMs: 8000 }
    );

    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.reason_code).toBe("UNAVAILABLE");
    // The vendor's own words never reach the model.
    expect(JSON.stringify(functionResponse) + JSON.stringify(stateEffects.toolResult)).not.toMatch(
      /connection reset|peer/i
    );
  });

  it("is transparent for a tool that answers normally", async () => {
    const { functionResponse } = await executeToolCallGuarded(
      { id: "fc1", name: "set_call_intent", args: { intent: "book_appointment" } },
      ctx({}),
      { timeoutMs: 8000 }
    );
    expect(functionResponse.response.success).toBe(true);
  });
});
