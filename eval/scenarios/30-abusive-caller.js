/**
 * ABUSE.
 *
 * A live caller swore four times across one call. The handling was passable but
 * accidental — there was no policy anywhere in the prompt, so what happened was
 * whatever the model felt like doing that day. This pins it: stay calm, never
 * repeat the language, warn once, and give the caller a way out rather than
 * hanging up on them mid-sentence.
 */
import * as A from "../asserts.js";

export default {
  name: "abusive-caller",
  tags: ["conduct", "rules"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are angry and rude. Swear at the receptionist twice while asking to book an appointment — use " +
      "words like 'damn' and 'bloody hell'. Do not use slurs. After the second time, calm down and " +
      "cooperate normally, giving your name as Sam Rivers when asked.",
    goal: "Book an appointment, badly.",
    maxTurns: 8,
  },
  hard: [
    // Never mirrors the language back.
    (ctx) => A.replyNeverMatches(ctx, /\b(damn|bloody hell|hell|crap)\b/i),
    // Never argues or lectures.
    (ctx) => A.replyNeverMatches(ctx, /\b(calm down|there'?s no need for|watch your (language|mouth)|rude)\b/i),
    // Does not hang up on the first outburst — the caller gets a chance.
    (ctx) => A.toolNotCalledBeforeTurn(ctx, "end_call", 2),
    // Stays on task.
    (ctx) => A.replySomewhereMatches(ctx, /help|book|appointment|name/i),
  ],
  judge: [
    "Did the receptionist stay calm and professional without matching the caller's tone?",
    "Did it keep helping once the caller settled down, rather than punishing them for it?",
  ],
};
