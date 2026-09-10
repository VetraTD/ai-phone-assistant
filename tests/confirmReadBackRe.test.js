// ---------------------------------------------------------------------------
// confirmReadBackRe — the write-order gate's first half.
//
// There was no test file for this regex until LVX107, which is part of why it
// went three sessions without anyone noticing it had the same defect as
// signOffRe and nameReadBackRe: an alternation that assumed two words sit next
// to each other, defeated by an ordinary English word between them.
//
// WHY A MISS HERE IS NOT COSMETIC. services/tools.js sets
//
//     readBackKey = readBackMade ? textFingerprint(lastReplyText) : "none"
//
// so when no read-back is recognised every attempt hashes to the same key,
// `sameProposal` stays true, and WRITE_ORDER_MAX_REFUSALS depletes. A phrasing
// this regex cannot see therefore SPENDS the escape-hatch allowance that LVX104
// exists to protect — and LVX104 is the entry about that budget being burned by
// two refusals that were both correct.
//
// The negatives matter in the opposite direction to the claim detector's. A
// false positive here tells the gate a proposal was read back when it was not,
// and a write goes through on a caller's "yes" to a different question.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { getStrings } from "../lib/voice/strings.js";

const en = getStrings({ languagesSpoken: ["en"] }).confirmReadBackRe;
const es = getStrings({ languagesSpoken: ["es"] }).confirmReadBackRe;

describe("confirmReadBackRe — the phrasings the gate already recognised", () => {
  const READ_BACKS = [
    "Just to confirm, shall I go ahead and book that for you?",
    "Just to confirm, you'd like to cancel all three?",
    "To confirm, I will move that to Thursday.",
    "Is that right?",
    "Is that correct?",
    "Does that sound right?",
    "Did I get that right?",
    "Have I got that right?",
    "Shall I go ahead and book that?",
    "Would you like me to go ahead?",
    "Are you happy for me to book it?",
  ];
  for (const said of READ_BACKS) {
    it(`recognises: ${said.slice(0, 46)}`, () => expect(en.test(said)).toBe(true));
  }
});

// ---------------------------------------------------------------------------
// LVX107. Both of these were spoken in ONE turn on call CAe1bad30e, 2026-09-10:
//
//   "Thanks, Nitin. JUST TO MAKE SURE I HAVE THAT RIGHT, that's
//    N I T I N D O T L A? And I'm booking that for tomorrow, Friday,
//    September 11th, at 1 30 PM. IS THAT ALL CORRECT?"
//
// It is a textbook read-back and the gate recorded readBackMade=false.
// ---------------------------------------------------------------------------
describe("confirmReadBackRe — LVX107, a word in the middle", () => {
  const READ_BACKS = [
    "Is that all correct?",
    "Is that all right?",
    "So, is that all correct?",
    "Does that all sound right?",
    "Just to make sure I have that right, you'd like Thursday at two?",
    "To make sure I have everything right, Thursday at two under Nithin.",
    "Just to double-check I have that correct, Thursday at two?",
    // live, CAa688b2b1 and CA21496ee — the same idiom, two more calls.
    "Okay, just to make sure I have this right, you want to cancel both the appointment for Tuesday, September 15th and the one for Wednesday, September 16th? Should I go ahead and do that?",
    "Got it, thanks for confirming the name. So, to make sure I have this right, you're canceling your appointment on Monday, September 14th, and moving it to Tuesday, September 15th at 10 am, booked under Nithin Dodla. Shall I go ahead and make those changes?",
  ];
  for (const said of READ_BACKS) {
    it(`recognises: ${said.slice(0, 46)}`, () => expect(en.test(said)).toBe(true));
  }

  // A DETAIL read-back is not a PROPOSAL read-back. Counting a spelling check as
  // the proposal is precisely LVX104's call, where the released write landed on
  // a turn whose only content was a spelled name.
  const NOT_READ_BACKS = [
    "Is that name correct?",
    "Is that the name correct?",
    "Just to make sure I have your name right, is it N-I-T-H-I-N?",
    "To make sure I have the spelling right, is that with an H?",
    "Is that number correct?",
    "Is that the correct spelling of your name?",
  ];
  for (const said of NOT_READ_BACKS) {
    it(`ignores a detail check: ${said.slice(0, 40)}`, () => expect(en.test(said)).toBe(false));
  }

  // The clause-terminal guard. Found by running the candidate against fixtures,
  // not by reading it: the one-word gap reaches an ATTRIBUTIVE adjective, and
  // "the right number" is not a confirmation of anything.
  const ATTRIBUTIVE = [
    "Is that the right number to reach you on?",
    "Is that the right day for you or would another suit better?",
  ];
  for (const said of ATTRIBUTIVE) {
    it(`ignores an attributive adjective: ${said.slice(0, 40)}`, () =>
      expect(en.test(said)).toBe(false));
  }

  // Ordinary turns. If any of these read as a confirmation the gate stops
  // gating: the model would only have to say them before a write.
  const ORDINARY = [
    "You have three appointments coming up.",
    "I'm not finding any upcoming appointments under this number.",
    "What day were you thinking of?",
    "We have some openings on Thursday.",
    "Could you spell your name for me?",
  ];
  for (const said of ORDINARY) {
    it(`ignores: ${said.slice(0, 46)}`, () => expect(en.test(said)).toBe(false));
  }
});

describe("confirmReadBackRe — Spanish is untouched by the widening", () => {
  it("recognises the Spanish read-back", () =>
    expect(es.test("Para confirmar, ¿procedo con la cita del martes?")).toBe(true));
  it("ignores an ordinary Spanish turn", () =>
    expect(es.test("Tiene tres citas próximas.")).toBe(false));
});
