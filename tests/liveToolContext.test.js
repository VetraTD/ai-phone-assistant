// ---------------------------------------------------------------------------
// The tool context the Live runner hands to every tool -- and whether it is
// actually CONNECTED to the thing that produces it.
//
// This file exists because of how LVX45 hid. The hesitation gate for end_call
// shipped, was reviewed, and had a passing unit test; the value it reads was
// produced correctly by turnState() and never copied into the tool context. So
// services/tools.js read undefined, heardOnlyHesitation was permanently false,
// and the gate was unreachable on every Live call that has ever been made.
//
// Both halves were tested. tests/tools.test.js passes lastCallerText straight
// into executeToolCall, which proves the consumer. turnState() proves the
// producer. Nothing proved the wire between them, and the only counter that
// could have said so -- end_call_refused_hesitation -- reads 0 whether the gate
// is working perfectly or missing entirely.
//
// So: assert the CONNECTION, at the seam, with the real runner.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from "vitest";
import { createToolRunner } from "../lib/voice/live/tools.js";

const CONFIG = {
  businessName: "Brightwork Family Dental",
  timezone: "America/Chicago",
  allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
  businessHours: {},
};

/**
 * Run one tool call through the real runner with a stub executor, and return
 * the ctx that reached it. The executor is the seam createToolRunner already
 * exposes for the eval driver, so this exercises the production path rather
 * than a second copy of it.
 */
async function ctxFor(turnState) {
  const execute = vi.fn(async (fc) => ({
    functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
  }));
  const runner = createToolRunner({
    config: CONFIG,
    extras: { integrations: [], businessId: "b1", callerPhone: "+14699338887", callId: "c1" },
    execute,
    turnState,
  });
  await runner.handleToolCall({
    functionCalls: [{ id: "1", name: "record_customer_request", args: { request_type: "message" } }],
  });
  expect(execute).toHaveBeenCalled();
  return execute.mock.calls[0][1];
}

describe("Live tool context — the fields tools actually depend on arrive", () => {
  it("carries lastCallerText through to the tool (the LVX45 wire)", async () => {
    const ctx = await ctxFor(() => ({
      step: "gather_details",
      callerTurnCount: 3,
      transferAllowed: true,
      spellingSettled: false,
      lastCallerText: "Ah!",
    }));
    // The exact value matters, not merely that the key exists: a gate reading
    // "" behaves identically to a gate reading undefined, which is the state
    // this test was written to make impossible.
    expect(ctx.lastCallerText).toBe("Ah!");
  });

  it("normalises a missing lastCallerText to a string, never undefined", async () => {
    // services/tools.js treats "" as "the caller said nothing", which the
    // silence ladder owns. undefined would take the same branch by accident
    // rather than by decision, and that accident is what LVX45 was.
    const ctx = await ctxFor(() => ({ step: "identify_intent", callerTurnCount: 1 }));
    expect(ctx.lastCallerText).toBe("");
  });

  it("carries lastReplyText through to the tool (the LVX95 wire)", async () => {
    // The write-order gate's other half. lastCallerText says whether the caller
    // agreed; this says whether anything was put to them to agree TO. A gate
    // with only the first half passes "yes" on a turn where nothing was asked,
    // which is the honour system it replaces.
    const ctx = await ctxFor(() => ({
      step: "confirm",
      callerTurnCount: 4,
      lastCallerText: "Yes, go ahead",
      lastReplyText: "Just to confirm, shall I go ahead and book that for you?",
    }));
    expect(ctx.lastReplyText).toBe("Just to confirm, shall I go ahead and book that for you?");
  });

  it("normalises a missing lastReplyText to a string, never undefined", async () => {
    // Fails CLOSED. "" cannot match confirmReadBackRe, so a missing wire
    // refuses writes rather than waving them through -- the opposite of LVX45,
    // where an uncopied field made a gate silently unreachable and its counter
    // read 0 for the life of a deployment.
    const ctx = await ctxFor(() => ({ step: "identify_intent", callerTurnCount: 1 }));
    expect(ctx.lastReplyText).toBe("");
  });

  it("carries the rest of the turn state the gates read", async () => {
    const ctx = await ctxFor(() => ({
      step: "confirm",
      callerTurnCount: 5,
      transferAllowed: false,
      spellingSettled: true,
      lastCallerText: "yes please",
    }));
    expect(ctx.step).toBe("confirm");
    expect(ctx.callerTurnCount).toBe(5);
    expect(ctx.transferAllowed).toBe(false);
    expect(ctx.spellingSettled).toBe(true);
  });

  it("carries abandonedWrites through to the tool (the LVX72 wire)", async () => {
    // Same shape as the LVX45 wire above, and asserted for the same reason:
    // turnState() produces this and the ctx object copies it by hand, so the
    // two can drift silently. The end_call counters would then read 0 whether
    // no write was abandoned or the field never arrived -- and distinguishing
    // those two is the entire purpose of end_call_abandoned_check_ran.
    const ctx = await ctxFor(() => ({
      step: "confirm",
      callerTurnCount: 4,
      lastCallerText: "no thanks",
      abandonedWrites: ["correct_appointment_name"],
    }));
    expect(ctx.abandonedWrites).toEqual(["correct_appointment_name"]);
  });

  it("normalises a missing abandonedWrites to an array, never undefined", async () => {
    // An array is what makes the count-only check RUN. undefined makes it
    // no-op, which is correct for the cascade and wrong here: a Live call that
    // reported nothing would be indistinguishable from one that was never
    // asked.
    const ctx = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4, lastCallerText: "no" }));
    expect(ctx.abandonedWrites).toEqual([]);
  });

  it("starts a call with the abandoned-hangup refusal unspent", async () => {
    const ctx = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4, lastCallerText: "no" }));
    expect(ctx.abandonedHangupRefusalSpent).toBe(false);
  });

  it("spends the abandoned-hangup latch when the tool reports it (the LVX72 wire)", async () => {
    // A latch that is never set makes the guard fire on EVERY end_call, which
    // is the hair trigger the whole count-first ladder existed to avoid -- and
    // it would look identical from services/tools.js's own tests, which is how
    // the hesitation gate sat unreachable for the life of a deployment.
    const seen = [];
    const execute = vi.fn(async (fc, ctx) => {
      seen.push(ctx.abandonedHangupRefusalSpent);
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false } },
        stateEffects: { endCallAbandonedRefusal: true },
      };
    });
    const runner = createToolRunner({
      config: CONFIG,
      extras: { integrations: [], businessId: "b1", callerPhone: "+1469", callId: "c1" },
      execute,
      turnState: () => ({ step: "confirm", callerTurnCount: 4, lastCallerText: "no" }),
    });

    await runner.handleToolCall({ functionCalls: [{ id: "1", name: "end_call", args: { reason: "done" } }] });
    await runner.handleToolCall({ functionCalls: [{ id: "2", name: "end_call", args: { reason: "done" } }] });

    expect(seen).toEqual([false, true]);
  });

  it("rebuilds the context per call so a later tool sees the same turn", async () => {
    const execute = vi.fn(async (fc) => ({
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
    }));
    const runner = createToolRunner({
      config: CONFIG,
      extras: { integrations: [], businessId: "b1", callerPhone: "+1469", callId: "c1" },
      execute,
      turnState: () => ({ step: "gather_details", callerTurnCount: 2, lastCallerText: "umm" }),
    });
    await runner.handleToolCall({
      functionCalls: [
        { id: "1", name: "record_customer_request", args: { request_type: "message" } },
        { id: "2", name: "record_customer_request", args: { request_type: "callback" } },
      ],
    });
    for (const call of execute.mock.calls) {
      expect(call[1].lastCallerText).toBe("umm");
    }
  });
});

