import { describe, it, expect } from "vitest";
import { DEMO_CALL } from "../site/content/demoCall.js";
import { findActiveWordIndex, groupIntoTurns, turnIndexForWord } from "../site/components/transcriptIndex.js";

function turnTextAt(t) {
  const { words } = DEMO_CALL.transcript;
  const turns = groupIntoTurns(words);
  const i = findActiveWordIndex(words, t + 0.01);
  const turn = turns[turnIndexForWord(turns, i)];
  return words.slice(turn.from, turn.to).map((w) => w.w).join(" ");
}

describe("the demo call's diary moments line up with the transcript", () => {
  it("offers the slots at offeredAt", () => {
    const text = turnTextAt(DEMO_CALL.moments.offeredAt);
    expect(text).toMatch(/availability/i);
    expect(text).toMatch(/Friday, June 5 at 2PM/);
  });

  it("confirms the booking at bookedAt", () => {
    const text = turnTextAt(DEMO_CALL.moments.bookedAt);
    expect(text).toMatch(/booked for Friday, June 5 at 2PM/);
    expect(text).toMatch(new RegExp(DEMO_CALL.booking.who.split(" ")[0]));
  });

  it("names the receptionist as the first speaker", () => {
    const { words, speakers } = DEMO_CALL.transcript;
    expect(speakers[String(words[0].speaker)]).toBe("Vetra");
  });
});
