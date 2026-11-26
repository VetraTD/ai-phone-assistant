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

// Fix round 2 (owner's 08:17 call, 2026-11-24): "Mhm." and "N?o." counted as
// answers, so the save guard refused a goodbye that had nothing left to save.
describe("backchannels and mangled words are not answers (fix round 2)", () => {
  const ANYTHING_ELSE = "Is there anything else I can help you with?";
  const closing = closingRegexFor({});
  const NOTED = "Lovely, I've noted that down.";
  const WH = "And where would you like to go?";

  it.each(["Mhm.", "Yeah.", "N?o.", "Mm-hmm.", "Uh-huh.", "Uh huh.", "Yep.", "Mhm, yeah."])(
    "%j after anything-else is not informative",
    (t) => {
      expect(isInformativeCallerTurn(t, ANYTHING_ELSE, undefined, closing)).toBe(false);
    }
  );

  it.each(["Mhm.", "Yeah.", "Mm-hmm.", "Uh-huh.", "Yep."])("%j after a statement or a wh-question is not informative", (t) => {
    expect(isInformativeCallerTurn(t, NOTED, undefined, closing)).toBe(false);
    expect(isInformativeCallerTurn(t, WH, undefined, closing)).toBe(false);
    expect(isInformativeCallerTurn(t, "Anything else?", undefined, closing)).toBe(false);
  });

  it.each(["Mhm.", "Yeah.", "Mm-hmm."])("%j after a read-back is not informative", (t) => {
    expect(isInformativeCallerTurn(t, READ_BACK, undefined, closing)).toBe(false);
  });

  it.each(["Mhm.", "Yeah.", "Uh-huh.", "Yep."])("%j answering a yes/no question stays informative", (t) => {
    expect(isInformativeCallerTurn(t, SEAT, undefined, closing)).toBe(true);
    expect(isInformativeCallerTurn(t, "Great. And will you need a return journey?", undefined, closing)).toBe(true);
  });

  it("a word with a ? inside is read as the word ('N?o' is 'No')", () => {
    expect(isInformativeCallerTurn("N?o.", ANYTHING_ELSE, undefined, closing)).toBe(false);
    expect(isInformativeCallerTurn("N?o, two passengers.", SEAT, undefined, closing)).toBe(true);
  });

  it("the after-anything-else count stays 0 with the backchannels added", () => {
    const replies = ["Mhm.", "Yeah.", "N?o.", "No.", "Uh-huh."];
    const turns = replies.map((caller, i) => ({ index: i + 1, caller, prevReply: ANYTHING_ELSE }));
    expect(countUnsaved(turns, 0, undefined, closing)).toBe(0);
  });
});

// Opus review I2 / M4 / M5 (fix round 2).
describe("a backchannel answers any question that is not a wh-question (review fixes)", () => {
  const closing = closingRegexFor({});

  it.each([
    ["Yeah", "Lovely. Just the two of you?"],
    ["Yeah", "Child seat?"],
    ["Yep", "Paying by card?"],
    ["Yeah", "And that is from the station?"],
    ["Yeah", "So two passengers and two bags?"],
    ["Yeah", "Don't you need a return?"],
    ["Mhm", "¿Necesita una silla de niño?"],
  ])("I2: %j after %j is an answer", (t, q) => {
    expect(isInformativeCallerTurn(t, q, undefined, closing)).toBe(true);
  });

  it.each([
    ["Mhm", "And how many passengers?"],
    ["Yeah", "Great, what's the pickup address?"],
    ["Mhm", "¿Cuántos pasajeros?"],
    ["Yeah", "¿Dónde le recogemos?"],
  ])("I2: %j after the wh-question %j is not", (t, q) => {
    expect(isInformativeCallerTurn(t, q, undefined, closing)).toBe(false);
  });

  it.each([
    ["Okay.", "Is that everything?"],
    ["Okay.", "Will that be all?"],
    ["Yeah.", "Is that all for today?"],
    ["Mhm.", "Is there anything more I can do?"],
    ["Okay.", "Do you need a child seat?"],
  ])("M4: %j after %j is not an answer (ok stays a closer; closing questions do not count)", (t, q) => {
    expect(isInformativeCallerTurn(t, q, undefined, closing)).toBe(false);
  });

  it("M5: a read-back earlier in the reply does not hide the yes/no question that ends it", () => {
    expect(isInformativeCallerTurn("Yeah", "22 Godstone Road, is that right? And do you need a child seat?", undefined, closing)).toBe(true);
    expect(isInformativeCallerTurn("Yeah", "And do you need a child seat? 22 Godstone Road, is that right?", undefined, closing)).toBe(false);
  });
});

// Opus re-review minors (fix round 2).
describe("questions a 'yeah' cannot answer, and wrap-ups anchored at the end (re-review)", () => {
  const closing = closingRegexFor({});
  it.each([
    "Can you tell me where you are going?",
    "Do you know what time your flight is?",
    "Could you tell me the postcode?",
    "Can you hear me?",
    "Are you still there?",
    "Could you say that again?",
    "Could you spell that for me?",
  ])("'Yeah' after %j is not an answer", (q) => {
    expect(isInformativeCallerTurn("Yeah", q, undefined, closing)).toBe(false);
  });

  it.each(["Is that all of your luggage?", "Will that be all three of you?"])("'Yeah' after %j is an answer", (q) => {
    expect(isInformativeCallerTurn("Yeah", q, undefined, closing)).toBe(true);
  });

  it.each(["Will that be all?", "Is that all for today?", "Is that everything?"])("'Yeah' after the wrap-up %j is not", (q) => {
    expect(isInformativeCallerTurn("Yeah", q, undefined, closing)).toBe(false);
  });
});

// Hammersleys round 3 (2026-11-26). Three caller lines from real call endings
// counted as unsaved answers: they blocked the goodbye through the save guard
// AND reached the owner's email as "Said after the last save" junk lines.
//   7eab36  "Are you still there?" -> "What"
//   6c0d37  "…anything else? … wonderful day." -> "Ayer no"   (ASR garble of "no")
//   call A  "anything else?" -> "No. There's nothing."
describe("closer answers at the end of a call are not answers (round 3)", () => {
  const closing = closingRegexFor({});
  const HANDOFF_ASK = "Your request has been passed to our dispatcher, who will confirm. Is there anything else I can help you with today?";
  const NUDGE = "Hello? Are you still there?";
  const ASK_AND_BYE =
    "Is there anything else I can assist you with today? Thank you for calling, and I hope you have a wonderful day.";

  it("'No. There's nothing.' after anything-else is a closer", () => {
    expect(isInformativeCallerTurn("No. There's nothing.", HANDOFF_ASK, undefined, closing)).toBe(false);
  });

  it.each(["What", "What?", "Sorry?", "Pardon?", "Hello?"])("a lone %j carries nothing to save", (t) => {
    expect(isInformativeCallerTurn(t, NUDGE, undefined, closing)).toBe(false);
    expect(isInformativeCallerTurn(t, SEAT, undefined, closing)).toBe(false);
  });

  it.each([ASK_AND_BYE, NUDGE])("'Ayer no' after %j is a closer", (prev) => {
    expect(isInformativeCallerTurn("Ayer no", prev, undefined, closing)).toBe(false);
  });

  // Opus review I3: the hand-off reply now reads the trip back AND asks
  // "anything else?" (owner ruling R16), so a two-word correction to it must
  // stay an answer -- the no has to come last, after a goodbye or a nudge.
  it.each(["No, Gatwick", "No, Friday", "No, cash", "No, tomorrow", "Nope, Redhill", "No. Gatwick."])(
    "the correction %j stays informative after the hand-off ask, a nudge, or ask+goodbye",
    (t) => {
      for (const prev of [HANDOFF_ASK, NUDGE, ASK_AND_BYE]) {
        expect(isInformativeCallerTurn(t, prev, undefined, closing)).toBe(true);
      }
    }
  );
  it("after a plain anything-else (no goodbye), 'Ayer no' stays informative: the cost is a re-save, never a lost answer", () => {
    expect(isInformativeCallerTurn("Ayer no", HANDOFF_ASK, undefined, closing)).toBe(true);
  });

  // Controls: the same words where they DO answer something, and real content.
  it("'Ayer no' answering a yes/no question stays informative (it is the answer no)", () => {
    expect(isInformativeCallerTurn("Ayer no", SEAT, undefined, closing)).toBe(true);
  });
  it.each([
    "And I'll be paying with cash.",
    "No, two cases actually",
    "No, there's two of us",
    "No, two",
    "What time will the driver come?",
  ])("%j after anything-else stays informative", (t) => {
    expect(isInformativeCallerTurn(t, HANDOFF_ASK, undefined, closing)).toBe(true);
  });
  it("'Yes, Saturday at 7' after a nudge stays informative", () => {
    expect(isInformativeCallerTurn("Yes, Saturday at 7", NUDGE, undefined, closing)).toBe(true);
  });
});

// Hammersleys round 4 (call 3, CA…283a9a): "No, thanks" to the hand-off's
// "Is there anything else I can help with?" came through as "esse". It counted
// as an unsaved answer: end_call was refused, the goodbye went silent (17 s
// ending) and the email got the junk line '"Is there anything else…" — esse'.
// Measured on 50 replies to a wrap-up ask (34 fixtures + 33 prod calls): 19
// were one word with no digit -- 15 "no", "nope", "mhm", "na", "esse" -- and
// none carried a detail. Ruling R30: after a wrap-up ask, a nudge or a goodbye,
// a one-word turn with no number in it carries nothing to save.
describe("a one-word reply to 'anything else?' is not an answer (round 4)", () => {
  const closing = closingRegexFor({});
  const HANDOFF_ASK = "That's passed to the dispatcher, who will confirm. Is there anything else I can help with?";
  const READBACK_HANDOFF =
    "Got it, just one passenger. Your request is for a trip from five Plaistow Street, Lingfield to Oxted Station on Friday at eight in the morning. This has been passed to the dispatcher, who will confirm. Is there anything else I can help with?";
  const NUDGE = "Hello? Are you still there?";
  const ASK_AND_BYE =
    "Is there anything else I can assist you with today? Thank you for calling, and I hope you have a wonderful day.";

  it.each(["esse", "Esse.", "na", "Na.", "Eu"])("%j after the hand-off ask carries nothing", (t) => {
    for (const prev of [HANDOFF_ASK, READBACK_HANDOFF, ASK_AND_BYE]) {
      expect(isInformativeCallerTurn(t, prev, undefined, closing)).toBe(false);
    }
  });
  // Opus review I4: after "Are you still there?" the likely reply is the answer
  // to the question still pending -- not covered by the 19/50 measurement.
  it("review I4: one word after a nudge stays an answer", () => {
    expect(isInformativeCallerTurn("Tuesday.", NUDGE, undefined, closing)).toBe(true);
  });
  // Opus review I3: a read-back check is not a wrap-up, even with "everything" in it.
  it("review I3: one word after a read-back check stays an answer", () => {
    const prev = "So that's 5 Plaistow Street to Gatwick on Friday at eight. Did I get everything right?";
    expect(isInformativeCallerTurn("Heathrow.", prev, readBackQuestionRe("en"), closing)).toBe(true);
    expect(isInformativeCallerTurn("Heathrow.", prev)).toBe(true);
  });
  it("review I3: 'anything more about the problem?' is not a wrap-up", () => {
    expect(isInformativeCallerTurn("Leaking.", "Is there anything more about the problem?", undefined, closing)).toBe(true);
  });
  // Review M4: the fillers stripped before the checks know Live's umm spellings.
  it("review M4: 'Uhm, nope.' and 'Ehm, nope.' after anything-else are closers", () => {
    for (const t of ["Uhm, nope.", "Ehm, nope."]) expect(isInformativeCallerTurn(t, HANDOFF_ASK, undefined, closing)).toBe(false);
  });
  it("accepted edge (R30): a lone 'Cash.' after anything-else is not listed either", () => {
    expect(isInformativeCallerTurn("Cash.", HANDOFF_ASK, undefined, closing)).toBe(false);
  });
  it("works without the locale closing regex too (English wrap-up words)", () => {
    expect(isInformativeCallerTurn("esse", HANDOFF_ASK)).toBe(false);
  });

  // Controls: one word that answers a real question, a number, two words.
  it.each([
    ["Cash.", "How will you be paying?"],
    ["Gatwick", "Where would you like to go?"],
    ["Smith", "What's your surname?"],
    ["esse", "What's your name, please?"],
  ])("%j answering %j stays informative", (t, prev) => {
    expect(isInformativeCallerTurn(t, prev, undefined, closing)).toBe(true);
  });
  it.each(["Sure", "Yes.", "Right", "Absolutely"])("a yes (%j: more is coming) after anything-else stays informative", (t) => {
    expect(isInformativeCallerTurn(t, HANDOFF_ASK, undefined, closing)).toBe(true);
  });
  it.each(["Two", "two.", "5", "Three"])("the number %j after anything-else stays informative", (t) => {
    expect(isInformativeCallerTurn(t, HANDOFF_ASK, undefined, closing)).toBe(true);
  });
  it.each(["Yes, Gatwick", "No, Gatwick", "Friday instead"])("two words %j after anything-else stay informative", (t) => {
    expect(isInformativeCallerTurn(t, HANDOFF_ASK, undefined, closing)).toBe(true);
  });
  it("countUnsaved: the call-3 ending has nothing unsaved", () => {
    const turns = [{ index: 9, caller: "esse", prevReply: READBACK_HANDOFF }];
    expect(countUnsaved(turns, 8, undefined, closing)).toBe(0);
  });
});
