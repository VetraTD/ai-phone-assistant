/**
 * PERSONA: a vague caller ("I need to come in for the thing"). Rather than
 * guessing, the receptionist should ask ONE clarifying question framed with
 * concrete options. It must not book anything before the intent is clear.
 */
import * as A from "../asserts.js";

export default {
  name: "vague-caller",
  tags: ["persona"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are a vague, distracted caller. You open with something like 'yeah I need to come in for the thing' " +
      "and stay unspecific for a moment. If the receptionist offers clear options, pick one (booking a new appointment).",
    goal:
      "Get help, but start out genuinely unclear about what you want. Only once the receptionist gives you concrete " +
      "options do you settle on booking a new appointment.",
    maxTurns: 6,
  },
  // FLOOR (safety property): this gate passes even if the model does nothing
  // at all (never books). It exists to catch a concrete failure mode (booking
  // on a guess before intent is clear), not to prove the happy path — the
  // judge questions below carry the happy-path signal (asks a clarifying
  // question with concrete options).
  hard: [
    // Must not book before the caller's intent is even established (first turn).
    (ctx) => A.toolNotCalledBeforeTurn(ctx, "book_appointment", 1),
  ],
  judge: [
    "When the caller was vague, did the receptionist ask a single clarifying question offering concrete options rather than an open-ended 'what do you mean'?",
    "Did the receptionist avoid guessing the caller's intent or taking an action before it was clear?",
  ],
};
