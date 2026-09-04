// ---------------------------------------------------------------------------
// LVX44 — the spelling nudge shipped and did not fire on either of the two
// calls after it shipped.
//
// The owner's report was emphatic: "It needs to ask for the spelling right
// after the caller said their name. THIS IS ESSENTIAL." The prompt already
// instructs exactly that, in those words, and was ignored -- so the fix was a
// counted nudge in the reducer keyed on nameGivenRe, matching a caller
// introducing themselves.
//
// Then live_spelling_ask_nudged read 0 while spelling_gate_refusals read 2:
// the precondition held, the nudge never fired, and the write-time gate did the
// work late exactly as before. The cause is that nameGivenRe requires a lead-in
// -- "my name is", "I'm", "it's", "this is" -- and real callers say
//
//     "let's do uh Nathan Dodla"
//
// which has none. A regex over caller phrasing can be widened and never
// completed, and that weakness was declared when the guard was built; it
// arrived immediately.
//
// ---------------------------------------------------------------------------
// So trigger on the side the PROMPT controls
// ---------------------------------------------------------------------------
//
// A caller can introduce themselves a hundred ways. The assistant's read-back
// has a shape, because three separate prompt rules demand it:
//
//   capabilities/appointments.js: "repeat their FULL name back once in your
//     very next sentence -- 'Thanks, Marcus Bell — ...'"
//   capabilities/messages.js:     the same instruction for a message
//   capabilities/appointments.js: "repeat it back naturally ('Thanks, Marcus — ...')"
//
// So the assistant says the name back whether or not the caller announced it
// with a lead-in. Either side firing spends the same single rationed nudge.
// This does not replace nameGivenRe -- a caller who does say "my name is" is
// still caught one beat earlier, which is the whole point of the fix.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { getStrings } from "../lib/voice/strings.js";

const en = getStrings({ languagesSpoken: ["en"] });
const es = getStrings({ languagesSpoken: ["es"] });

describe("the case that made LVX44 SHIPPED, NOT WORKING", () => {
  it("nameGivenRe still cannot see a name with no lead-in", () => {
    // Recorded rather than fixed: widening nameGivenRe to match a bare
    // capitalised word would fire on every day, month and place name a caller
    // says. The read-back is the better signal precisely because it is the
    // assistant's own sentence.
    expect(en.nameGivenRe.test("let's do uh Nathan Dodla")).toBe(false);
  });

  it("the read-back the assistant gives for it IS seen", () => {
    expect(en.nameReadBackRe.test("Thanks, Nathan Dodla — let me check that for you.")).toBe(true);
  });
});

describe("nameReadBackRe — the shapes the prompt asks for", () => {
  const READ_BACKS = [
    "Thanks, Marcus Bell — let me get that booked.",
    "Thanks, Marcus — one moment.",
    "Thank you, Nithin Dodla.",
    "Thanks Nithin, and what time suits you?",
    "Got it, Nathan Dodla.",
    "Perfect, Nithin — Tuesday at noon then.",
    "Great, Marcus Bell. And a number for you?",
    "Thanks, Zoe.",
  ];
  for (const said of READ_BACKS) {
    it(`sees: ${said.slice(0, 48)}`, () => expect(en.nameReadBackRe.test(said)).toBe(true));
  }
});

describe("nameReadBackRe — what must NOT count as a name read back", () => {
  // A nudge that fires on the greeting would spend the call's one spelling note
  // before the caller had said anything, and a nudge that can misfire freely is
  // the shape that let the leak guard destroy a call (LVX21).
  const NOT_READ_BACKS = [
    // The greeting itself, on every single call.
    "Thanks for calling Brightwork Family Dental. How can I help you today?",
    "Thank you for calling Digile Media.",
    "Thanks for that.",
    "Thanks for holding.",
    // Days and months are what a caller says on a booking call.
    "Thanks, Tuesday works — I'll check that.",
    "Got it, Monday at ten.",
    "Perfect, September the 8th.",
    "Thanks, Tomorrow is fine.",
    // Ordinary continuations that begin with a capital.
    "Thanks, I'll get that booked for you.",
    "Thanks, We can do that.",
    "Got it, Let me check the calendar.",
    "Great, Okay — one moment.",
    "Thanks, And what number should I use?",
    "Thanks, That works.",
    // No acknowledgement at all.
    "Nathan Dodla is booked for Tuesday.",
    "Could I take your name?",
  ];
  for (const said of NOT_READ_BACKS) {
    it(`ignores: ${said.slice(0, 48)}`, () => expect(en.nameReadBackRe.test(said)).toBe(false));
  }
});

describe("nameReadBackRe — Spanish", () => {
  it("sees a Spanish read-back", () => {
    expect(es.nameReadBackRe.test("Gracias, Marcos Belmonte — un momento.")).toBe(true);
  });
  it("ignores the Spanish greeting", () => {
    expect(es.nameReadBackRe.test("Gracias por llamar a Digile Media.")).toBe(false);
  });
});
