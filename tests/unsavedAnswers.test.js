import { describe, it, expect } from "vitest";
import { isInformativeCallerTurn, countUnsaved } from "../lib/voice/unsavedAnswers.js";

const READ_BACK = "22 Godstone Road, RH7 6AA, is that right?";
const SEAT = "Do you need a child seat?";

describe("isInformativeCallerTurn", () => {
  it.each(["two passengers", "card", "BA2490", "yes a child seat"])("counts %j", (t) => {
    expect(isInformativeCallerTurn(t, SEAT)).toBe(true);
  });

  it.each(["", "   ", "um", "No, that's all, thanks", "thanks, bye", "cheers", "no thanks", "bye"])(
    "does not count %j",
    (t) => {
      expect(isInformativeCallerTurn(t, SEAT)).toBe(false);
    }
  );

  it("a bare yes confirming a read-back is not informative", () => {
    expect(isInformativeCallerTurn("yes", READ_BACK)).toBe(false);
    expect(isInformativeCallerTurn("that's right", READ_BACK)).toBe(false);
  });

  it("a bare yes answering a real question is informative", () => {
    expect(isInformativeCallerTurn("yes", SEAT)).toBe(true);
    expect(isInformativeCallerTurn("that's right", SEAT)).toBe(true);
  });

  it("tolerates non-strings", () => {
    expect(isInformativeCallerTurn(undefined, undefined)).toBe(false);
  });
});

describe("countUnsaved", () => {
  const turns = [1, 2, 3, 4, 5, 6].map((index) => ({ index, caller: "two passengers", prevReply: SEAT }));

  it("counts only informative turns after the save", () => {
    expect(countUnsaved(turns, 3)).toBe(3);
  });

  it("skips non-informative turns", () => {
    const mixed = [
      { index: 4, caller: "um", prevReply: SEAT },
      { index: 5, caller: "card", prevReply: SEAT },
      { index: 6, caller: "thanks, bye", prevReply: "Anything else?" },
    ];
    expect(countUnsaved(mixed, 3)).toBe(1);
  });

  it("a voiced turn with empty text counts", () => {
    expect(countUnsaved([{ index: 1, caller: "", prevReply: SEAT, voiced: true }], 0)).toBe(1);
    expect(countUnsaved([{ index: 1, caller: "", prevReply: SEAT }], 0)).toBe(0);
  });

  it("is safe on bad input", () => {
    expect(countUnsaved(undefined, 0)).toBe(0);
    expect(countUnsaved(turns, 99)).toBe(0);
  });
});

describe("read-back detection (fix round 1)", () => {
  it("a bare yes after a tag question 'right?' is a confirmation", () => {
    expect(isInformativeCallerTurn("yes", "Two passengers, right?")).toBe(false);
    expect(isInformativeCallerTurn("yes", "That's the pickup at the station, OK?")).toBe(false);
  });

  it("a bare yes to an offer is an answer, not a confirmation", () => {
    expect(isInformativeCallerTurn("yes", "Would you like me to add a child seat?")).toBe(true);
    expect(isInformativeCallerTurn("yes please", "Shall I put you down for the airport run?")).toBe(true);
  });

  it("'bright?' is not a tag question", () => {
    expect(isInformativeCallerTurn("yes", "Is the room bright?")).toBe(true);
  });

  it("uses the locale's read-back test when one is passed", () => {
    const re = /confirm that/i;
    expect(isInformativeCallerTurn("yes", "Can you confirm that for me", re)).toBe(false);
    expect(isInformativeCallerTurn("yes", "Two passengers, right?", re)).toBe(true);
    const turns = [{ index: 1, caller: "yes", prevReply: "Can you confirm that for me" }];
    expect(countUnsaved(turns, 0, re)).toBe(0);
    expect(countUnsaved(turns, 0)).toBe(1);
  });
});
