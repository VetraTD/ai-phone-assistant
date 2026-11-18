/**
 * FREETEXT: a question that matches a knowledge-base entry. The receptionist
 * should convey the KB answer accurately rather than guessing or deflecting.
 * Knowledge is injected via extrasPatch, so any fixture can carry it.
 */
import * as A from "../asserts.js";

export default {
  name: "knowledge-base-answer",
  tags: ["freetext"],
  fixture: "appointments-db",
  extrasPatch: {
    knowledge: [
      {
        question: "Do you offer teeth whitening?",
        answer: "Yes — we offer professional in-office whitening, and a session takes about an hour.",
        category: "services",
      },
    ],
  },
  caller: {
    mode: "scripted",
    turns: [
      "Hi, do you do teeth whitening at your office?",
      "And roughly how long does that take?",
    ],
  },
  hard: [(ctx) => A.replySomewhereMatches(ctx, /whiten/i)],
  judge: [
    "Did the receptionist confirm that in-office teeth whitening is offered?",
    "Was the answer consistent with the knowledge base (about an hour for a session), without inventing extra details?",
  ],
};
