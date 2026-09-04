// ---------------------------------------------------------------------------
// LVX57 — the fabrication detector missed half the claims actually made.
//
// completionClaimRe is the instrument every other judgement about LVX27 is made
// with: the claim ledger, live_claim_without_action, and postcall_verify's
// whole verdict all start from whether this pattern matched. A claim it cannot
// see is a fabrication it cannot catch — and worse, postcall_verify then files
// `row_without_claim` on a call where a claim was plainly made, which is a
// false alarm that trains whoever reads it to ignore the instrument.
//
// That happened twice on consecutive calls.
//
// Measured against the four real phrasings observed on 2026-09-03, the pattern
// caught two. Both misses are ordinary English:
//
//   - any words between the noun and the verb defeat
//     `your\s+(?:appointment|booking|call)\s+(?:is|has been)` — so "the
//     appointment is now updated under Nathan Dodla" is invisible over one
//     article, and "Your appointment for Tuesday, September 8th, at 12 pm is
//     all set" is invisible over a date;
//   - "all set" defeats an alternation that lists "set".
//
// ---------------------------------------------------------------------------
// Does claim detection belong in a pattern at all?
// ---------------------------------------------------------------------------
//
// Honest answer, written here rather than left implied: no, and there is no
// better option available on this front-end.
//
// The alternative is to make the model state completions in a form the engine
// can recognise — a marker. That is exactly what VOICE_INTENT_MARKER does, and
// LVX37 is what it cost: the model spoke `<<intent:...>>` aloud on every
// deployed call and the leak guard shredded the audio. A second marker is a
// second chance at the same defect on the one path where the model IS the
// voice.
//
// So this widens, and the widening is bounded on purpose (a gap of at most
// three words, no free-running `.*`) so it cannot swallow a sentence that
// merely mentions an appointment. It fixes the phrasings observed. It cannot be
// completed, and no future reader should believe it has been.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { getStrings } from "../lib/voice/strings.js";

const en = getStrings({ languagesSpoken: ["en"] }).completionClaimRe;
const es = getStrings({ languagesSpoken: ["es"] }).completionClaimRe;

describe("completionClaimRe — the four phrasings measured on real calls", () => {
  // The table from the backlog, verbatim. Two of these were MISSES.
  const OBSERVED = [
    "Your appointment for Tuesday, September 8th, at 12 pm is all set.",
    "the appointment is now updated under Nathan Dodla and rescheduled to Friday, September 4th at 3 00 PM.",
    "Your appointment is set.",
    "you're all set",
  ];

  for (const said of OBSERVED) {
    it(`sees: ${said.slice(0, 52)}`, () => {
      expect(en.test(said)).toBe(true);
    });
  }
});

describe("completionClaimRe — other real completion shapes", () => {
  const CLAIMS = [
    "I've booked your free strategy call for 10 AM on Monday, September 7th.",
    "That's booked for you.",
    "I have cancelled that appointment.",
    "Your booking has been confirmed.",
    "That appointment is now cancelled.",
    "This appointment is rescheduled to Thursday.",
    "Your appointment on the 8th has been moved.",
    "I've put you down for Tuesday.",
  ];
  for (const said of CLAIMS) {
    it(`sees: ${said.slice(0, 52)}`, () => expect(en.test(said)).toBe(true));
  }
});

// ---------------------------------------------------------------------------
// The false positive the widening created, caught on the first real call after
// it shipped (call 4 of the verification round, 2026-09-04).
//
// Adding `the|that|this` to the third branch was necessary -- "the appointment
// is now updated" was one of the two measured misses -- and it immediately
// produced the mirror-image defect: `postcall_verify` reported
// `claim_without_row` on a call where nothing whatsoever had been claimed.
//
// A false alarm is the specific failure this whole entry warns about, because
// it trains whoever reads the ledger to ignore it. So it gets its own block
// rather than being folded into the negatives below.
// ---------------------------------------------------------------------------
describe("completionClaimRe — a relative clause is not a claim", () => {
  it("does not fire on the sentence that produced a false claim_without_row", () => {
    expect(
      en.test(
        "I apologize, I misread that. Since you're calling from a different number, " +
          "would you mind telling me the last four digits of the phone number the " +
          "appointment is booked under?"
      )
    ).toBe(false);
  });

  it("does not fire on the same shape in other phrasings", () => {
    // The phrase sits INSIDE a noun phrase, directly after another noun. That
    // position is what makes it a relative clause; the vocabulary is identical
    // to a real claim, so vocabulary cannot be the discriminator.
    expect(en.test("What is the phone number the appointment is booked under?")).toBe(false);
    expect(en.test("Can you confirm the name the appointment is booked under?")).toBe(false);
  });

  it("still fires when the same words start a clause", () => {
    expect(en.test("Okay, that appointment is booked.")).toBe(true);
    expect(en.test("the appointment is now updated under Nathan Dodla")).toBe(true);
  });
});

describe("completionClaimRe — what must NOT count as a completion", () => {
  // A claim guard that fires on ordinary conversation is worse than one that
  // misses: live_claim_without_action becomes noise, and with LIVE_CLAIM_GUARD
  // armed it would spend a turn note on nothing. Every one of these mentions an
  // appointment without asserting that anything is done.
  const NOT_CLAIMS = [
    "Would you like me to book that appointment for you?",
    "Your appointment is at three thirty.",
    "I can see your appointment for Friday the 4th.",
    "Shall I go ahead and book it?",
    "Let me check whether that appointment is still available.",
    "The appointment is with Doctor Bell.",
    "I'll book that for you now.",
    "Do you want that appointment cancelled?",
    "Your appointment is coming up on Tuesday.",
    "That appointment is for a check-up.",
    "I have your appointment here in front of me.",
    "Is your appointment the one on Friday?",
  ];
  for (const said of NOT_CLAIMS) {
    it(`ignores: ${said.slice(0, 52)}`, () => expect(en.test(said)).toBe(false));
  }
});

describe("completionClaimRe — the gap is bounded by the SENTENCE", () => {
  // The boundary that matters is not a word count, it is punctuation. What sits
  // between "your appointment" and "is set" on a real call is a date and a time
  // -- "for Tuesday, September 8th, at 12 pm" -- which is seven words and must
  // match. A long subordinate clause ending in "is set" is also a claim, so
  // counting words would exclude the wrong things.
  it("does not span a sentence boundary", () => {
    expect(en.test("Your appointment. I have not booked anything yet, it is not set.")).toBe(false);
    expect(en.test("Is that your appointment? It is not booked.")).toBe(false);
  });

  it("does not run away without limit", () => {
    const long = `Your appointment ${"and ".repeat(40)}is set.`;
    expect(en.test(long)).toBe(false);
  });

  it("still requires a completion verb, not merely a state", () => {
    expect(en.test("Your appointment for Tuesday at 12 pm is not confirmed yet.")).toBe(false);
    expect(en.test("Your appointment for Tuesday at 12 pm is still pending.")).toBe(false);
  });
});

describe("completionClaimRe — Spanish keeps its own phrasings", () => {
  it("sees a Spanish completion", () => {
    expect(es.test("Ya he reservado su cita para el martes.")).toBe(true);
    expect(es.test("Su cita está confirmada.")).toBe(true);
  });
  it("ignores a Spanish question", () => {
    expect(es.test("¿Quiere que reserve la cita?")).toBe(false);
  });
});
