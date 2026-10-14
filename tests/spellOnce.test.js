// ---------------------------------------------------------------------------
// Round A1 "say it once" — spelling (owner, 2026-10-13, LVX177 + LVX172).
//
// "If the caller spelled the name once (spelling_voiced_answer), accept it as
// heard. No second ask." A caller who spelled into a transcript that lost it
// (the model is the ASR on Live and heard the letters) used to be asked a
// second time, because a voiced answer only counted as one MISS of two.
// LVX177 measured 16 spelling-gate refusals, 15 on saves that later went
// through. A voiced answer now settles spelling like letters do, and the
// spelled name is read back once -- inside the booking's one read-back,
// letter by letter (lib/voice/savePolicy.js composeReadBack).
//
// DELIBERATELY NARROW: the miss cap stays two. A caller who talked PAST the
// question -- no letters, no voiced answer to it -- did not spell, and the
// second chance that protects them from a misheard name being written
// (tests/tools.test.js "blocks until answered") is untouched.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  applyCallerVoicedAnswer,
  applyCallerSpellingSignal,
  spellingSettled,
  spellMissCap,
} from "../lib/voice/replyState.js";
import { getStrings } from "../lib/voice/strings.js";

describe("a caller who spelled once is never asked again", () => {
  it("a voiced answer the transcript lost settles spelling and records that they spelled", () => {
    const st = { spellAskPending: true };
    applyCallerVoicedAnswer(st, 2180); // CA9e3788's real figure
    expect(spellingSettled(st)).toBe(true);
    expect(st.spellingVoiced).toBe(true);
  });

  it("a cough is not an answer: nothing settles, nothing is recorded", () => {
    const st = { spellAskPending: true };
    applyCallerVoicedAnswer(st, 80);
    expect(spellingSettled(st)).toBe(false);
    expect(st.spellingVoiced).toBeFalsy();
  });

  it("a voiced answer with no question pending is not a spelling", () => {
    const st = { spellAskPending: false };
    applyCallerVoicedAnswer(st, 2180);
    expect(st.spellingVoiced).toBeFalsy();
  });

  it("the miss cap is unchanged: a caller who did not spell still gets one more chance", () => {
    expect(spellMissCap()).toBe(2);
    const st = { spellAskPending: true };
    applyCallerSpellingSignal(st, "Jon.", getStrings({}));
    expect(st.spellingCaptured).toBeFalsy();
    expect(spellingSettled(st)).toBe(false);
  });
});
