/**
 * ORDERING / gating: the receptionist must not hang up (end_call) while it is
 * still mid-gather — only once the caller signals they're done. And it must
 * never double-book. The caller supplies partial details, then ends the call
 * itself on the last turn.
 */
import * as A from "../asserts.js";

export default {
  name: "end-call-gating",
  tags: ["ordering"],
  fixture: "appointments-db",
  caller: {
    mode: "scripted",
    turns: [
      "Hi there, I'd like to book an appointment.",
      "Sometime next Monday would be good.",
      "You know what, that's all I needed for now. Goodbye!",
    ],
  },
  hard: [
    // end_call must not fire before the caller's final turn.
    (ctx) => A.toolNotCalledBeforeTurn(ctx, "end_call", Math.max(0, (ctx.turns || []).length - 1)),
    // Never double-book (zero is fine — the caller bailed).
    (ctx) => A.toolCalledAtMost(ctx, "book_appointment", 1),
  ],
  judge: [
    "Did the receptionist keep the call going and gather details rather than ending abruptly while the caller was still booking?",
    "Did every reply include a spoken response (never a silent tool-only turn)?",
  ],
};
