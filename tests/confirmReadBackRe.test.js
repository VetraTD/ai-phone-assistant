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

// ---------------------------------------------------------------------------
// THE REGRESSION THE FIX ITSELF CAUSED, caught on the next call after deploying.
//
// The clause-terminal guard was applied to BOTH the adjacent and the gapped
// form. Adjacent needs no guard -- nothing can sit between the words to change
// their meaning -- and applying it there silently narrowed four phrasings that
// had matched for months, because the adjective no longer ended the clause.
//
// A miss here is not cosmetic: services/tools.js keys the escape-hatch budget to
// "none" when no read-back is recognised, so the ceiling depletes. A fix for
// LVX107 had started causing the exact harm LVX107 is about.
// ---------------------------------------------------------------------------
describe("confirmReadBackRe — the adjective need not end the clause", () => {
  const READ_BACKS = [
    "Is that correct for you?",
    "Is that right for Thursday?",
    "Is that okay with you?",
    "Does that sound right to you?",
    "Does that look good for you?",
  ];
  for (const said of READ_BACKS) {
    it(`recognises: ${said}`, () => expect(en.test(said)).toBe(true));
  }

  // And the guard still does its job where the ambiguity actually arises: once a
  // word IS between them, an attributive adjective becomes reachable.
  it("still rejects the attributive, which is what the guard is for", () => {
    expect(en.test("Is that the right number to reach you on?")).toBe(false);
    expect(en.test("Is that the right day for you or would another suit better?")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE MODAL IS A CLOSED CLASS, so list it as one. Call CA0c8ce7, 2026-09-10:
//
//   "I'll update it to Venkat Ilovarpu — MAY I GO AHEAD and confirm the
//    appointment for 9 AM tomorrow under that name?"
//
// recorded readBackMade=false, and the write-order gate refused a correction
// that had been put to the caller perfectly clearly. `shall I` and `should I`
// were listed; `may I` and `can I` were not. Same LVX107 shape as the rest of
// this file -- a pattern written from observed phrasings rather than from the
// grammar underneath them.
// ---------------------------------------------------------------------------
describe("confirmReadBackRe — every modal that fronts the same offer", () => {
  const READ_BACKS = [
    "May I go ahead and confirm the appointment for 9 AM tomorrow under that name?",
    "Can I go ahead and book that for you?",
    "Shall I go ahead and book that?",
    "Should I go ahead and cancel it?",
    "May I book that for you now?",
    "Can I reschedule that to Thursday for you?",
  ];
  for (const said of READ_BACKS) {
    it(`recognises: ${said.slice(0, 46)}`, () => expect(en.test(said)).toBe(true));
  }

  // The modal alone is not an offer to act. These are questions ABOUT the
  // caller, not proposals to write anything, and counting them would hand the
  // write gate a read-back that never happened.
  const NOT_READ_BACKS = [
    "Can I get your full name, please?",
    "May I ask what the appointment is for?",
    "Can I help with anything else today?",
  ];
  for (const said of NOT_READ_BACKS) {
    it(`ignores: ${said.slice(0, 46)}`, () => expect(en.test(said)).toBe(false));
  }
});

// ---------------------------------------------------------------------------
// THE VERB AFTER THE MODAL IS ALSO A LIST, and it is also incomplete. Three
// live misses on 2026-09-11, across two calls, each on a DIFFERENT verb:
//
//   CA75a023  "Sure thing, I can cancel your appointment on Monday,
//              September 14th at 3 00 PM. ARE YOU SURE YOU'D LIKE TO GO AHEAD
//              with that?"                                    -> refused
//   CAa2ce4e  "Would you like me to MAKE that change?"         -> refused
//   CAa2ce4e  "Shall I TRY to make that change now?"           -> ceiling
//
// `go ahead` was listed on the `would you like me to` alternation and NOT on
// the adjacent `you'd like to` one; `make` and `try` were on neither. Three
// textbook read-backs, three refusals, and on CAa2ce4e the caller was moved
// from the 2 PM they asked for to 4 PM while being told twice that their time
// was unavailable -- it was not, check_appointment_availability had just
// returned it open.
//
// FIXED AS ONE SHARED VERB GROUP, not as three more alternations. The three
// places that front an offer to act had drifted into three different lists,
// which is the same defect LVX107 fixed for the modal one level up.
//
// The verb group is still a CLOSED CLASS and the negatives below are why: it
// is what keeps "Can I get your full name?" out. A modal plus any verb at all
// would make the gate stop gating.
// ---------------------------------------------------------------------------
describe("confirmReadBackRe — the verb is a closed class too", () => {
  const READ_BACKS = [
    // The three live misses, verbatim from the calls.
    "Sure thing, I can cancel your appointment on Monday, September 14th at 3 00 PM. Are you sure you'd like to go ahead with that?",
    "Okay, three PM is available on that day. So, we would be rescheduling your appointment from one PM on Wednesday, September sixteenth to three PM on the same date. Would you like me to make that change?",
    "Okay, four PM is available as well. So, we'd be moving your appointment from one PM on Wednesday, September sixteenth to four PM on the same date. Shall I try to make that change now?",
    // The same three verbs, isolated, on each of the three alternations.
    "You'd like to go ahead with that change?",
    "Would you like me to make that change?",
    "Shall I try to make that change now?",
    "Should I update that for you?",
    "Do you want me to put that through?",
  ];
  for (const said of READ_BACKS) {
    it(`recognises: ${said.slice(0, 46)}`, () => expect(en.test(said)).toBe(true));
  }

  // The negatives the verb group exists to keep out. These are questions ABOUT
  // the caller, not offers to act, and every one of them is a turn the
  // assistant says routinely just before collecting a detail.
  const NOT_READ_BACKS = [
    "Can I get your full name, please?",
    "May I ask what the appointment is for?",
    "Can I help with anything else today?",
    "Would you like me to check what else is open?",
    "Shall I see if there is anything earlier?",
  ];
  for (const said of NOT_READ_BACKS) {
    it(`ignores: ${said.slice(0, 46)}`, () => expect(en.test(said)).toBe(false));
  }
});

describe("confirmReadBackRe — Spanish is untouched by the widening", () => {
  it("recognises the Spanish read-back", () =>
    expect(es.test("Para confirmar, ¿procedo con la cita del martes?")).toBe(true));
  it("ignores an ordinary Spanish turn", () =>
    expect(es.test("Tiene tres citas próximas.")).toBe(false));
});
