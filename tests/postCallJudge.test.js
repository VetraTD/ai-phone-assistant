import { beforeEach, describe, expect, it, vi } from "vitest";
import { judgeCall, judgeMode } from "../lib/postCallJudge.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// The judge is a DETECTOR and never an author, so what these tests protect is
// narrow: that it answers the one question, that it fails safe, and that nothing
// the model said can reach a log line.
//
// No API calls. `generate` is injected, which also means the prompt itself is not
// under test here -- only the contract around it. The prompt can only be
// evaluated against real calls, which is what shadow mode is for, and a fixture
// table I wrote to match my own prompt would prove nothing: a detail matcher
// scored 13/13 on thirteen self-chosen fixtures in this repository and failed in
// both directions on the first unseen call.
// ---------------------------------------------------------------------------

const c = () => getLatencyStats().turnTaking;

const TRANSCRIPT = [
  { speaker: "ai", message: "Thanks for calling Digile Media, how can I help?" },
  { speaker: "caller", message: "I need to book a strategy call please" },
  { speaker: "ai", message: "Just to confirm, Monday the fourteenth at two in the afternoon?" },
  { speaker: "caller", message: "Yes that works" },
];

const reply = (over = {}) =>
  JSON.stringify({
    agreed_action: "book",
    agreed_turn: 3,
    time_stated: true,
    claimed_done: true,
    claimed_failure: false,
    confidence: "high",
    ...over,
  });

function harness(raw, { throws = false } = {}) {
  const generate = vi.fn(async () => {
    if (throws) throw new Error("vendor exploded");
    return raw;
  });
  const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { generate, log, deps: { generate, log } };
}

describe("judgeMode", () => {
  it("is off unless explicitly set to shadow", () => {
    expect(judgeMode({})).toBe("off");
    expect(judgeMode({ POSTCALL_JUDGE: "" })).toBe("off");
    expect(judgeMode({ POSTCALL_JUDGE: "shadow" })).toBe("shadow");
    expect(judgeMode({ POSTCALL_JUDGE: "SHADOW" })).toBe("shadow");
  });

  it("has no rung that acts, however it is spelled", () => {
    // Deliberate. A deploy variable must not be able to turn a detector into an
    // author; that takes a code change and a decision.
    expect(judgeMode({ POSTCALL_JUDGE: "act" })).toBe("off");
    expect(judgeMode({ POSTCALL_JUDGE: "commit" })).toBe("off");
    expect(judgeMode({ POSTCALL_JUDGE: "on" })).toBe("off");
  });
});

describe("judgeCall", () => {
  beforeEach(() => clearStats());

  it("does not call the model at all when off", async () => {
    const h = harness(reply());
    const out = await judgeCall({ transcript: TRANSCRIPT, mode: "off" }, h.deps);

    expect(out.ran).toBe(false);
    expect(h.generate).not.toHaveBeenCalled();
    expect(c().postcall_judge_ran ?? 0).toBe(0);
  });

  it("reports a missing booking when it agreed one and no row exists", async () => {
    const h = harness(reply());
    const out = await judgeCall(
      { transcript: TRANSCRIPT, callSid: "CA1", bookedRowCount: 0, mode: "shadow" },
      h.deps
    );

    expect(out.agreedAction).toBe("book");
    expect(out.bookingMissing).toBe(true);
    expect(c().postcall_judge_ran).toBe(1);
    expect(c().postcall_judge_booking_agreed).toBe(1);
    expect(c().postcall_judge_booking_missing).toBe(1);
  });

  it("reports nothing missing when the booking it agreed actually exists", async () => {
    // The assertion that separates this from a judge that flags every call which
    // mentioned an appointment.
    const h = harness(reply());
    const out = await judgeCall(
      { transcript: TRANSCRIPT, bookedRowCount: 1, mode: "shadow" },
      h.deps
    );

    expect(out.agreedAction).toBe("book");
    expect(out.bookingMissing).toBe(false);
    expect(c().postcall_judge_booking_missing ?? 0).toBe(0);
  });

  it("CA422f58: a booking agreed and then disclaimed is still a booking owed", async () => {
    // THE CASE THIS WHOLE EFFORT STARTED FROM. The caller agreed, then the
    // assistant announced a technical glitch that had not happened. The old
    // post-call check hunted for claims of SUCCESS and so found nothing to worry
    // about; the verdict came back ok and nobody was told.
    //
    // The judge is asked what was AGREED, not what was later announced, which is
    // why a claimed failure does not erase the obligation.
    const h = harness(reply({ claimed_done: false, claimed_failure: true }));
    const out = await judgeCall(
      { transcript: TRANSCRIPT, bookedRowCount: 0, mode: "shadow" },
      h.deps
    );

    expect(out.claimedFailure).toBe(true);
    expect(out.claimedDone).toBe(false);
    expect(out.bookingMissing).toBe(true);
  });

  it("reports nothing missing when nothing was agreed", async () => {
    const h = harness(reply({ agreed_action: "none", agreed_turn: null, time_stated: false }));
    const out = await judgeCall(
      { transcript: TRANSCRIPT, bookedRowCount: 0, mode: "shadow" },
      h.deps
    );

    expect(out.agreedAction).toBe("none");
    expect(out.bookingMissing).toBe(false);
  });

  it("skips a transcript too short to support a verdict", async () => {
    const h = harness(reply());
    const out = await judgeCall(
      { transcript: [{ speaker: "ai", message: "Hello there, thanks for calling." }], mode: "shadow" },
      h.deps
    );

    expect(out.ran).toBe(false);
    expect(h.generate).not.toHaveBeenCalled();
    expect(c().postcall_judge_skipped).toBe(1);
  });

  it("fails safe on unparseable output, and never logs what the model said", async () => {
    // The likeliest malformed output is a half-written sentence ABOUT THE CALLER.
    // The summary extractor next door logs raw.slice(0, 200) on a parse failure,
    // which passes the PHI lint only because the lint matches field names. This
    // must not.
    const h = harness("I think the caller, Dylan Bhakta, wanted Monday at 2pm");
    const out = await judgeCall(
      { transcript: TRANSCRIPT, callSid: "CA1", bookedRowCount: 0, mode: "shadow" },
      h.deps
    );

    expect(out.ran).toBe(false);
    expect(c().postcall_judge_failed).toBe(1);

    const logged = JSON.stringify(h.log.error.mock.calls);
    expect(logged).not.toMatch(/Dylan/i);
    expect(logged).not.toMatch(/Bhakta/i);
    expect(logged).not.toMatch(/2pm/i);
  });

  it("survives the vendor throwing", async () => {
    const h = harness(null, { throws: true });
    const out = await judgeCall({ transcript: TRANSCRIPT, mode: "shadow" }, h.deps);

    expect(out.ran).toBe(false);
    expect(c().postcall_judge_failed).toBe(1);
  });

  it("coerces prose where an enum belongs, rather than passing it through", async () => {
    // A model that answers in sentences must not be able to put those sentences
    // into a log line by way of a field that was supposed to be an enum.
    const h = harness(
      JSON.stringify({
        agreed_action: "the caller Dylan agreed to book Monday",
        agreed_turn: "turn three",
        confidence: "quite sure",
      })
    );
    const out = await judgeCall(
      { transcript: TRANSCRIPT, bookedRowCount: 0, mode: "shadow" },
      h.deps
    );

    expect(out.agreedAction).toBe("none");
    expect(out.agreedTurn).toBe(null);
    expect(out.confidence).toBe("low");
    expect(out.bookingMissing).toBe(false);

    const logged = JSON.stringify(h.log.info.mock.calls);
    expect(logged).not.toMatch(/Dylan/i);
  });

  it("puts no caller speech in the log line at all", async () => {
    // The verdict is enums, booleans and a transcript ROW INDEX. A human who
    // needs the sentence pulls the row; the index is not caller data and the
    // sentence is.
    const h = harness(reply());
    await judgeCall(
      { transcript: TRANSCRIPT, callSid: "CA1", bookedRowCount: 0, mode: "shadow" },
      h.deps
    );

    const logged = JSON.stringify(h.log.info.mock.calls);
    for (const line of TRANSCRIPT) {
      expect(logged).not.toContain(line.message);
    }
    // But the index survives, or a human has no way back to the sentence.
    expect(h.log.info.mock.calls[0][1].agreed_turn).toBe(3);
  });
});
