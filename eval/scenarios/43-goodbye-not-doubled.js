/**
 * THE GOODBYE IS SAID ONCE.
 *
 * From the 2026-08-29 call the caller heard:
 *
 *   "{reason:Caller declined further assistance and said thank you. }
 *    You're very welcome. Thank you for calling Digile Media, and have a
 *    wonderful day. You're very welcome. Thank you for calling Digile Media,
 *    and have a great day."
 *
 * One root cause, two symptoms. end_call was written into the TEXT channel, so
 * the stripper excised the name and left `{reason:...}` behind to be read
 * aloud; then the recovery round forced the real call and the model said
 * goodbye a second time, appended to the same reply.
 *
 * The unit tests in tests/textChannelToolCall.test.js pin the mechanism with a
 * mocked stream. This one asks whether an ordinary call, driven by the real
 * model, ever produces the shape at all — a leak or a repeat here means
 * something upstream of the guards changed.
 */
import * as A from "../asserts.js";

/** Anything shaped like internals: braces, a key:value pair, a tool name. */
const INTERNALS = /[{}]|\b(reason|client_name|scheduled_at|requested_at)\s*:|default_api|end_call/i;

export default {
  name: "goodbye-not-doubled",
  tags: ["regression"],
  fixture: "appointments-availability",
  caller: {
    mode: "scripted",
    turns: [
      "Hi there, could you tell me what your opening hours are?",
      "Great, thank you. That's all I needed.",
      "No, nothing else. Thanks so much, bye!",
    ],
  },
  hard: [
    // Nothing machine-shaped may ever be spoken.
    (ctx) => A.replyNeverMatches(ctx, INTERNALS),
    // The sign-off is said once. Two "thank you for calling" in one call is the
    // reported duplicate; the caller heard both.
    (ctx) => A.replyMatchesAtMost(ctx, /thank you for calling/i, 1),
    (ctx) => A.replyMatchesAtMost(ctx, /have a (wonderful|great|good|lovely) day/i, 1),
  ],
  judge: [
    "Did the receptionist say goodbye exactly once, without repeating its closing line?",
    "Was everything the receptionist said plain English a caller would expect, with no technical or machine-generated fragments?",
  ],
};
