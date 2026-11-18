/**
 * FREETEXT: a tone directive at the top of customInstructions should colour the
 * receptionist's delivery. Tone is inherently fuzzy, so this scenario is
 * judge-only — no hard assertion pretends to measure warmth.
 */
export default {
  name: "tone-preset",
  tags: ["freetext"],
  fixture: "appointments-db",
  configPatch: {
    customInstructions:
      "[Tone] warm and upbeat. Be genuinely friendly, use welcoming language, and sound pleased to help.",
  },
  caller: {
    mode: "scripted",
    turns: [
      "Hi, is this Acme Dental?",
      "Oh good. I think I might need to come in soon but I'm not sure yet.",
    ],
  },
  hard: [],
  judge: [
    "Was the receptionist's tone warm and upbeat, using friendly, welcoming language?",
    "Did the receptionist stay helpful and professional while being friendly (not overfamiliar or robotic)?",
  ],
};
