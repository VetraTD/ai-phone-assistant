/**
 * FREETEXT: a business-specific directive in customInstructions must be
 * followed. Here, any parking question must surface the validated garage on Oak
 * Street — a fact that exists ONLY in the operator's free-text instruction.
 */
import * as A from "../asserts.js";

export default {
  name: "custom-instructions",
  tags: ["freetext"],
  fixture: "appointments-db",
  configPatch: {
    customInstructions:
      "If anyone asks about parking, always mention the validated garage on Oak Street.",
  },
  caller: {
    mode: "scripted",
    turns: [
      "Hi, quick question — where should I park when I come in for my visit?",
      "Great, thank you!",
    ],
  },
  hard: [(ctx) => A.replySomewhereMatches(ctx, /oak\s*street/i)],
  judge: [
    "When asked about parking, did the receptionist mention the validated garage on Oak Street as instructed?",
  ],
};
