import { describe, it, expect } from "vitest";
import { scoreQuestionShape } from "../eval/questionShape.js";

// ---------------------------------------------------------------------------
// LVX82. The harness gap, not the counter gap.
//
// Nothing in this repository could both produce a real stacked question and
// report how many things it asked: npm run chat and npm run eval run the
// cascade brain where auditTurn never executes, EVAL_DRIVER=live bumps no
// counters, and scripts/live-call-harness.js says at its own head that it
// cannot hear. This scorer closes that on the text side, using the same
// countAsks the front-end counts with.
// ---------------------------------------------------------------------------

describe("scoreQuestionShape - it stays quiet when nothing is stacked", () => {
  it("counts replies without flagging single asks", () => {
    const ctx = { turns: [{ reply: "Of course. Can I take your name?" }, { reply: "Thanks, Sam." }] };
    const s = scoreQuestionShape(ctx);

    expect(s.repliesChecked).toBe(2);
    expect(s.stackedTurns).toBe(0);
    expect(s.asksTotal).toBe(0);
    expect(s.asksPerReply).toBe(0);
  });

  it("skips turns that carried no text, matching live_reply_turns_checked", () => {
    // A tool-only turn is not a reply the caller heard. Counting it would let a
    // run that made more tool calls score better than one that made fewer.
    const ctx = { turns: [{ reply: "" }, { reply: "   " }, { reply: "Can I take your name?" }] };
    const s = scoreQuestionShape(ctx);

    expect(s.turns).toBe(3);
    expect(s.repliesChecked).toBe(1);
  });

  it("separates a run that asked nothing from a run that never happened", () => {
    // The rule lib/voice/live/summary.js follows: an empty bucket and a silent
    // one must not read the same.
    expect(scoreQuestionShape({ turns: [] }).asksPerReply).toBeNull();
    expect(scoreQuestionShape({}).turns).toBe(0);
    expect(scoreQuestionShape({ turns: [{ reply: "Hello." }] }).asksPerReply).toBe(0);
  });
});

describe("scoreQuestionShape - it catches the shape LVX82 was filed for", () => {
  it("scores the deployed turn as two asks on one question mark", () => {
    const ctx = { turns: [{ reply: "Can I take your name, date of birth, and what it is for?" }] };
    const s = scoreQuestionShape(ctx);

    expect(s.stackedTurns).toBe(1);
    expect(s.asksTotal).toBe(2);
    expect(s.asksMax).toBe(2);
  });

  it("distinguishes a three-part question from a two-part one", () => {
    // This is the whole reason the scorer exists. stackedTurns is 1 for both;
    // only asksTotal moves, and only a number that moves can show a fix.
    const two = scoreQuestionShape({ turns: [{ reply: "What's your name? And your number?" }] });
    const three = scoreQuestionShape({ turns: [{ reply: "What's your name? And your number? And the day?" }] });

    expect(two.stackedTurns).toBe(three.stackedTurns);
    expect(two.asksTotal).toBe(2);
    expect(three.asksTotal).toBe(3);
  });

  it("reports a per-reply rate comparable across runs of different lengths", () => {
    const ctx = {
      turns: [
        { reply: "What's your name? And your number?" },
        { reply: "Thanks." },
        { reply: "What day? And what time? And is it for you?" },
        { reply: "Booked." },
      ],
    };
    const s = scoreQuestionShape(ctx);

    expect(s.repliesChecked).toBe(4);
    expect(s.asksTotal).toBe(5);
    expect(s.asksPerReply).toBeCloseTo(1.25);
  });
});
