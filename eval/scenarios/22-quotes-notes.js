/**
 * FREETEXT: an operator note on the QUOTES pack. `modules-and-webhook`
 * (Northside Law) is the fixture whose default allowedTasks includes
 * "quote_request", so quotes is genuinely ENABLED here (capabilities/quotes.js
 * only registers record_quote_request and injects its notes when
 * allowedTasks.includes("quote_request")).
 *
 * The note adds a disclaimer the baseline flow does not carry — that any quote is
 * an estimate valid for 30 days. "30 days" is the distinctive, note-only token:
 * it appears nowhere in the pack's own guidance, so a reply containing it is
 * evidence the free-text note reached the model. The pack still forbids quoting
 * an actual price, which the note does not change.
 */
import * as A from "../asserts.js";

export default {
  name: "quotes-notes",
  tags: ["freetext", "regression"],
  fixture: "modules-and-webhook",
  configPatch: {
    capabilities: {
      quotes: {
        notes:
          "Always tell the caller that any quote we provide is an estimate, valid for 30 days.",
      },
    },
  },
  caller: {
    mode: "scripted",
    turns: [
      "Hi, how much do you charge to draft a simple will?",
      "It's Elena Ruiz.",
      "You can reach me at 408-555-0133.",
      "Yes, that's all correct — thank you.",
    ],
  },
  hard: [
    // The quote request was captured (the thing the caller phoned to do).
    (ctx) => A.toolCalled(ctx, "record_quote_request"),
    // The note-driven disclaimer: "30 days" is note-only text, so its presence
    // in a reply is the free-text note landing.
    (ctx) => A.replySomewhereMatches(ctx, /30[\s-]*days/i),
    // The pack's own rule still holds: no invented dollar figure.
    (ctx) => A.replyNeverMatches(ctx, /\$\s?\d/),
  ],
  judge: [
    "Did the receptionist tell the caller that any quote is an estimate valid for 30 days?",
    "Did the receptionist avoid quoting a specific price, taking the caller's details for a follow-up instead?",
  ],
};
