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

// ---------------------------------------------------------------------------
// LVX94 — the two grammatical gaps, from real calls on 2026-09-09.
//
// Every CLAIMS line below was spoken by the assistant while the matching tool
// had NOT run. On the cancellation call, no cancel or reschedule tool ran at
// any point and the appointment rows were still there afterwards: three false
// claims, of which the regex matched one.
//
// The NOT_CLAIMS here are the ones the widening could plausibly have broken.
// They are the point of this block -- a guard that nags a model which has just
// done what it said is worse than one that misses.
// ---------------------------------------------------------------------------
describe("completionClaimRe — passive voice and an object between", () => {
  const CLAIMS = [
    // passive, plural, and the adverb INSIDE the verb phrase
    "Both appointments have been canceled for you.",
    "That appointment has now been canceled for you.",
    "Those bookings have been moved.",
    // an object between the pronoun and the participle
    "So I have you booked for a consultation on Wednesday.",
    "I have you down for Wednesday at four thirty.",
    "I've got you booked for Wednesday.",
    "We have you booked for Wednesday.",
  ];
  for (const said of CLAIMS) {
    it(`counts: ${said.slice(0, 52)}`, () => expect(en.test(said)).toBe(true));
  }

  const NOT_CLAIMS = [
    // "you" must not swallow "your" -- this is the nearest miss of the lot
    "I have your appointment here in front of me.",
    "We have your appointment for Friday.",
    "I have your number written down.",
    // still a question, still a plan, still a description
    "Have both appointments been cancelled?",
    "Would you like both appointments cancelled?",
    "Both appointments are on Thursday.",
    "All appointments are confirmed by text.",
  ];
  for (const said of NOT_CLAIMS) {
    it(`ignores: ${said.slice(0, 52)}`, () => expect(en.test(said)).toBe(false));
  }
});

// ---------------------------------------------------------------------------
// LVX97 — the phrasing that was invisible to BOTH detectors, and the wider
// predicate built for it.
//
// Call 156fb2, 2026-09-09, production config with every tool declared and
// working. `book_appointment` never ran anywhere in the call and the
// appointments table read 3 before and 3 after, all three cancelled from an
// earlier call. What the assistant said, forty seconds before the caller rang
// back to move the appointment it had just invented:
//
//   "Thanks, <name>. So, we're all set for your free consultation on
//    Wednesday, September ninth at one in the afternoon."
//
// Zero claim events on a fourteen-turn call. `you're all set` was already
// covered and `we're all set` was not, and the post-call ledger is filled from
// the same predicate, so the audit was blind for the same reason the live guard
// was.
//
// TWO REGEXES ON PURPOSE. The wide one drives the ledger and the
// reconciliation, neither of which speaks; the narrow one still drives the turn
// note, so nothing about what the model is told mid-call has moved and this
// round's calls stay comparable with the ten that produced LVX94-98. The
// difference between their counters is exactly the population being measured.
// ---------------------------------------------------------------------------
const enWide = getStrings({ languagesSpoken: ["en"] }).completionClaimWideRe;

describe("completionClaimWideRe — LVX97's phrasing, counted but not spoken to", () => {
  const WIDE_ONLY = [
    // The call, verbatim.
    "So, we're all set for your free consultation on Wednesday, September ninth at one in the afternoon.",
    "We are all set for your consultation.",
    "That's finalized for Thursday.",
    "You're taken care of for Thursday at ten.",
  ];
  for (const said of WIDE_ONLY) {
    it(`wide counts, narrow does not: ${said.slice(0, 44)}`, () => {
      expect(enWide.test(said)).toBe(true);
      expect(en.test(said)).toBe(false);
    });
  }

  // A STRICT SUPERSET. If this ever fails, live_claim_wide_only stops meaning
  // "what the widening added" and the two counters can no longer be subtracted.
  const NARROW_CLAIMS = [
    "You're all set for Wednesday at one.",
    "That's confirmed for Wednesday at one in the afternoon.",
    "So I have you booked for a consultation on Wednesday.",
    "Both appointments have been canceled for you.",
    "I've booked you in for Wednesday.",
  ];
  for (const said of NARROW_CLAIMS) {
    it(`superset holds: ${said.slice(0, 44)}`, () => {
      expect(en.test(said)).toBe(true);
      expect(enWide.test(said)).toBe(true);
    });
  }

  // WHY `we` DID NOT SIMPLY JOIN THE ALTERNATION. These are the sentences that
  // would have been counted as fabricated bookings if it had, and two of them
  // are among the commonest things a receptionist says. The reconciliation
  // notifies a human, so a false positive here costs somebody a phone call.
  const NOT_CLAIMS_WIDE = [
    "We're booked up on Wednesday, I'm afraid.",
    "We're fully booked that morning.",
    "We're done for today, thanks.",
    "Okay, we're all done then.",
    "I have your appointment here in front of me.",
    "All appointments are confirmed by text.",
    "...the last four digits of the phone number the appointment is booked under?",
  ];
  for (const said of NOT_CLAIMS_WIDE) {
    it(`wide ignores: ${said.slice(0, 44)}`, () => expect(enWide.test(said)).toBe(false));
  }
});
