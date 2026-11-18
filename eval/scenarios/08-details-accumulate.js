/**
 * MEMORY: details arrive across separate turns (number on one, reason on
 * another). When the message is finally recorded, BOTH must be present in the
 * tool args — nothing dropped between turns.
 */
import * as A from "../asserts.js";

const digits = (s) => String(s || "").replace(/\D/g, "");

export default {
  name: "details-accumulate",
  tags: ["memory"],
  fixture: "messages-only",
  caller: {
    mode: "scripted",
    turns: [
      "Hi, I'd like to leave a message for the owner please.",
      "It's Dana Cole.",
      "The best number is 617-555-0142.",
      "It's about a burst pipe under my kitchen sink.",
      "No, the next business day is fine.",
      "Yes, that's all correct. Thanks so much.",
    ],
  },
  hard: [
    (ctx) => A.toolSucceeded(ctx, "record_customer_request"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "record_customer_request",
        (args) => digits(args.callback_number).includes("6175550142"),
        "callback_number = 617-555-0142"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "record_customer_request",
        (args) => /pipe|sink/i.test(args.message || ""),
        "message mentions the pipe/sink"
      ),
  ],
  judge: [
    "Did the recorded message capture both the caller's callback number and the reason for the call?",
    "Did the receptionist read the number back to confirm it before recording?",
  ],
};
