import { describe, it, expect } from "vitest";
import { afterSaveNote, AFTER_SAVE_LABEL, deepgramHeardOnlyClosing } from "../lib/voice/afterSaveNote.js";
import { closingRegexFor } from "../lib/voice/unsavedAnswers.js";

const T = (index, caller, prevReply = "", voiced = false) => ({ index, caller, prevReply, voiced });

describe("afterSaveNote", () => {
  it("label is exact and within 60", () => {
    expect(AFTER_SAVE_LABEL).toBe("Said after the last save (unchecked transcript)");
    expect(AFTER_SAVE_LABEL.length).toBeLessThanOrEqual(60);
  });

  it("formats question and words, joined with ' / '", () => {
    const n = afterSaveNote({
      turnLog: [
        T(1, "old words", "Anything else?"),
        T(2, "By card please", "Great. How will you pay?"),
        T(3, "Two suitcases", "How much luggage? And is that all"),
      ],
      savedThroughTurn: 1,
    });
    expect(n.label).toBe(AFTER_SAVE_LABEL);
    expect(n.answer).toBe('"How will you pay?" — By card please / "How much luggage?" — Two suitcases');
  });

  it("no question in prevReply gives just the words", () => {
    const n = afterSaveNote({ turnLog: [T(2, "By card", "Noted.")], savedThroughTurn: 1 });
    expect(n.answer).toBe("By card");
  });

  it("skips closers, hesitations and a bare yes after a read-back", () => {
    expect(
      afterSaveNote({
        turnLog: [T(2, "no thanks", "Anything else?"), T(3, "um", "x"), T(4, "yes", "Is that right?")],
        savedThroughTurn: 1,
      })
    ).toBeNull();
  });

  it("voiced-but-empty is skipped without hiding other turns", () => {
    const n = afterSaveNote({ turnLog: [T(2, "", "q?", true), T(3, "card", "How pay?")], savedThroughTurn: 1 });
    expect(n.answer).toBe('"How pay?" — card');
    expect(afterSaveNote({ turnLog: [T(2, "", "q?", true)], savedThroughTurn: 1 })).toBeNull();
  });

  it("includes the in-flight turn unless the save covered it", () => {
    const inFlight = { caller: "by card", prevReply: "How will you pay?", voiced: false };
    expect(afterSaveNote({ turnLog: [T(1, "a b c", "")], savedThroughTurn: 1, inFlight }).answer).toBe(
      '"How will you pay?" — by card'
    );
    expect(afterSaveNote({ turnLog: [T(1, "a b c", "")], savedThroughTurn: 2, inFlight })).toBeNull();
  });

  it("caps the question at 80 and the answer at 500 on a word boundary", () => {
    const longQ = "Please tell me " + "very ".repeat(30) + "carefully how you will pay?";
    const n = afterSaveNote({ turnLog: [T(2, "card", longQ)], savedThroughTurn: 1 });
    const q = n.answer.match(/^"(.*)" — /)[1];
    expect(q.length).toBeLessThanOrEqual(80);
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const big = afterSaveNote({ turnLog: [T(2, words, "")], savedThroughTurn: 1 });
    expect(big.answer.length).toBeLessThanOrEqual(501);
    expect(big.answer.endsWith("…")).toBe(true);
    expect(big.answer.slice(0, -1)).toMatch(/word\d+$/);
  });

  it("null on empty input", () => {
    expect(afterSaveNote({ turnLog: [], savedThroughTurn: 0 })).toBeNull();
    expect(afterSaveNote()).toBeNull();
  });
});

// Fix round 2: the owner's 08:17 email carried a junk after-save line made of backchannels.
describe("afterSaveNote leaves backchannels out (fix round 2)", () => {
  it("'Mhm.' and 'N?o.' add nothing; a yes to a yes/no question is kept", () => {
    const n = afterSaveNote({
      turnLog: [
        T(2, "Mhm.", "Lovely, I've noted that down."),
        T(3, "N?o.", "Is there anything else I can help you with?"),
        T(4, "Yeah.", "Do you need a child seat?"),
      ],
      savedThroughTurn: 1,
    });
    expect(n.answer).toBe('"Do you need a child seat?" — Yeah.');
  });

  it("only backchannels gives no note at all", () => {
    expect(
      afterSaveNote({ turnLog: [T(2, "Mhm.", "Lovely, noted."), T(3, "Uh-huh.", "And where to?")], savedThroughTurn: 1 })
    ).toBeNull();
  });
});

// Hammersleys round 3: the junk lines from calls 7eab36, 6c0d37 and A.
describe("afterSaveNote skips end-of-call closers (round 3)", () => {
  const closingRe = closingRegexFor({});
  it("writes nothing for 'What', 'Ayer no' and 'No. There's nothing.'", () => {
    expect(
      afterSaveNote({
        turnLog: [
          T(2, "What", "Hello? Are you still there?"),
          T(3, "Ayer no", "Is there anything else I can assist you with today? Thank you for calling, and have a wonderful day."),
          T(4, "No. There's nothing.", "Is there anything else I can help with?"),
        ],
        savedThroughTurn: 1,
        closingRe,
      })
    ).toBeNull();
  });
  // Round 4 (call 3, CA…283a9a): the junk line '"Is there anything else I can
  // help with?" — esse'. A one-word reply to a wrap-up ask is not written.
  it("writes nothing for a one-word garble after the hand-off ask", () => {
    expect(
      afterSaveNote({
        turnLog: [
          T(9, "esse", "This has been passed to the dispatcher, who will confirm. Is there anything else I can help with?"),
        ],
        savedThroughTurn: 8,
        closingRe,
      })
    ).toBeNull();
  });
  it("still writes a real answer given at the end", () => {
    const n = afterSaveNote({
      turnLog: [T(2, "And I'll be paying with cash.", "Is there anything else I can help with?")],
      savedThroughTurn: 1,
      closingRe,
    });
    expect(n.answer).toBe('"Is there anything else I can help with?" — And I\'ll be paying with cash.');
  });
});

// ---------------------------------------------------------------------------
// Hammersleys round 6, item 3 (owner R54): round-5 call 1's caller said "No,
// that's it" (Deepgram heard it right), Live's side transcript wrote "No hace",
// and the email got 'Said after the last save ...: "...anything else...?" — No
// hace.' Where the Deepgram shadow covered the window after the last save and
// heard only a plain closing, no line. Anything else: today, byte for byte.
// ---------------------------------------------------------------------------
describe("round 6: Deepgram heard only a closing", () => {
  const closingRe = closingRegexFor({});
  const ASK = "That's passed to the dispatcher, who will confirm. Is there anything else?";
  const facts = (heardByDeepgram) => ({
    turnLog: [T(4, "Plaistow Street", "Where from?"), T(5, "No hace", ASK)],
    savedThroughTurn: 4,
    closingRe,
    ...(heardByDeepgram === undefined ? {} : { heardByDeepgram }),
  });

  it("today: the junk words become a line", () => {
    expect(afterSaveNote(facts()).answer).toBe('"Is there anything else?" — No hace');
  });

  it("covered, Deepgram heard 'No, that's it.': no line", () => {
    expect(deepgramHeardOnlyClosing(facts({ covered: true, texts: ["No, that's it."] }))).toBe(true);
    expect(afterSaveNote(facts({ covered: true, texts: ["No, that's it."] }))).toBeNull();
  });

  it("covered, a closing in pieces ('No.' / 'That's all, thanks.'): no line", () => {
    expect(afterSaveNote(facts({ covered: true, texts: ["No.", "That's all, thanks."] }))).toBeNull();
  });

  it("covered, Deepgram also heard a detail: the line stays, as today (Review Focus 5)", () => {
    const f = facts({ covered: true, texts: ["No, that's it.", "Oh, two cases."] });
    expect(deepgramHeardOnlyClosing(f)).toBe(false);
    expect(afterSaveNote(f)).toEqual(afterSaveNote(facts()));
  });

  it("not covered: today", () => {
    expect(afterSaveNote(facts({ covered: false, texts: ["No, that's it."] }))).toEqual(afterSaveNote(facts()));
  });

  it("covered but Deepgram heard nothing: today", () => {
    expect(afterSaveNote(facts({ covered: true, texts: [] }))).toEqual(afterSaveNote(facts()));
  });

  it("no Deepgram input at all: byte-identical", () => {
    expect(JSON.stringify(afterSaveNote(facts(undefined)))).toBe(JSON.stringify(afterSaveNote(facts())));
  });
});
