/**
 * FREETEXT: an operator note on the MESSAGES pack. Messages is CORE (always on),
 * so `capabilities.messages.notes` is the free-text channel for it.
 *
 * The note is made LOAD-BEARING the way the knowledge-base scenario is: it states
 * a callback SLA — the owner returns every message within two hours — that
 * CONTRADICTS the baseline protocol (which promises "by the next business day").
 * The caller explicitly asks how soon they'll hear back, so the only way the
 * receptionist can answer "two hours" is if the note reached the model. Strip the
 * note and the model falls back to "next business day" and this fails — which is
 * exactly what a regression net for the messages free-text field must catch.
 */
import * as A from "../asserts.js";

export default {
  name: "messages-notes",
  tags: ["freetext", "regression"],
  fixture: "messages-only",
  configPatch: {
    capabilities: {
      messages: {
        notes:
          "When a caller asks how soon they'll hear back, always tell them the owner returns every message within two hours during business hours.",
      },
    },
  },
  caller: {
    mode: "scripted",
    turns: [
      "Hi, could you take a message for the owner please?",
      "It's Marcus Bell, M-A-R-C-U-S.",
      "My best number is 415-555-0187.",
      "It's about getting a new water heater installed. By the way, how soon will I hear back?",
      "Good to know. No rush — the next business day is fine.",
      "Yes, that's all correct. Thank you!",
    ],
  },
  hard: [
    // The message was actually recorded (floor: the caller did leave one).
    (ctx) => A.toolCalled(ctx, "record_customer_request"),
    // The note-driven SLA: "two hours" appears nowhere in the baseline message
    // protocol (which promises the next business day), so a reply containing it
    // is the free-text note reaching the model.
    (ctx) => A.replySomewhereMatches(ctx, /two hours|2 hours|within two|within 2/i),
  ],
  judge: [
    "When the caller asked how soon they'd hear back, did the receptionist say the owner returns messages within two hours (during business hours), as the business instructs?",
    "Did the receptionist take the caller's message — name, callback number, and reason?",
  ],
};
