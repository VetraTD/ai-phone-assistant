/**
 * Unit tests for the eval suite's hard-assertion helpers (eval/asserts.js).
 *
 * These are the ONLY part of the eval suite that is pure and deterministic —
 * everything else (simCaller, judge, run) is API-bound and exercised live via
 * `npm run eval`, not here. Each helper is tested against a synthetic ctx in
 * both its passing and failing shape, because a measurement instrument whose
 * own assertions are wrong reports noise as signal.
 */

import { describe, it, expect } from "vitest";
import {
  collectToolCalls,
  toolCalled,
  toolNotCalled,
  toolCalledTimes,
  toolCalledAtMost,
  toolCalledWith,
  toolNotCalledWith,
  toolOrder,
  toolBefore,
  toolSucceeded,
  replySomewhereMatches,
  replyNeverMatches,
  turnsAtMost,
  toolNotCalledBeforeTurn,
} from "../eval/asserts.js";

/** A ctx as the runner assembles it: flat tool-call/result traces + per-turn view. */
function makeCtx() {
  return {
    toolCalls: [
      { name: "set_call_intent", args: { intent: "book_appointment" } },
      { name: "check_appointment_availability", args: { requested_at: "2026-07-28T15:00:00" } },
      { name: "book_appointment", args: { scheduled_at: "2026-07-28T16:00:00", client_name: "Jordan Blake" } },
      { name: "end_call", args: {} },
    ],
    toolResults: [
      { name: "check_appointment_availability", success: true, message: "taken" },
      { name: "book_appointment", success: true, message: "booked" },
    ],
    turns: [
      { caller: "book me in", reply: "One moment while I check that.", toolCalls: [{ name: "check_appointment_availability", args: {} }] },
      { caller: "yes", reply: "Booked for 4 PM, Jordan.", toolCalls: [{ name: "book_appointment", args: {} }] },
      { caller: "bye", reply: "Take care!", toolCalls: [{ name: "end_call", args: {} }] },
    ],
  };
}

describe("collectToolCalls", () => {
  it("returns the flat toolCalls array when present", () => {
    expect(collectToolCalls(makeCtx()).map((c) => c.name)).toEqual([
      "set_call_intent",
      "check_appointment_availability",
      "book_appointment",
      "end_call",
    ]);
  });

  it("falls back to flattening per-turn toolCalls when no aggregate is present", () => {
    const ctx = { turns: [{ toolCalls: [{ name: "a" }] }, { toolCalls: [{ name: "b" }, { name: "c" }] }] };
    expect(collectToolCalls(ctx).map((c) => c.name)).toEqual(["a", "b", "c"]);
  });
});

describe("toolCalled / toolNotCalled", () => {
  it("passes when a tool was called at least once", () => {
    expect(toolCalled(makeCtx(), "book_appointment").pass).toBe(true);
  });
  it("fails when a tool was never called", () => {
    expect(toolCalled(makeCtx(), "record_customer_request").pass).toBe(false);
  });
  it("toolNotCalled passes when absent, fails when present", () => {
    expect(toolNotCalled(makeCtx(), "record_customer_request").pass).toBe(true);
    expect(toolNotCalled(makeCtx(), "book_appointment").pass).toBe(false);
  });
});

describe("toolCalledTimes / toolCalledAtMost", () => {
  it("matches the exact count", () => {
    expect(toolCalledTimes(makeCtx(), "book_appointment", 1).pass).toBe(true);
    expect(toolCalledTimes(makeCtx(), "book_appointment", 2).pass).toBe(false);
    expect(toolCalledTimes(makeCtx(), "record_customer_request", 0).pass).toBe(true);
  });
  it("toolCalledAtMost passes at or below the ceiling", () => {
    expect(toolCalledAtMost(makeCtx(), "book_appointment", 1).pass).toBe(true);
    expect(toolCalledAtMost(makeCtx(), "book_appointment", 0).pass).toBe(false);
    expect(toolCalledAtMost(makeCtx(), "record_customer_request", 1).pass).toBe(true);
  });
});

describe("toolCalledWith / toolNotCalledWith", () => {
  const bookedAt = (args) => args.scheduled_at === "2026-07-28T16:00:00";
  const takenSlot = (args) => args.scheduled_at === "2026-07-28T15:00:00";

  it("toolCalledWith passes when some call matches the predicate", () => {
    expect(toolCalledWith(makeCtx(), "book_appointment", bookedAt).pass).toBe(true);
  });
  it("toolCalledWith fails when no call matches (or tool absent)", () => {
    expect(toolCalledWith(makeCtx(), "book_appointment", takenSlot).pass).toBe(false);
    expect(toolCalledWith(makeCtx(), "record_customer_request", () => true).pass).toBe(false);
  });
  it("toolNotCalledWith passes when no matching call, fails when one matches", () => {
    expect(toolNotCalledWith(makeCtx(), "book_appointment", takenSlot).pass).toBe(true);
    expect(toolNotCalledWith(makeCtx(), "book_appointment", bookedAt).pass).toBe(false);
  });
});

describe("toolOrder", () => {
  it("passes when the whole sequence appears in order", () => {
    expect(toolOrder(makeCtx(), ["check_appointment_availability", "book_appointment"]).pass).toBe(true);
  });
  it("fails when order is reversed", () => {
    expect(toolOrder(makeCtx(), ["book_appointment", "check_appointment_availability"]).pass).toBe(false);
  });
  it("fails when a required tool is missing entirely", () => {
    expect(toolOrder(makeCtx(), ["check_appointment_availability", "record_customer_request"]).pass).toBe(false);
  });
});

describe("toolBefore", () => {
  it("passes when every b is preceded by an a", () => {
    expect(toolBefore(makeCtx(), "check_appointment_availability", "book_appointment").pass).toBe(true);
  });
  it("passes vacuously when b never occurs", () => {
    expect(toolBefore(makeCtx(), "check_appointment_availability", "record_customer_request").pass).toBe(true);
  });
  it("fails when b occurs before any a", () => {
    const ctx = { toolCalls: [{ name: "book_appointment" }, { name: "check_appointment_availability" }] };
    expect(toolBefore(ctx, "check_appointment_availability", "book_appointment").pass).toBe(false);
  });
});

describe("toolSucceeded", () => {
  it("passes when a success result exists for the tool", () => {
    expect(toolSucceeded(makeCtx(), "book_appointment").pass).toBe(true);
  });
  it("fails when the tool result is a failure or absent", () => {
    const ctx = { toolResults: [{ name: "book_appointment", success: false, message: "slot taken" }] };
    expect(toolSucceeded(ctx, "book_appointment").pass).toBe(false);
    expect(toolSucceeded(makeCtx(), "record_customer_request").pass).toBe(false);
  });
});

describe("replySomewhereMatches / replyNeverMatches", () => {
  it("replySomewhereMatches passes when any reply matches the regex", () => {
    expect(replySomewhereMatches(makeCtx(), /booked for 4 pm/i).pass).toBe(true);
  });
  it("replySomewhereMatches fails when no reply matches", () => {
    expect(replySomewhereMatches(makeCtx(), /oak street/i).pass).toBe(false);
  });
  it("replyNeverMatches is the inverse", () => {
    expect(replyNeverMatches(makeCtx(), /oak street/i).pass).toBe(true);
    expect(replyNeverMatches(makeCtx(), /booked/i).pass).toBe(false);
  });
});

describe("turnsAtMost", () => {
  it("passes at or below the turn budget, fails above", () => {
    expect(turnsAtMost(makeCtx(), 3).pass).toBe(true);
    expect(turnsAtMost(makeCtx(), 2).pass).toBe(false);
  });
});

describe("toolNotCalledBeforeTurn", () => {
  it("passes when the tool only appears at/after the given turn index", () => {
    // end_call is only in turn index 2; nothing before turn 2.
    expect(toolNotCalledBeforeTurn(makeCtx(), "end_call", 2).pass).toBe(true);
  });
  it("fails when the tool appears in an earlier turn", () => {
    // book_appointment appears in turn index 1, which is before turn index 2.
    expect(toolNotCalledBeforeTurn(makeCtx(), "book_appointment", 2).pass).toBe(false);
  });
});
