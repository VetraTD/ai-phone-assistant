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

// ---------------------------------------------------------------------------
// THE OBJECT IS A NOUN PHRASE, NOT ALWAYS THE WORD "you". 2026-09-09, and it
// cost a fabricated booking that every detector slept through.
//
// Call CAc19ef8, on the current revision. `book_appointment` never ran, no row
// was created, and the assistant said:
//
//   "Thanks, Nithin Dodla. I have a consultation booked for you for Tuesday,
//    September fifteenth at four thirty PM."
//
// LVX94 fixed exactly this shape -- an object between the pronoun and the
// participle -- but only for the pronoun `you`. "a consultation" sits in the
// same slot and slipped through, and so does "an appointment", which is the
// word the guard is most obviously about.
//
// The second gap is per-tenant and worth stating: `consultation` was not in the
// noun list at all, and it is Brightwork Studio's actual service name. The most
// likely booking noun for this tenant was invisible to the guard watching its
// bookings.
//
// WIDENED IN BOTH PREDICATES, not just the wide one. The narrow predicate is
// what drives CLAIM_NOTE, and a claim nobody tells the model about is a claim
// it cannot retract. The count-first ladder was the right call while a
// behaviour baseline was in flight; that round is over and this phrasing has a
// fabricated booking behind it.
// ---------------------------------------------------------------------------
describe("completionClaimRe — a noun phrase between 'I have' and the verb", () => {
  const CLAIMS = [
    // The call, verbatim.
    "Thanks, Nithin Dodla. I have a consultation booked for you for Tuesday, September fifteenth at four thirty PM.",
    "I have an appointment booked for you.",
    "I have a booking scheduled for you on Tuesday.",
    "I have your appointment booked for Thursday.",
    // The tenant's own noun, in the third branch.
    "Your consultation is booked for Tuesday.",
  ];
  for (const said of CLAIMS) {
    it(`counts: ${said.slice(0, 46)}`, () => {
      expect(en.test(said)).toBe(true);
      expect(enWide.test(said)).toBe(true);
    });
  }

  // The widening admits a determiner plus up to two words before the verb, so
  // these are the sentences that decide whether it went too far. The first is
  // the nearest miss in the whole file and has guarded this pattern since LVX57.
  const NOT_CLAIMS = [
    "I have your appointment here in front of me.",
    "I have a few times available on Tuesday.",
    "I have a question about that.",
    "I have the details of our services here.",
    "We have your appointment for Friday.",
    "All appointments are confirmed by text.",
  ];
  for (const said of NOT_CLAIMS) {
    it(`ignores: ${said.slice(0, 46)}`, () => {
      expect(en.test(said)).toBe(false);
      expect(enWide.test(said)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// LVX107 — THE GENERAL FORM, AND THE CALLS THAT WROTE IT.
//
// The object slot had been widened three times for three object shapes and was
// about to be widened a fourth. It is now one rule: any 1-3 word run not headed
// by a closed-class function word, followed by an UNAMBIGUOUS booking
// participle. See buildCompletionClaimRe in lib/voice/strings.js.
//
// Everything in this block marked "live" is a verbatim assistant turn from the
// production calls of 2026-09-10, taken off `live_debug_assistant_turn` on
// revision voice-uk-prod-00026-zvl. They are better fixtures than invented ones
// because they are what this tenant's model actually says, and three of them
// are the reason `postcall_verify` returned `row_without_claim` with claims: 0
// on a call whose booking was entirely real.
// ---------------------------------------------------------------------------
describe("completionClaimRe — LVX107, the general object form", () => {
  const CLAIMS = [
    // The shape LVX107 was filed for: a bare proper name, no determiner.
    "I have Priya Raghunathan scheduled.",
    "I have Priya Raghunathan scheduled for Thursday at two.",
    // live, CAa688b2b1 — the proper name, and then a pronoun that is not `you`.
    "Okay, so I have Priya Raghunathan scheduled for a free consultation on Friday, September 11th, at 10 AM. Is there anything else she'd like me to note for the appointment?",
    "Thanks, Priya. I have her scheduled for Friday, September 11th, at 10 AM for a consultation. Is there anything else I can help you with?",
    // live, CAe1bad30e — the call that returned row_without_claim. Two claims in
    // one turn, and the old predicate saw neither: "that's ALL done" (the
    // determiner sat between the copula and the predicate) and a subject of
    // `you` rather than `I`/`we`.
    "Perfect, that's all done. So you now have a consultation scheduled for Monday, September 14th, at 1 PM. Can I help you with anything else today?",
    // The object may be a time or a slot, which needs digits in the run.
    "I have your slot booked for Thursday.",
    "I have the 10 AM booked for you.",
  ];
  for (const said of CLAIMS) {
    it(`counts: ${said.slice(0, 46)}`, () => {
      expect(en.test(said)).toBe(true);
      expect(enWide.test(said)).toBe(true);
    });
  }

  // A loose object slot reaches ordinary speech, and these are the sentences
  // that prove it did not. The first two are why `moved|recorded|sent` were NOT
  // promoted into the loose slot alongside the booking participles — with them
  // there, both of these read as fabricated bookings.
  const NOT_CLAIMS = [
    "I have your message recorded for the team.",
    "I have your details sent over to them.",
    // Negation. Without `not`/`never` in the stopword list this is a claim, and
    // it is the sentence the model says when the claim guard has just corrected
    // it — so a false positive here feeds the loop LVX98 is about.
    "I have not booked that yet.",
    "My apologies, I haven't actually booked that yet.",
    // A third party's booking is not the caller's.
    "I have another client booked at that time.",
    "I have two people scheduled ahead of you.",
    "I have some slots booked already, but Tuesday is free.",
    "I have to get that booked for you.",
    "I have nothing scheduled for you at the moment.",
    // The `you have` subject is new, so the question form has to be excluded:
    // this is the assistant ASKING, and it must not read as claiming.
    "Do you have that appointment booked already?",
    "Did you have a consultation booked with us before?",
    // live, CAe1bad30e / CAa688b2b1 — offers and proposals from the same calls
    // as the positives above. Every one of these ran no write and must not.
    "Sure, for Monday, September 14th, I have openings at 9 AM, 1 PM, or 4 30 PM. Do any of those work for you?",
    "On Friday, September 11th, I have an opening at 10 in the morning. Does that work for your colleague?",
    "I have openings on both Thursday, September 10th, and Friday, September 11th. Do any of those days work for you?",
    // live — "I have that SET for tomorrow" is a proposal; the very next
    // sentence asks permission. `set` is deliberately absent from the loose
    // verb list for exactly this reason.
    "Okay, let me correct that ? Nithin Dodla, spelled N I T H I N, Dodla, D O D L A. I have that set for tomorrow, Friday, September 11th, at 1 30 PM. Shall I go ahead and book that?",
    // live — in-progress, not complete.
    "Okay, so I'm booking Monday, September 14th, at 1 PM for Nithin Dodla. Just to confirm, this is in addition to your other appointment on September 11th?",
    // live — reading an EXISTING row back to the caller.
    "Sure thing. I see you have an upcoming appointment with Priya Raghunathan on Friday, September 11th at 10 AM. Did you want to add something to that, or were you looking to book a separate consultation?",
    "Of course. Just so you know, Venkat has an appointment on September 15th and another on September 16th. Are you booking something new, or adding to one of those?",
  ];
  for (const said of NOT_CLAIMS) {
    it(`ignores: ${said.slice(0, 46)}`, () => {
      expect(en.test(said)).toBe(false);
      expect(enWide.test(said)).toBe(false);
    });
  }

  // LVX97 shipped as two hand-maintained literals and drifted: one alternation
  // was present in the wide copy and absent from the narrow one. Both are now
  // assembled from the same pieces, so assert the property directly rather than
  // trusting that the next person edits both.
  it("the wide predicate is a superset of the narrow one", () => {
    const everything = [...CLAIMS, ...NOT_CLAIMS];
    for (const said of everything) {
      if (en.test(said)) expect(enWide.test(said)).toBe(true);
    }
  });
});
