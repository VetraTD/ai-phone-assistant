/**
 * The caller resumed while the assistant was still thinking.
 *
 * Reported from a live call: the caller pauses mid-thought, the assistant takes
 * the pause for the end of the turn and starts preparing a reply, the caller
 * carries on, and the two collide.
 *
 * Today the second half is QUEUED (lib/voice/session.js, `state.processingTurn`
 * branch) and answered as a separate turn, so one sentence produces two
 * answers. The teardown that should run instead already exists in onInterrupt,
 * but it is unreachable: turnManager gates barge-in on `audioOut.isPlaying()`,
 * which is false during the silent gap.
 *
 * This is the predicate that decides whether the in-flight turn may be thrown
 * away. Every `false` below is a case where throwing it away would be worse
 * than the collision.
 */

import { describe, it, expect } from "vitest";
import { shouldAbortForResume, isWriteTool } from "../lib/voice/session.js";

/** The ordinary case: a turn is being prepared and nothing has been heard yet. */
const base = {
  enabled: true,
  processingTurn: true,
  audioStarted: false,
  textStarted: false,
  toolStarted: false,
  resumeAborts: 0,
  maxAborts: 2,
};

describe("shouldAbortForResume", () => {
  it("aborts when the caller resumes during the silent gap", () => {
    expect(shouldAbortForResume(base)).toBe(true);
  });

  it("does nothing when the flag is off", () => {
    expect(shouldAbortForResume({ ...base, enabled: false })).toBe(false);
  });

  it("does nothing when no turn is in flight", () => {
    expect(shouldAbortForResume({ ...base, processingTurn: false })).toBe(false);
  });

  it("defers to barge-in once the caller has actually heard audio", () => {
    // Past this point the caller HAS heard something, so the partial reply is
    // real and recordInterruptedTurn's accounting applies. Two subsystems
    // tearing down the same turn is how double-teardown bugs happen.
    expect(shouldAbortForResume({ ...base, audioStarted: true })).toBe(false);
  });

  it("refuses once the model has started emitting words", () => {
    // Not merely an optimisation. Once deltas are flowing, TTS is already
    // synthesizing and audio is ~95ms behind, so "the caller resumed while it
    // was still thinking" has stopped being true and the barge path — which
    // does the history accounting properly — owns it instead.
    //
    // tests/session.test.js 16g is the case: a turn that had streamed "Let me
    // check " and was then resumed. Aborting there discarded a question the
    // caller was about to hear answered.
    expect(shouldAbortForResume({ ...base, textStarted: true })).toBe(false);
  });

  it("refuses once a tool round has started — the money case", () => {
    // The in-flight turn may already have called book_appointment. Aborting
    // unwinds the generator, but a tool that completes after that is written to
    // the database and never salvaged into the next turn's history, so the
    // merged turn books a SECOND appointment. This hazard exists for barge-in
    // today; firing it on ordinary hesitation instead of deliberate
    // interruption would make it common. Queue instead, as before.
    expect(shouldAbortForResume({ ...base, toolStarted: true })).toBe(false);
  });

  it("stops after the cap, so a talkative caller is never starved", () => {
    // Abort -> restart -> caller speaks -> abort ... each cycle costs a full
    // LLM round trip and the caller is never answered. Past the cap, fall back
    // to today's queueing, which always terminates.
    expect(shouldAbortForResume({ ...base, resumeAborts: 1 })).toBe(true);
    expect(shouldAbortForResume({ ...base, resumeAborts: 2 })).toBe(false);
    expect(shouldAbortForResume({ ...base, resumeAborts: 9 })).toBe(false);
  });

  it("treats a zero cap as disabled", () => {
    expect(shouldAbortForResume({ ...base, maxAborts: 0 })).toBe(false);
  });
});

describe("isWriteTool — only a write blocks the recovery", () => {
  it("treats caller-visible writes as writes", () => {
    for (const t of ["book_appointment", "cancel_appointment_db", "reschedule_appointment_db", "record_customer_request", "record_quote_request"]) {
      expect(isWriteTool(t), t).toBe(true);
    }
  });

  it("treats lookups as reads", () => {
    // The bug this fixes: check_appointment_availability fires early in every
    // booking, and latching on it blocked the resume recovery for the rest of
    // the turn. A live call produced exactly that — one answer to the first
    // sentence, then immediately a second answer to the continuation.
    for (const t of ["check_appointment_availability", "get_caller_appointments_from_db"]) {
      expect(isWriteTool(t), t).toBe(false);
    }
  });

  it("fails SAFE on an unknown tool", () => {
    // A missed recovery is a worse call; a duplicate booking is a worse day.
    expect(isWriteTool("some_webhook_tool")).toBe(true);
    expect(isWriteTool("")).toBe(false);
  });
});
