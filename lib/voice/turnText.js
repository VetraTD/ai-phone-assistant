// Hammersleys round 5, Task 1: what the assistant's words in the turn so far say.
//
// Live continues the same turn after a tool response, and acts on the tool's
// reply at once (memory live-instruction-timing). A save whose reply says "ask
// them now", made right after the model asked its next question, makes it ask
// that question twice: 13 of 15 round-3/4 repeat cuts came 0.5-2.2 s after a
// tool. Probe 0b (2026-11-26, gemini-3.8-live): the "?" is already in the
// turn's transcript when the tool call arrives (18/18 question trials), so the
// reply can be chosen from it.

/** Does the text end with a question mark (allowing closing quotes, brackets and space after it)? */
export function replyEndsWithQuestion(text) {
  if (typeof text !== "string") return false;
  return /\?['")\]\s]*$/.test(text.trim());
}

/** Model-only, like the other save-reply notes: the question is out; wait for its answer. */
export const ALREADY_ASKED_NOTE =
  "[not caller speech] Saved. You have already asked your next question in this turn: say nothing more now and wait for the caller's answer.";
