import { beforeEach, describe, expect, it, vi } from "vitest";
import { judgeCall, judgeMode, selectAgreedSlot } from "../lib/postCallJudge.js";
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

  it("has an acting rung, and only under that exact spelling", () => {
    // WAS "has no rung that acts, however it is spelled", and the old comment
    // said a deploy variable must not be able to turn a detector into an author.
    // `act` was added 2026-09-12 and does not do that: the verdict this file
    // produces still authors nothing. What act enables is selectAgreedSlot, whose
    // output is an INDEX into the list of times an availability tool already
    // confirmed open -- so it can name a wrong opening but cannot invent a time,
    // which is the failure that got claimSlot.js reverted.
    //
    // Every near-miss still resolves to off, so a typo cannot half-enable it.
    expect(judgeMode({ POSTCALL_JUDGE: "act" })).toBe("act");
    expect(judgeMode({ POSTCALL_JUDGE: "ACT" })).toBe("act");
    expect(judgeMode({ POSTCALL_JUDGE: "commit" })).toBe("off");
    expect(judgeMode({ POSTCALL_JUDGE: "on" })).toBe("off");
    expect(judgeMode({ POSTCALL_JUDGE: "action" })).toBe("off");
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

// ---------------------------------------------------------------------------
// selectAgreedSlot — the rung that can move a row, and the one thing it must
// structurally be unable to do: name a time nobody confirmed was open.
//
// Its output is an INDEX into a list it was handed. So the hostile cases are not
// "what if it picks the wrong time" -- it cannot express a time at all -- they are
// "what if it answers 99", "what if it answers 1.5", "what if it answers a
// string". Every one of those must resolve to no selection, because the
// alternative is `slots[undefined]` or a silent coercion to slots[0], and a
// confident booking at the first offered time is exactly the failure that got
// claimSlot.js reverted.
//
// As above, the prompt is not under test. Whether the reader chooses CORRECTLY is
// a question only real calls answer.
// ---------------------------------------------------------------------------
describe("selectAgreedSlot", () => {
  beforeEach(() => clearStats());

  const SLOTS = ["2026-09-14T09:00", "2026-09-14T13:00", "2026-09-14T16:30"];
  const pick = (over = {}) => JSON.stringify({ slot_index: 2, confidence: "high", ...over });
  const run = (raw, over = {}, opts = {}) => {
    const h = harness(raw, opts);
    return selectAgreedSlot(
      { transcript: TRANSCRIPT, slots: SLOTS, callSid: "CA1", mode: "act", ...over },
      h.deps
    ).then((out) => ({ out, h }));
  };

  it("returns the list member at the chosen index, byte for byte", async () => {
    const { out } = await run(pick());
    expect(out.slot).toBe("2026-09-14T16:30");
    expect(out.slotIndex).toBe(2);
    expect(c().recover_select_chose).toBe(1);
  });

  it("puts the candidate times in the prompt, so the choice is over real openings", async () => {
    const { h } = await run(pick());
    const prompt = h.generate.mock.calls[0][0];
    for (const s of SLOTS) expect(prompt).toContain(s);
  });

  it("makes no selection when the index is past the end of the list", async () => {
    // The shape a hallucinated time takes. slots[99] is undefined, and a booking
    // at undefined would either throw at the database or write null.
    const { out } = await run(pick({ slot_index: 99 }));
    expect(out.slot).toBe(null);
    expect(c().recover_select_out_of_range).toBe(1);
  });

  it("makes no selection on a negative index", async () => {
    const { out } = await run(pick({ slot_index: -1 }));
    expect(out.slot).toBe(null);
  });

  it("makes no selection when the index is not an integer", async () => {
    for (const idx of [1.5, "2", true, {}, []]) {
      clearStats();
      const { out } = await run(pick({ slot_index: idx }));
      expect(out.slot, JSON.stringify(idx)).toBe(null);
    }
  });

  it("treats an explicit null as the refusal it is", async () => {
    const { out } = await run(pick({ slot_index: null }));
    expect(out.slot).toBe(null);
    expect(c().recover_select_declined).toBe(1);
  });

  it("never throws, and selects nothing, on unparseable output", async () => {
    const { out } = await run("I think they wanted the 4:30 one");
    expect(out.slot).toBe(null);
    expect(c().recover_select_failed).toBe(1);
  });

  it("never throws when the vendor does", async () => {
    const { out } = await run(pick(), {}, { throws: true });
    expect(out.slot).toBe(null);
    expect(c().recover_select_failed).toBe(1);
  });

  it("does not call the model at all outside act mode", async () => {
    for (const mode of ["off", "shadow", undefined]) {
      const { out, h } = await run(pick(), { mode });
      expect(out.slot, String(mode)).toBe(null);
      expect(h.generate, String(mode)).not.toHaveBeenCalled();
    }
  });

  it("does not call the model when there is nothing to choose from", async () => {
    const { out, h } = await run(pick(), { slots: [] });
    expect(out.slot).toBe(null);
    expect(h.generate).not.toHaveBeenCalled();
    expect(c().recover_no_candidate_slots).toBe(1);
  });

  it("logs an index and a count, never a time", async () => {
    const { h } = await run(pick());
    const line = h.log.info.mock.calls.find((call) => call[0] === "recover_select")?.[1] || {};
    expect(line.slot_index).toBe(2);
    expect(line.candidates).toBe(3);
    // A caller's appointment time is not a log field. LVX24 was a sanitizer
    // logging the text it caught.
    expect(JSON.stringify(line)).not.toContain("2026-09-14");
  });
});
