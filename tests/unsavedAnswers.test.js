import { describe, it, expect } from "vitest";
import { isInformativeCallerTurn, countUnsaved, readBackQuestionRe, closingRegexFor } from "../lib/voice/unsavedAnswers.js";

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

describe("readBackQuestionRe, the regex the engine and harness pass (fix round 2)", () => {
  const re = readBackQuestionRe("en");
  it("a yes to a check question is a confirmation", () => {
    expect(isInformativeCallerTurn("yes", "Two passengers, right?", re)).toBe(false);
    expect(isInformativeCallerTurn("yes", "That's the pickup at the station, OK?", re)).toBe(false);
    expect(isInformativeCallerTurn("yes", "22 Godstone Road, is that right?", re)).toBe(false);
  });
  it("a yes to an offer is an answer", () => {
    expect(isInformativeCallerTurn("yes please", "Shall I put you down for the airport run?", re)).toBe(true);
    expect(isInformativeCallerTurn("yes", "Would you like me to add a child seat?", re)).toBe(true);
  });
  it("falls back to English for an unknown language and caches", () => {
    expect(readBackQuestionRe("fr")).toBe(readBackQuestionRe("en"));
    expect(readBackQuestionRe("es")).not.toBe(readBackQuestionRe("en"));
  });
});

describe("closers are not answers (LVX192 final review)", () => {
  const ANYTHING_ELSE = "Is there anything else I can help you with?";
  const closing = closingRegexFor({});

  it.each(["Ahm", "Ahm, nope.", "Não.", "No, it's good", "You too", "Alright", "Cheers mate", "No thanks, bye", "Yeah, cheers", "Nein."])(
    "%j after anything-else is not informative",
    (t) => {
      expect(isInformativeCallerTurn(t, ANYTHING_ELSE, undefined, closing)).toBe(false);
    }
  );

  it.each([
    "Ahm, it's 22 Godstone Road",
    "Yeah, two passengers",
    "No, but I need a child seat",
    "Cheers, and it's for Saturday",
    "No, and two bags",
    "No, but one more thing",
    "Nope, also a child seat",
    "Yeah",
    "Sure",
  ])("%j stays informative", (t) => {
    expect(isInformativeCallerTurn(t, ANYTHING_ELSE, undefined, closing)).toBe(true);
  });

  it("a bare yes to a yes/no question stays informative", () => {
    expect(isInformativeCallerTurn("yes", SEAT, undefined, closing)).toBe(true);
  });

  it("the closing regex covers both locales and is null-safe", () => {
    expect(closing.test("goodbye")).toBe(true);
    expect(closingRegexFor({ languagesSpoken: ["es"] })).toBeInstanceOf(RegExp);
  });

  it("the 12 Gemini 3.8 corpus replies to anything-else count 0 (the old predicate read 4 as answers)", () => {
    const replies = [
      "Ahm", "Ahm, nope.", "Não.", "Não.", "No.", "No.", "No.", "No.",
      "No, there's nothing else.", "No, thanks.", "No, that's all. Thank you.", "Aquí. No, nothing else.",
    ];
    expect(replies).toHaveLength(12);
    const turns = replies.map((caller, i) => ({ index: i + 1, caller, prevReply: ANYTHING_ELSE }));
    expect(countUnsaved(turns, 0, undefined, closing)).toBe(0);
  });

  it.each([
    "Nothing else, could the driver ring me at 07700 900123?",
    "I'm good, can you book me for Saturday at 6 too?",
    "That's all, is the fare 40 pounds?",
    "Nada más, ¿me puede llamar al 600 123 456?",
  ])("the question %j stays informative", (t) => {
    expect(isInformativeCallerTurn(t, ANYTHING_ELSE, undefined, closing)).toBe(true);
  });

  const YES_NO = ["Do you need a child seat?", "Will you need a return journey?", "Is that the right number for you?"];
  const YES_THANKS = ["Yeah, thanks", "Yep, cheers", "Sure, thanks", "Yeah, cheers mate", "Yep, ta", "Yeah, mate", "Right, cheers"];
  it.each(YES_THANKS)("%j after a yes/no question is informative", (t) => {
    for (const q of YES_NO) expect(isInformativeCallerTurn(t, q, undefined, closing)).toBe(true);
  });
  it.each(YES_THANKS)("%j after anything-else is a closer", (t) => {
    expect(isInformativeCallerTurn(t, ANYTHING_ELSE, undefined, closing)).toBe(false);
  });
});
