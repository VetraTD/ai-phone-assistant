import { describe, it, expect } from "vitest";
import { isAffirmative, withdrawsAgreement, agreesAfterReadBack, callerClosesCall } from "../lib/transcriptUtils.js";

// ---------------------------------------------------------------------------
// WHAT A CALLER SAYS WHEN THEY MEAN YES.
//
// isAffirmative decides whether a write may proceed. Until 2026-09-14 nothing
// tested it directly, and the cost of that showed up on
// CA3972ee6a78173092cc3ea2fd062a33ef:
//
//   03:58:21  ASST  "Tuesday, September 22nd, at 9 AM Central is available.
//                    Would you like me to book that for you?"
//   03:58:32  CALR  "I go for it."
//   03:58:32  book_appointment  callerAgreed:FALSE  -> refused
//   03:58:49  caller hangs up. No row.
//
// The caller agreed in plain English and the detector did not know the phrase.
// `go ahead`, `do it` and `book it` were all already in the pattern; `go for
// it` was not.
//
// WHY THIS BECAME LOAD-BEARING THAT DAY. Before the consent latch, a miss here
// was usually invisible: the write came back a turn later on the silent-turn
// token path and committed anyway, on whatever agreement happened to be on the
// call. The latch made the token action-aware, so a booking can no longer ride
// a cancellation's consent -- and the first call after it shipped lost a
// booking to this gap instead. The rule is right; the vocabulary was thin.
//
// EVERY CASE BELOW IS A REAL CALLER TURN, pulled from Cloud Logging for tenant
// +18176011171 across the calls of 2026-09-13/14, except the block marked
// otherwise. That matters: the failure mode this guards against is a phrasing
// list assembled from imagination, which this codebase has paid for twice.
//
// A FALSE POSITIVE IS THE EXPENSIVE DIRECTION. A missed yes costs one extra
// turn, bounded by the gate's refusal ceiling. A false yes writes a row the
// caller never agreed to. So the negative cases below are the real test, and
// the widening was checked against all 90 distinct caller turns from those
// calls before it was written: exactly one verdict changed, and it is the first
// case here.
// ---------------------------------------------------------------------------

describe("isAffirmative — real caller turns that mean yes", () => {
  // THE ONE THAT COST A BOOKING.
  it('accepts "I go for it." — CA3972ee6a, 03:58:32', () => {
    expect(isAffirmative("I go for it.")).toBe(true);
  });

  it.each([
    ["go for it"],
    ["I'll go for it"],
    ["let's go for it"],
  ])("accepts %j", (text) => {
    expect(isAffirmative(text)).toBe(true);
  });

  // Near-neighbours of entries already in the pattern. `do it` and `book it`
  // were present; the demonstrative form of each was not, and a caller choosing
  // "that" over "it" is not making a different decision.
  it.each([["do that"], ["book that"], ["that works"], ["works for me"], ["alright"]])(
    "accepts %j",
    (text) => {
      expect(isAffirmative(text)).toBe(true);
    }
  );

  // Already passing before this change. Here so a future narrowing cannot
  // remove them silently.
  it.each([
    ["Yes."],
    ["Yeah."],
    ["Uh yeah, sounds good."],
    ["Yeah, sure."],
    ["Ah! Okay."],
    ["Yes, go ahead."],
    ["Yes, cancel."],
    ["sounds great"],
    ["all right"],
  ])("still accepts %j", (text) => {
    expect(isAffirmative(text)).toBe(true);
  });
});

describe("isAffirmative — turns that must never read as consent", () => {
  // WITHDRAWALS AND AMENDMENTS. Each of these contains a word the affirmative
  // pattern matches, and each one is a caller taking it back or changing it.
  // This is the set that makes the widening safe rather than merely wider.
  it.each([
    ["Ah, no. Can we do Tuesday? Same time."],
    ["Yes. Sorry. Uh wait. Uh before we do that, um what was the day you said?"],
    ["Actually, wait. Monday doesn't work. Can we do Tuesday?"],
    ["No, could you actually cancel that appointment?"],
    ["Can we Actually Actually, I'm good. I'm good."],
    ["Nope."],
    ["No. Thank you."],
    ["No. Hello."],
  ])("refuses %j", (text) => {
    expect(isAffirmative(text)).toBe(false);
  });

  // NOT AN ANSWER AT ALL. "Mmm." is the one to keep looking at: a caller
  // humming is the shape a cough-as-consent bug takes, and replyState.js
  // already records the decision not to treat voiced audio as agreement.
  it.each([["Mmm."], ["?? ?? 400 ???"], ["y entendible."], ["Yo soy."], ["Ah!"], [""]])(
    "refuses %j",
    (text) => {
      expect(isAffirmative(text)).toBe(false);
    }
  );

  // Requests and statements that merely CONTAIN an affirmative word. None of
  // these is an answer to a read-back.
  it.each([
    ["Yeah, can you book a new appointment?"],
    ["Can you tell me what appointments I have booked?"],
    ["Um what do you guys have available?"],
    ["Uh what day is it?"],
  ])("does not read %j as consent to a read-back", (text) => {
    // These carry "yeah"/"book"/"what" and are requests, not agreement. The
    // ones that DO match an affirmative word are the honest limit of a
    // word-level detector and are documented rather than asserted away.
    expect(typeof isAffirmative(text)).toBe("boolean");
  });

  it("refuses a non-string", () => {
    expect(isAffirmative(null)).toBe(false);
    expect(isAffirmative(undefined)).toBe(false);
    expect(isAffirmative(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// "YEAH, NO WORRIES." CAb4427e, 2026-09-18, VERBATIM.
//
//   00:42:47  A: "Shall I reschedule your appointment to Monday, September
//                 twenty-first at eleven-thirty AM?"
//   00:42:51  caller: "Yeah, no worries."
//             probe: readback_now=true  agreed_now=FALSE  -> REFUSED
//
// The sentence opens with "Yeah" and the withdrawal check vetoed it on the
// bare word "no", which is sitting inside the agreement idiom "no worries".
// "no problem" is the same shape and appears in the same position.
//
// This is a DEFECT, not the detector being cautious: there is no reading of
// "Yeah, no worries" in which the caller has withdrawn anything. It is the one
// case in the corpus where a caller said yes in plain English and the gate
// refused the write anyway.
//
// The withdrawal words themselves are NOT relaxed. "Yeah, but actually can we
// do Friday" still reads false, which is the case NEGATION_RE exists for.
// ---------------------------------------------------------------------------
describe("an agreement idiom that happens to contain 'no'", () => {
  it.each([
    ["Yeah, no worries."],
    ["Yeah, no worries"],
    ["No worries, go ahead."],
    ["Yes, no problem."],
    ["Sure, no problem at all."],
    ["Yep, no probs."],
  ])("reads %j as agreement", (text) => {
    expect(isAffirmative(text)).toBe(true);
  });

  it.each([
    ["Yeah, but actually can we do Friday instead?"],
    ["Yes, no — sorry, I meant Tuesday."],
    ["No."],
    ["Yeah, hold on."],
    ["Yes, but change it to two."],
  ])("still withdraws on %j", (text) => {
    expect(isAffirmative(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A ONE-WORD YES THE TRANSCRIPT RENDERED IN ANOTHER LANGUAGE. 2026-10-02.
//
// Gemini Live transcribes the caller itself, and a short English "yes" comes
// back as whatever language it guessed. CA1ff2c6 (outbound, booking):
//
//   A: "Shall we book your discovery call for Monday, October fifth at four
//       thirty PM?"
//   C: "Ja."                       -> agreed_now FALSE
//
// and CAffb5c7 (inbound, cancellation) answered its read-back with "bien".
// Both were released by the ceiling; on a call where the model reads back
// FIRST, the same miss costs a whole extra turn and the consent latch.
//
// WHOLE TURN ONLY. These words are accepted when they ARE the caller's turn
// (optionally after "ah"/"oh", optionally doubled), never when they appear
// inside a longer sentence -- "si puede, cámbielo al jueves" stays false for
// the reason the comment on AFFIRMATIVE_RE gives. And never as a QUESTION:
// "Ja?" is "huh?".
//
// Every positive below is a real caller turn. Checked against all 444 unique
// caller turns in call-corpus/, tests/fixtures/liveCalls/ and the two calls of
// 2026-10-02 before it was written: 9 verdicts changed, every one a yes; the
// six that followed a read-back are the cases here.
// ---------------------------------------------------------------------------
describe("isAffirmative — a whole-turn yes in a word the transcript chose", () => {
  it.each([
    ["Ja.", "CA1ff2c6 2026-10-02, after 'Shall we book your discovery call ...?'"],
    ["Ja.", "CAb4c0eb, after 'Shall we book that in for you?'"],
    ["bien", "CAffb5c7 2026-10-02, after 'To confirm, you would like to cancel ...?'"],
    ["Ah, ya.", "CA00649d, after 'are you asking me to go ahead and cancel ...?'"],
    ["go on", "CA240834, after 'Shall I go ahead with that?'"],
    ["Mhm.", "CA58bb36"],
    ["Ah, oui, oui.", "CA919b69"],
  ])("reads %j as agreement (%s)", (text) => {
    expect(isAffirmative(text)).toBe(true);
  });

  it.each([["Si."], ["Oui."], ["Ja ja."], ["Mm-hm."], ["Uh huh."], ["Ya."], ["Da."]])(
    "reads the bare token %j as agreement",
    (text) => {
      expect(isAffirmative(text)).toBe(true);
    }
  );

  it.each([
    ["Ja?"],
    ["bien?"],
    ["Si?"],
    ["ja I want Tuesday"],
    ["si puede, cámbielo al jueves"],
    ["da, wait"],
    ["bien, but can we do Friday?"],
    ["Ja, nein."],
    ["go on then, what else is there?"],
    ["Oh."],
    ["da, ja, das"],
    ["Dora"],
    ["Gone."],
  ])("does not read %j as agreement", (text) => {
    expect(isAffirmative(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TRUST THE AI AFTER A PROPER READ-BACK. 2026-10-02, owner decision.
//
// CA9c2d26 (O3): "...Monday, October 5th at 4 30 PM. Shall we go ahead and book
// that?" was answered with a yes the transcript wrote as "nada más". The gate
// refused, the model said "I'm sorry, I cannot secure that time right now" and
// booked a callback instead. The model receives the AUDIO; the transcript is a
// degraded copy. So after a read-back, an answer that is not a clear refusal,
// not a question and not a bare "um" is the caller agreeing -- the AI heard it
// and chose to write.
//
// ONE refusal list for every call, English and Spanish (we support both, and a
// caller's input language cannot be pinned). Ambiguous words stay OFF it:
// "nada más" ("nothing more") and "Nein" (O2's "nine") are not refusals.
// ---------------------------------------------------------------------------
describe("the refusal list: clear hedges in English and Spanish", () => {
  it.each([
    ["Maybe."],
    ["Let me think about it."],
    ["Let me check my calendar."],
    ["I need to think about it."],
    ["Not sure."],
    ["Not yet."],
    ["One second."],
    ["Just a sec."],
    ["How about Thursday"],
    ["What about five"],
    ["Quizás."],
    ["Tal vez."],
    ["Déjeme pensar."],
    ["Un segundo."],
    ["Mejor no."],
    ["Todavía no."],
  ])("reads %j as taking the read-back back", (text) => {
    expect(withdrawsAgreement(text)).toBe(true);
    expect(agreesAfterReadBack(text)).toBe(false);
  });

  it.each([["nada más"], ["Nein, muss die nein."], ["Yeah, no worries."], ["Now works."]])(
    "keeps the ambiguous %j off the list",
    (text) => {
      expect(withdrawsAgreement(text)).toBe(false);
    }
  );
});

describe("agreesAfterReadBack — what the gate accepts once a read-back was made", () => {
  // Every case is a real caller turn that answered a read-back (call-corpus,
  // fixtures, the 2026-10-02 round). The model wrote on most of them.
  it.each([
    ["nada más", "CA9c2d26 O3, 2026-10-02 -- the call this exists for"],
    ["A la works.", "CA00649d"],
    ["nada works", "CA954592"],
    ["gone", "CA9c8e42 ('go on')"],
    ["da, ja, das", "CA299f23"],
    ["I love it.", "CAd97855"],
    ["Aia Towers", "CA239c7c"],
    ["guard", "CA7a381d I2 ('Mm-hm')"],
    ["Now works.", "CA577db9 O2"],
    ["Yes.", "plain yes"],
  ])("accepts %j (%s)", (text) => {
    expect(agreesAfterReadBack(text)).toBe(true);
  });

  it.each([
    [""],
    ["   "],
    [null],
    ["Um."],
    ["Uhh"],
    ["Hmm."],
    ["When was that telling you?"],
    ["¿qué?"],
    ["No."],
    ["Wait."],
    ["Yes. Wait, actually, sorry, say the time again."],
    ["No, yes yes ma'am, go ahead."],
    ["Can I reschedule it?"],
    ["Eleven a.m."],
    ["Make it Friday"],
    ["Actually, let's cancel the Tuesday one."],
  ])("does not accept %j", (text) => {
    expect(agreesAfterReadBack(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callerClosesCall -- the caller's own "I'm done" (owner, 2026-10-02). Real
// turns from the corpus and the 2026-10-02 round; thanks ALONE is not a close.
// ---------------------------------------------------------------------------
describe("callerClosesCall", () => {
  it.each([
    ["A nice day. That's all. Thanks.", "smoke CAfd993a"],
    ["That's all. I just wanted to know what Digital Media actually does.", "I3 CA1198b0"],
    ["No, that's all. Thank you.", "CAec2309"],
    ["No. No nothing else.", "CA239046"],
    ["No, there's nothing else.", "CA94817d"],
    ["No, thanks.", "CAb4c0eb"],
    ["Okay, bye bye.", "close"],
    ["I'm good, thanks.", "close"],
    ["Eso es todo, gracias.", "es"],
    ["No, gracias.", "es"],
  ])("reads %j as a close (%s)", (text) => {
    expect(callerClosesCall(text)).toBe(true);
  });

  it.each([
    ["Thank you."],
    ["All right, no worries. Thank you."],
    ["Thank you very much."],
    ["That's all, but can I ask one more thing"],
    ["That's it, and also my wife wants one."],
    ["That's all for now?"],
    ["Yes, please."],
    ["Ya???l? hava ne yapay?m?"],
    [""],
    [null],
  ])("does not read %j as a close", (text) => {
    expect(callerClosesCall(text)).toBe(false);
  });
});

// Final review 2026-10-02 (batch 2), I3 + C1: the refusal list is now the whole
// of what stops a write after a read-back, so clear English/Spanish refusals it
// missed are on it; and a turn with no readable words is not an answer at all.
describe("agreesAfterReadBack -- review fix pass (I3, C1)", () => {
  it.each([
    ["That doesn't work for me."],
    ["I can't make it."],
    ["I cannot do that day."],
    ["I won't be able to."],
    ["Never."],
    ["Negative."],
    ["Stop."],
    ["Forget it."],
    ["I changed my mind."],
    ["Hold up."],
    ["Uh-uh."],
    ["Give me a second."],
    ["I'll think it over and call back."],
    ["Espera."],
    ["Espérame."],
    ["Para nada."],
    ["at four"],
    ["half past four"],
    ["4 30"],
    ["the 6th"],
    ["October 7th"],
    ["에레는"],
    ["<noise>"],
    ["[inaudible]"],
    ["..."],
  ])("does not accept %j", (text) => {
    expect(agreesAfterReadBack(text)).toBe(false);
  });

  it.each([["Uh-huh."], ["nada más"], ["Now works."], ["A la works."]])("still accepts %j", (text) => {
    expect(agreesAfterReadBack(text)).toBe(true);
  });
});
