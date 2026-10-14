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

  // Round A1 "say it once". The booking save rule reads a read-back spoken in
  // the turn in progress, and the handed read-back spells a surname the caller
  // spelled. Both are produced by lib/voice/live/index.js turnState() and are
  // dead unless copied here -- the LVX45 shape this file exists for.
  it("carries inTurnReplyText through to the tool (the A1 in-turn read-back wire)", async () => {
    const ctx = await ctxFor(() => ({
      step: "confirm",
      callerTurnCount: 4,
      inTurnReplyText: "Friday at 2 PM for Marcus Bell, booking that now.",
    }));
    expect(ctx.inTurnReplyText).toBe("Friday at 2 PM for Marcus Bell, booking that now.");
  });

  it("normalises a missing inTurnReplyText to a string, never undefined", async () => {
    const ctx = await ctxFor(() => ({ step: "identify_intent", callerTurnCount: 1 }));
    expect(ctx.inTurnReplyText).toBe("");
  });

  it("carries callerSpelled through to the tool (the A1/LVX172 wire)", async () => {
    const yes = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4, callerSpelled: true }));
    expect(yes.callerSpelled).toBe(true);
    const no = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4 }));
    expect(no.callerSpelled).toBe(false);
  });

  // Round A1, T5b: "made no sound since the read-back" holds a booking. The
  // value must arrive as the boolean turnState() produced; anything else is
  // null (wire absent), which the gate logs and treats as before T5b.
  it("carries callerVoicedSinceReply through to the tool (the T5b wire)", async () => {
    const silent = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4, callerVoicedSinceReply: false }));
    expect(silent.callerVoicedSinceReply).toBe(false);
    const voiced = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4, callerVoicedSinceReply: true }));
    expect(voiced.callerVoicedSinceReply).toBe(true);
    const absent = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4 }));
    expect(absent.callerVoicedSinceReply).toBeNull();
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

  it("carries the agreement token through to the tool (the LVX117 wire)", async () => {
    // The value the silent-turn refusal reads, and it is read to REFUSE. So an
    // uncopied field here does not fail closed like lastReplyText does -- it
    // makes the gate refuse EVERY write on a silent turn, including the benign
    // one a turn after a real agreement. Exactly the LVX45 shape again, with the
    // damage pointing the other way.
    const ctx = await ctxFor(() => ({
      step: "confirm",
      callerTurnCount: 6,
      lastCallerText: "",
      lastReplyText: "Just to confirm, shall I go ahead and book that for you?",
      lastAgreementReadBackKey: "k12345",
      callerTurnsSinceAgreement: 2,
    }));
    expect(ctx.lastAgreementReadBackKey).toBe("k12345");
    expect(ctx.callerTurnsSinceAgreement).toBe(2);
  });

  it("normalises a missing agreement token to null, never undefined", async () => {
    // null is "no agreement anywhere on this call", which is what the refusal
    // fires on. It has to be reachable by a call that genuinely never had one,
    // and indistinguishable from a wire that was never connected is exactly what
    // it must NOT be -- hence the probe's silent_turn_verdict, which is emitted
    // on every attempt whatever this holds.
    const ctx = await ctxFor(() => ({ step: "identify_intent", callerTurnCount: 1 }));
    expect(ctx.lastAgreementReadBackKey).toBe(null);
    expect(ctx.callerTurnsSinceAgreement).toBe(null);
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

  // -------------------------------------------------------------------------
  // LVX132's wire, and it fails in the OPPOSITE direction to every other field
  // on this page, which is why it gets its own pair.
  //
  // Everywhere else here, a field produced by turnState and not copied into ctx
  // reads as undefined downstream and a gate silently never fires. This one is
  // worse than that if it is copied wrongly and better than that if it is
  // missing: services/tools.js refuses a hang-up only when BOTH halves arrive
  // as booleans, because the one-shot latch lives here and a driver without it
  // could never spend the refusal -- it would refuse the first hang-up, and the
  // next, and every one after. The cascade passes neither and is inert.
  //
  // So "the gate is off" and "the gate is on" are one `typeof` apart, and
  // nothing else in the suite would notice the difference.
  // -------------------------------------------------------------------------
  it("carries both halves of the ask gate as booleans (the LVX132 wire)", async () => {
    const ctx = await ctxFor(() => ({
      step: "confirm",
      callerTurnCount: 4,
      lastCallerText: "no",
      askedAnythingElse: true,
    }));
    expect(ctx.askedAnythingElse).toBe(true);
    expect(ctx.anythingElseRefusalSpent).toBe(false);
  });

  it("normalises a missing askedAnythingElse to false, never undefined", async () => {
    const ctx = await ctxFor(() => ({ step: "confirm", callerTurnCount: 4, lastCallerText: "no" }));
    // A boolean either way: undefined here would switch the gate off entirely
    // on the Live path, which is the one reading that must not be reachable by
    // accident.
    expect(ctx.askedAnythingElse).toBe(false);
    expect(typeof ctx.anythingElseRefusalSpent).toBe("boolean");
  });

  it("spends the ask-gate latch when the tool reports it (the LVX132 wire)", async () => {
    const seen = [];
    const execute = vi.fn(async (fc, ctx) => {
      seen.push(ctx.anythingElseRefusalSpent);
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false } },
        stateEffects: { endCallNoAskRefusal: true },
      };
    });
    const runner = createToolRunner({
      config: CONFIG,
      extras: { integrations: [], businessId: "b1", callerPhone: "+1469", callId: "c1" },
      execute,
      turnState: () => ({ step: "confirm", callerTurnCount: 4, lastCallerText: "no" }),
    });

    await runner.handleToolCall({ functionCalls: [{ id: "1", name: "end_call", args: {} }] });
    await runner.handleToolCall({ functionCalls: [{ id: "2", name: "end_call", args: {} }] });

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


// Final review M5 (2026-10-02): a completed action spends the write-order
// state of its pack, not just the stash. Otherwise a proposal the ceiling
// released before the caller did something else is released again, on its
// first attempt, with no read-back and no yes behind it.
describe("a completed action clears the pack's write-order proposal", () => {
  it("clears writeOrderProposalKey along with pendingWrite", async () => {
    let n = 0;
    const execute = vi.fn(async (fc) => {
      n += 1;
      if (n === 1) {
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: false, gated: true, message: "held" } },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message: "held" },
            capabilityState: {
              appointments: {
                pendingWrite: { name: fc.name, args: fc.args, reason: "spelling" },
                writeOrderProposalKey: "P",
                writeOrderEverReadBack: true,
                writeOrderRefusals: 1,
              },
            },
          },
        };
      }
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: { toolResult: { name: fc.name, success: true, message: "Cancelled." } },
      };
    });
    const runner = createToolRunner({
      config: CONFIG,
      extras: { integrations: [], businessId: "b1", callerPhone: "+14699338887", callId: "c1" },
      execute,
      turnState: () => ({ step: "gather_details", callerTurnCount: 3 }),
    });
    await runner.handleToolCall({
      // A cancellation, not a booking: the Live availability guard refuses an
      // unchecked booking before the stub executor would ever see it.
      functionCalls: [{ id: "1", name: "cancel_appointment_db", args: { appointment_id: "held-1" } }],
    });
    expect(runner.capabilityState.appointments.writeOrderProposalKey).toBe("P");
    await runner.handleToolCall({ functionCalls: [{ id: "2", name: "cancel_appointment_db", args: { appointment_id: "a1" } }] });
    expect(runner.capabilityState.appointments.pendingWrite).toBeNull();
    expect(runner.capabilityState.appointments.writeOrderProposalKey).toBeNull();
  });
});
