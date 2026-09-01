/**
 * Reading the CALLER's side of the spelling exchange.
 *
 * Everything about spelling used to be measured from what the assistant said.
 * The gate opened once a spelling request had been SPOKEN, so "asked and
 * answered" and "asked and ignored" were the same state, and only one of them
 * is safe to write a name from. These tests pin the two questions that were
 * never asked: did letters arrive, and did the caller say no.
 *
 * Bias throughout: a MISS is cheap (one repeated question, bounded by the
 * caps) and a FALSE POSITIVE is not (a wrong name written silently, and the
 * business keeps that row). Every threshold is set where ordinary speech
 * cannot reach it, and the "does not fire on" cases below are the ones that
 * matter most.
 */

import { describe, it, expect } from "vitest";
import { looksLikeSpelling, looksLikeSpellingRefusal } from "../lib/spellingSignal.js";
import { getStrings } from "../lib/voice/strings.js";
import {
  applyReplyState,
  applyCallerSpellingSignal,
  spellingSettled,
  spellMissCap,
} from "../lib/voice/replyState.js";
import { STEPS } from "../lib/callState.js";

const en = getStrings("en");
const es = getStrings("es");

describe("looksLikeSpelling — did the caller actually spell something", () => {
  it("reads the shapes Deepgram returns for a spelled name", () => {
    // The same letters, paced four ways. smart_format punctuates some of them
    // and not others, which is why the separator set is wide.
    expect(looksLikeSpelling("N I T H I N", en)).toBe(true);
    expect(looksLikeSpelling("N-I-T-H-I-N", en)).toBe(true);
    expect(looksLikeSpelling("N. I. T. H. I. N.", en)).toBe(true);
    expect(looksLikeSpelling("it is B, E, L, L", en)).toBe(true);
  });

  it("reads a spelling that arrives mid-sentence", () => {
    expect(looksLikeSpelling("Sure, it is spelled K R I S", en)).toBe(true);
    expect(looksLikeSpelling("Bell. B-E-L-L. Like the sound.", en)).toBe(true);
  });

  it("reads the phonetic alphabet", () => {
    expect(looksLikeSpelling("B as in Boy, E as in Edward", en)).toBe(true);
    expect(looksLikeSpelling("N like in November, D like in Delta", en)).toBe(true);
  });

  it("reads spelled letter NAMES when the recognizer transcribes the sound", () => {
    expect(looksLikeSpelling("en eye tee aitch", en)).toBe(true);
  });

  // ---- the half that protects the caller ----------------------------------

  it("does not fire on ordinary speech", () => {
    expect(looksLikeSpelling("I would like to book an appointment for Tuesday.", en)).toBe(false);
    expect(looksLikeSpelling("It is Marcus Bell.", en)).toBe(false);
    expect(looksLikeSpelling("Yes, that is right, thank you.", en)).toBe(false);
    expect(looksLikeSpelling("Can I see you at two?", en)).toBe(false);
  });

  it("does not treat contractions as single letters", () => {
    // "I'm", "I'd", "I'll" tokenize as whole words — splitting on the
    // apostrophe would manufacture a one-letter token out of every one.
    expect(looksLikeSpelling("I'm I'd I'll", en)).toBe(false);
  });

  it("needs a real letter, not just the ones that are also words", () => {
    // "a", "i", "o", "y" are words. A run made only of those is not a
    // spelling, and a caller saying "a, I, a" is not spelling anything.
    expect(looksLikeSpelling("a I a", en)).toBe(false);
    expect(looksLikeSpelling("a I o y", en)).toBe(false);
    // ...but one consonant in the run is enough to make it one.
    expect(looksLikeSpelling("a I b", en)).toBe(true);
  });

  it("needs more than two letters, so an initial is not a spelling", () => {
    expect(looksLikeSpelling("J R", en)).toBe(false);
    expect(looksLikeSpelling("it is J. R. Smith", en)).toBe(false);
  });

  it("needs two 'as in's, because one appears in ordinary speech", () => {
    expect(looksLikeSpelling("B as in Boy", en)).toBe(false);
  });

  it("needs a long run of letter NAMES, because most of them are words", () => {
    expect(looksLikeSpelling("see you", en)).toBe(false);
    expect(looksLikeSpelling("oh, see, why", en)).toBe(false);
  });

  it("handles empty and non-string input without throwing", () => {
    expect(looksLikeSpelling("", en)).toBe(false);
    expect(looksLikeSpelling(null, en)).toBe(false);
    expect(looksLikeSpelling(undefined, en)).toBe(false);
    expect(looksLikeSpelling("   ", en)).toBe(false);
  });

  it("works with no strings table at all, defaulting to English", () => {
    expect(looksLikeSpelling("B-E-L-L")).toBe(true);
    expect(looksLikeSpelling("I would like to book something.")).toBe(false);
  });

  it("reads a Spanish spelling with the Spanish lexicon and separators", () => {
    expect(looksLikeSpelling("N I T H I N", es)).toBe(true);
    expect(looksLikeSpelling("be de efe ese", es)).toBe(true);
    expect(looksLikeSpelling("B de Barcelona, E de Espana", es)).toBe(true);
    expect(looksLikeSpelling("Quiero una cita para el martes.", es)).toBe(false);
  });
});

describe("looksLikeSpellingRefusal — did the caller decline", () => {
  it("reads a bare no, which only means this in reply to the question", () => {
    expect(looksLikeSpellingRefusal("no", en)).toBe(true);
    expect(looksLikeSpellingRefusal("Nope", en)).toBe(true);
  });

  it("reads the polite forms, which are the ones people actually use", () => {
    expect(looksLikeSpellingRefusal("no need", en)).toBe(true);
    expect(looksLikeSpellingRefusal("It's fine, don't worry", en)).toBe(true);
    expect(looksLikeSpellingRefusal("it's spelled how it sounds", en)).toBe(true);
    expect(looksLikeSpellingRefusal("just as it sounds", en)).toBe(true);
    expect(looksLikeSpellingRefusal("the usual way", en)).toBe(true);
    expect(looksLikeSpellingRefusal("I'd rather not", en)).toBe(true);
  });

  it("reads a decline with a trailing thanks, which is how people actually say it", () => {
    // The anchored bare-no form missed these, scoring a genuine refusal as an
    // unanswered ask and costing the caller another question.
    expect(looksLikeSpellingRefusal("No, thanks", en)).toBe(true);
    expect(looksLikeSpellingRefusal("No thank you.", en)).toBe(true);
  });

  it("does not read an ordinary answer as a refusal", () => {
    expect(looksLikeSpellingRefusal("It is Marcus Bell", en)).toBe(false);
    expect(looksLikeSpellingRefusal("Tuesday at ten would be great", en)).toBe(false);
    // "no" inside a sentence is not a refusal of anything.
    expect(looksLikeSpellingRefusal("no appointment yet, I want to make one", en)).toBe(false);
  });

  // Found in review, and the most dangerous class this function has. The
  // assistant asks two things in one turn — "Could you spell that? And is two
  // o'clock alright?" — and the caller answers the second. Reading that as a
  // refusal writes the misheard name with no letters ever heard, silently,
  // and the business keeps the row. These all matched the first version.
  it("does not read a plain affirmative as a refusal to spell", () => {
    expect(looksLikeSpellingRefusal("Yes, that's fine", en)).toBe(false);
    expect(looksLikeSpellingRefusal("that's okay", en)).toBe(false);
    expect(looksLikeSpellingRefusal("no worries", en)).toBe(false);
    expect(looksLikeSpellingRefusal("never mind", en)).toBe(false);
    expect(looksLikeSpellingRefusal("it's fine", en)).toBe(false);
  });

  it("reads the Spanish forms", () => {
    expect(looksLikeSpellingRefusal("no hace falta", es)).toBe(true);
    expect(looksLikeSpellingRefusal("se escribe como suena", es)).toBe(true);
    expect(looksLikeSpellingRefusal("Me llamo Marcos Bell", es)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle, driven through the reducer both channels share.
// ---------------------------------------------------------------------------
describe("applyReplyState — the spelling question opens and closes on the CALLER", () => {
  const deps = () => ({
    STEPS,
    mergeCapabilityState: () => {},
    dispatchEffects: () => [],
    spellRequestRe: en.spellRequestRe,
  });
  const freshState = () => ({ history: [], step: STEPS.GATHER_DETAILS, intent: null });
  // One turn, in the order the real drivers run it: the caller's words are
  // read FIRST (lib/voice/session.js startTurn, before buildExtras), then the
  // model replies, then the reducer records what we said.
  //
  // The ordering is the point. These two used to be one call, and the caller
  // half ran after the reply — so the turn on which someone spelled their name
  // still went out to the model saying they had not.
  const turn = (state, userText, replyText) => {
    applyCallerSpellingSignal(state, userText, en);
    return applyReplyState(state, { userText, reply: { text: replyText } }, deps());
  };

  it("stays open when the assistant has merely asked", () => {
    const state = freshState();
    turn(state, "It is Nithin.", "Could you spell that for me?");
    expect(state.spellAskPending).toBe(true);
    // THE regression test. This was effectively true before the change, and it
    // is why a mis-heard name reached the database.
    expect(spellingSettled(state)).toBe(false);
  });

  it("closes when the caller spells it", () => {
    const state = freshState();
    turn(state, "It is Nithin.", "Could you spell that for me?");
    turn(state, "N-I-T-H-I-N", "Got it, thank you.");
    expect(state.spellingCaptured).toBe(true);
    expect(spellingSettled(state)).toBe(true);
  });

  it("closes when the caller declines", () => {
    const state = freshState();
    turn(state, "It is Marcus Bell.", "Could you spell that for me?");
    turn(state, "no need, it's spelled how it sounds", "Of course.");
    expect(state.spellingDeclined).toBe(true);
    expect(spellingSettled(state)).toBe(true);
  });

  it("closes after the caller has ignored the question its allotted times", () => {
    const state = freshState();
    turn(state, "It is Nithin.", "Could you spell that for me?");
    turn(state, "Can we do Tuesday morning?", "Sorry — how do you spell it?");
    expect(state.spellAskMisses).toBe(1);
    expect(spellingSettled(state)).toBe(false); // still open after ONE miss
    turn(state, "Actually make it the afternoon.", "No problem.");
    expect(state.spellAskMisses).toBe(spellMissCap());
    expect(spellingSettled(state)).toBe(true); // the escape hatch
  });

  it("counts a spelling the caller volunteers without being asked", () => {
    const state = freshState();
    // Nothing was asked, so nothing is pending — but letters are letters, and
    // asking a caller to repeat what they just spelled is the exact repetition
    // this area exists to stop.
    turn(state, "It is Bell, B-E-L-L.", "Thank you.");
    expect(state.spellingCaptured).toBe(true);
    expect(spellingSettled(state)).toBe(true);
  });

  it("does not spend a miss on a turn where nothing was asked", () => {
    const state = freshState();
    turn(state, "I would like to book something.", "Of course — what day suits?");
    turn(state, "Tuesday.", "And your name?");
    expect(state.spellAskMisses || 0).toBe(0);
    expect(spellingSettled(state)).toBe(false);
  });

  it("closes at the hard ask ceiling even if no answer was ever classified", () => {
    // The backstop for a caller whose phrasing the detector never recognises:
    // the reducer sees an ask, then an answer it cannot read, three times.
    // Reached via spellAskCap rather than the miss cap only because the miss
    // cap would fire first here; both ceilings exist so neither is load-bearing
    // alone.
    const state = freshState();
    turn(state, "It is Nithin.", "Could you spell that?");
    expect(spellingSettled(state)).toBe(false);
    turn(state, "Hmm.", "Sorry, could you spell that?");
    turn(state, "Hmm.", "One more time, could you spell that?");
    expect(spellingSettled(state)).toBe(true);
  });

  it("tracks nothing at all when no strings are supplied", () => {
    // Same "unaffected other callers" contract the ask counter already has.
    const state = freshState();
    applyCallerSpellingSignal(state, "N-I-T-H-I-N", null);
    applyReplyState(
      state,
      { userText: "N-I-T-H-I-N", reply: { text: "Thanks." } },
      { STEPS, mergeCapabilityState: () => {}, dispatchEffects: () => [] },
    );
    expect(state.spellingCaptured).toBeUndefined();
  });

  // Found in review: looksLikeSpelling answers "did a spelling happen", but
  // the gate it feeds is specifically about NAMES. Spelling an email address
  // is a perfectly good letter run, and counting it opened the name gate for
  // the rest of the call — the original wrong-name defect through a new door.
  it("does not treat a spelled-out email or reference as the name", () => {
    const state = freshState();
    applyCallerSpellingSignal(state, "my email is j-a-y at gmail dot com", en);
    expect(state.spellingCaptured).toBeUndefined();
    expect(spellingSettled(state)).toBe(false);

    const other = freshState();
    applyCallerSpellingSignal(other, "the reference is A-B-C-1-2-3", en);
    expect(other.spellingCaptured).toBeUndefined();
  });

  it("still counts letters as the name when the spelling was what we asked for", () => {
    // The guard is skipped while an ask is outstanding: we asked about the
    // name, so an answer to that question is what is being given.
    const state = freshState();
    turn(state, "It is Nithin.", "Could you spell that for me?");
    applyCallerSpellingSignal(state, "sure, my email spelling is N-I-T-H-I-N", en);
    expect(state.spellingCaptured).toBe(true);
  });

  // THE regression this ordering exists for, found in review.
  //
  // Everything the write gate and the prompt block read is assembled BEFORE
  // the model is called, so a signal recorded after the reply arrives too late
  // to affect the turn that produced it. With the old placement the caller
  // spelled their name and that same turn still told the model they had not,
  // and still refused a booking for want of a spelling it already had.
  it("is visible on the SAME turn the caller spells, not the one after", () => {
    const state = freshState();
    turn(state, "It is Nithin.", "Could you spell that for me?");
    expect(spellingSettled(state)).toBe(false);

    // What a driver does at the top of the next turn, before buildExtras.
    applyCallerSpellingSignal(state, "N-I-T-H-I-N", en);

    // Settled by the time the prompt and the gate are decided — so the model
    // is not told to ask again, and a booking in THIS turn is not refused.
    expect(spellingSettled(state)).toBe(true);
  });
});
