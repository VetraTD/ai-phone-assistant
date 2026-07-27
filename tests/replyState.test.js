import { describe, it, expect, vi } from "vitest";
import { STEPS } from "../lib/callState.js";
import { applyReplyState, systemNoteEntry } from "../lib/voice/replyState.js";

// ---------------------------------------------------------------------------
// replyState.test.js — the pure reply-state reducer extracted from
// lib/voice/session.js applyReply. These lock the state transitions and their
// exact ordering so a text-conversation harness can reuse them and so the
// live session cannot drift. No I/O, no logging: hooks are injected.
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
  return {
    history: [],
    step: STEPS.IDENTIFY_INTENT,
    intent: null,
    consecutiveFailures: 3,
    ...overrides,
  };
}

// Default hooks: merge capability state onto state.capabilityState; dispatch
// returns no notes. Individual tests override as needed.
function makeHooks(overrides = {}) {
  return {
    STEPS,
    mergeCapabilityState: vi.fn(),
    dispatchEffects: vi.fn(() => []),
    ...overrides,
  };
}

describe("systemNoteEntry", () => {
  it("produces the byte-exact system-note history entry", () => {
    expect(systemNoteEntry(["a", "b"])).toEqual({
      role: "user",
      parts: [{ text: "[system note — not the caller speaking: a; b.]" }],
    });
  });

  it("joins a single note without a separator", () => {
    expect(systemNoteEntry(["did the thing"]).parts[0].text).toBe(
      "[system note — not the caller speaking: did the thing.]"
    );
  });
});

describe("applyReplyState", () => {
  it("resets consecutiveFailures to 0", () => {
    const state = makeState({ consecutiveFailures: 5 });
    applyReplyState(state, { userText: "hi", reply: { text: "hello" } }, makeHooks());
    expect(state.consecutiveFailures).toBe(0);
  });

  it("pushes user then model history entries in order", () => {
    const state = makeState();
    applyReplyState(
      state,
      { userText: "book me in", reply: { text: "sure thing" } },
      makeHooks()
    );
    expect(state.history).toEqual([
      { role: "user", parts: [{ text: "book me in" }] },
      { role: "model", parts: [{ text: "sure thing" }] },
    ]);
  });

  it("sets intent and transitions from IDENTIFY_INTENT to GATHER_DETAILS", () => {
    const state = makeState({ step: STEPS.IDENTIFY_INTENT });
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r", intentArgs: { intent: "book" } } },
      makeHooks()
    );
    expect(state.intent).toBe("book");
    expect(state.step).toBe(STEPS.GATHER_DETAILS);
    expect(result.intentSet).toEqual({
      intent: "book",
      prevStep: STEPS.IDENTIFY_INTENT,
      newStep: STEPS.GATHER_DETAILS,
    });
  });

  it("transitions from CONFIRM to GATHER_DETAILS on intent", () => {
    const state = makeState({ step: STEPS.CONFIRM });
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r", intentArgs: { intent: "reschedule" } } },
      makeHooks()
    );
    expect(state.step).toBe(STEPS.GATHER_DETAILS);
    expect(result.intentSet.prevStep).toBe(STEPS.CONFIRM);
    expect(result.intentSet.newStep).toBe(STEPS.GATHER_DETAILS);
  });

  it("sets intent but does NOT change step from other steps (GATHER_DETAILS)", () => {
    const state = makeState({ step: STEPS.GATHER_DETAILS });
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r", intentArgs: { intent: "book" } } },
      makeHooks()
    );
    expect(state.intent).toBe("book");
    expect(state.step).toBe(STEPS.GATHER_DETAILS);
    expect(result.intentSet).toEqual({
      intent: "book",
      prevStep: STEPS.GATHER_DETAILS,
      newStep: STEPS.GATHER_DETAILS,
    });
  });

  it("returns intentSet null when no intentArgs", () => {
    const state = makeState();
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r" } },
      makeHooks()
    );
    expect(result.intentSet).toBeNull();
  });

  it("calls mergeCapabilityState with the reply's capabilityState", () => {
    const state = makeState();
    const merge = vi.fn();
    applyReplyState(
      state,
      { userText: "u", reply: { text: "r", capabilityState: { foo: 1 } } },
      makeHooks({ mergeCapabilityState: merge })
    );
    expect(merge).toHaveBeenCalledWith({ foo: 1 });
  });

  it("pushes a system-note history entry when effects dispatch returns notes", () => {
    const state = makeState();
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r", capabilityEffects: [{}] } },
      makeHooks({ dispatchEffects: vi.fn(() => ["booked appt", "sent sms"]) })
    );
    expect(result.capabilityNotes).toEqual(["booked appt", "sent sms"]);
    expect(state.history[state.history.length - 1]).toEqual(
      systemNoteEntry(["booked appt", "sent sms"])
    );
  });

  it("pushes no system note when effects dispatch returns no notes", () => {
    const state = makeState();
    applyReplyState(
      state,
      { userText: "u", reply: { text: "r" } },
      makeHooks({ dispatchEffects: vi.fn(() => []) })
    );
    // only user + model entries
    expect(state.history).toHaveLength(2);
  });

  it("endCall sets step to ENDING and returns ended:true", () => {
    const state = makeState();
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r", endCallArgs: { reason: "done" } } },
      makeHooks()
    );
    expect(state.step).toBe(STEPS.ENDING);
    expect(result.ended).toBe(true);
  });

  it("endCall wins over a step set by effects dispatch", () => {
    const state = makeState({ step: STEPS.IDENTIFY_INTENT });
    // dispatchEffects mutates step mid-reducer (like setStep in the live closure)
    const dispatchEffects = vi.fn(() => {
      state.step = STEPS.CONFIRM;
      return [];
    });
    applyReplyState(
      state,
      {
        userText: "u",
        reply: { text: "r", capabilityEffects: [{}], endCallArgs: { reason: "done" } },
      },
      makeHooks({ dispatchEffects })
    );
    expect(dispatchEffects).toHaveBeenCalled();
    expect(state.step).toBe(STEPS.ENDING);
  });

  it("returns ended:false when no endCallArgs", () => {
    const state = makeState();
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r" } },
      makeHooks()
    );
    expect(result.ended).toBe(false);
  });

  it("returns the full result shape", () => {
    const state = makeState();
    const result = applyReplyState(
      state,
      { userText: "u", reply: { text: "r" } },
      makeHooks()
    );
    expect(result).toEqual({ intentSet: null, capabilityNotes: [], ended: false });
  });

  it("applies operations in the required order: history, intent, merge, dispatch, note, endCall", () => {
    const calls = [];
    const state = makeState({ step: STEPS.IDENTIFY_INTENT });
    const merge = vi.fn(() => calls.push("merge"));
    const dispatchEffects = vi.fn(() => {
      calls.push("dispatch");
      return ["note"];
    });
    applyReplyState(
      state,
      {
        userText: "u",
        reply: {
          text: "r",
          intentArgs: { intent: "book" },
          capabilityState: { a: 1 },
          capabilityEffects: [{}],
          endCallArgs: { reason: "done" },
        },
      },
      makeHooks({ mergeCapabilityState: merge, dispatchEffects })
    );
    expect(calls).toEqual(["merge", "dispatch"]);
    // history: user, model, system-note (intent doesn't push history)
    expect(state.history[0].role).toBe("user");
    expect(state.history[1].role).toBe("model");
    expect(state.history[2]).toEqual(systemNoteEntry(["note"]));
    // endCall wins
    expect(state.step).toBe(STEPS.ENDING);
  });
});
