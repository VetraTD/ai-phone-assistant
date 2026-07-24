/**
 * DECLINE: quotes are OFF (this business has no quote capability and no
 * quote tool). Asked for a price, the receptionist must not invent one; it
 * should decline gracefully and offer to take a message so someone can follow
 * up. messages-only is a plumber — a natural place for a price question.
 */
import * as A from "../asserts.js";

export default {
  name: "disabled-quotes-decline",
  tags: ["decline"],
  fixture: "messages-only",
  caller: {
    mode: "scripted",
    turns: [
      "Hey, how much do you charge to replace a water heater?",
      "I really just need a ballpark number.",
    ],
  },
  hard: [
    (ctx) => A.toolNotCalled(ctx, "record_quote_request"),
    // No dollar figure invented in any reply.
    (ctx) => A.replyNeverMatches(ctx, /\$\s?\d/),
  ],
  judge: [
    "Did the receptionist avoid inventing or estimating a specific price?",
    "Did the receptionist offer an alternative — taking a message or a callback so someone can provide the quote?",
  ],
};
