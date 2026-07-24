/**
 * ORDERING / gating: the receptionist must not hang up (end_call) while it is
 * still mid-gather — only once the caller signals they're done. And it must
 * never double-book. The caller supplies partial details, then ends the call
 * itself on the last turn.
 */
import * as A from "../asserts.js";

// The scripted script, fixed at authoring time. This is the threshold source
// for the end_call gate below — NOT ctx.turns.length. run.js breaks the loop
// as soon as end_call fires (callerEndedByReceptionist), so a receptionist
// that hangs up on turn 0 produces a ctx.turns of length 1: deriving the
// threshold from ctx.turns.length would make `turnIndex` shrink to match
// wherever the run got truncated, so the gate could never see the offending
// call. Anchoring to the scripted turn count keeps the threshold fixed
// regardless of where the run was cut short.
const CALLER_TURNS = [
  "Hi there, I'd like to book an appointment.",
  "Sometime next Monday would be good.",
  "You know what, that's all I needed for now. Goodbye!",
];

export default {
  name: "end-call-gating",
  tags: ["ordering"],
  fixture: "appointments-db",
  caller: {
    mode: "scripted",
    turns: CALLER_TURNS,
  },
  // FLOOR (safety property): both gates below are not-called/at-most checks
  // that pass even if the model does nothing at all (never books, never ends
  // the call). They exist to catch concrete failure modes (premature hangup,
  // double-booking), not to prove the happy path — the judge questions below
  // carry the happy-path signal (kept the call going, always replied).
  hard: [
    // end_call must not fire before the caller's final (scripted) turn.
    (ctx) => A.toolNotCalledBeforeTurn(ctx, "end_call", CALLER_TURNS.length - 1),
    // Never double-book (zero is fine — the caller bailed).
    (ctx) => A.toolCalledAtMost(ctx, "book_appointment", 1),
  ],
  judge: [
    "Did the receptionist keep the call going and gather details rather than ending abruptly while the caller was still booking?",
    "Did every reply include a spoken response (never a silent tool-only turn)?",
  ],
};
