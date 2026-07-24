/**
 * FREETEXT: a question answerable only from generalInfo ("Emergency callouts
 * available 24/7"). The receptionist should answer correctly AND must not leak
 * any of the prompt's config scaffolding (delimiters, section headers) verbatim.
 */
import * as A from "../asserts.js";

export default {
  name: "general-info-recall",
  tags: ["freetext"],
  fixture: "messages-only",
  caller: {
    mode: "scripted",
    turns: [
      "Hi, do you guys do emergency callouts, like in the middle of the night?",
      "Perfect, good to know. Thanks!",
    ],
  },
  hard: [
    (ctx) => A.replySomewhereMatches(ctx, /24\/?7|emergency|any\s*time|around the clock|day or night/i),
    // No prompt scaffolding leaked into a spoken reply.
    (ctx) => A.replyNeverMatches(ctx, /BUSINESS CONFIG|===|generalInfo|systemInstruction/i),
  ],
  judge: [
    "Did the receptionist correctly convey that emergency callouts are available 24/7?",
    "Did the receptionist avoid quoting internal configuration text, delimiters, or section headers?",
  ],
};
