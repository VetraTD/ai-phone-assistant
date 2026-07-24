/**
 * FREE-TEXT WRAPPING NET (Task 12 / plan 2.6).
 *
 * Every operator free-text field that reaches the model must be delimiter-wrapped
 * ([BEGIN BUSINESS CONFIG] … [END BUSINESS CONFIG]) so PROMPT SAFETY can tell the
 * model to treat it as data, never instructions. The snapshots lock the exact
 * text; this suite locks the STRUCTURAL invariant instead — it fails the moment
 * someone adds a new free-text field and injects it raw, which a byte-snapshot
 * would happily record as "just the new text".
 *
 * It drives the real prompt builder with a synthetic config whose every free-text
 * field carries a distinctive marker, then asserts each marker lands INSIDE a
 * matched delimiter pair and never leaks outside one.
 *
 * TWO fields are intentionally OUTSIDE the delimiters and asserted so:
 *   - the greeting tail line — engine-sanitized context (sanitizeFact strips the
 *     very structure tokens the delimiters would protect, and bounds length), not
 *     operator instructions echoed verbatim.
 *   - the custom identity `ask` — operator-authored spoken SCRIPT rendered into a
 *     guardrail bullet / tool-param description, bounded at validation (300 chars),
 *     and never a block of prose the model could be steered by.
 */

import { describe, it, expect } from "vitest";
import { buildSystemInstruction } from "../services/gemini.js";
import { normalizeAllowedTasks } from "../services/supabase.js";

const M = {
  generalInfo: "MARKER_GENERAL_INFO_7f3a",
  customInstructions: "MARKER_CUSTOM_RULES_7f3a",
  capabilityNotes: "MARKER_CAP_NOTES_7f3a",
  kbQuestion: "MARKER_KB_QUESTION_7f3a",
  kbAnswer: "MARKER_KB_ANSWER_7f3a",
  // Intentional exceptions — surfaced OUTSIDE the delimiters.
  greeting: "MARKER_GREETING_7f3a",
  identityAsk: "MARKER_IDENTITY_ASK_7f3a",
};

const CONFIG = {
  businessName: "Marker Test Clinic",
  greeting: M.greeting,
  timezone: "America/Chicago",
  businessHours: null,
  transferPhoneNumber: "+15551230000",
  allowedTasks: normalizeAllowedTasks(["book_appointment", "check_appointment", "cancel_reschedule"]),
  mainPhone: "555-0100",
  generalInfo: M.generalInfo,
  afterHoursPolicy: "take_message",
  transferPolicy: "always",
  languagesSpoken: ["en"],
  customInstructions: M.customInstructions,
  capabilities: {
    appointments: {
      enabled: true,
      adapter: "internal",
      notes: M.capabilityNotes,
      require: {
        identity: {
          custom: [{ key: "member_id", label: "Member ID", ask: M.identityAsk, verify: "collect_only" }],
        },
      },
    },
  },
};

const EXTRAS = {
  knowledge: [{ question: M.kbQuestion, answer: M.kbAnswer, category: null }],
  callerContext: null,
  transferAllowed: true,
  integrations: [],
};

const BEGIN = "[BEGIN BUSINESS CONFIG]";
const END = "[END BUSINESS CONFIG]";

/**
 * Partition a prompt into the text INSIDE matched delimiter pairs and the text
 * OUTSIDE them. A simple linear scan — the delimiters never nest in this prompt.
 */
function partition(prompt) {
  let inside = "";
  let outside = "";
  let i = 0;
  while (i < prompt.length) {
    const b = prompt.indexOf(BEGIN, i);
    if (b === -1) {
      outside += prompt.slice(i);
      break;
    }
    outside += prompt.slice(i, b);
    const e = prompt.indexOf(END, b + BEGIN.length);
    // An unmatched [BEGIN is itself a bug — treat the remainder as unwrapped so
    // the "must be inside" assertions catch it rather than silently passing.
    if (e === -1) {
      outside += prompt.slice(b);
      break;
    }
    inside += prompt.slice(b + BEGIN.length, e);
    i = e + END.length;
  }
  return { inside, outside };
}

describe("operator free-text is delimiter-wrapped at injection", () => {
  const prompt = buildSystemInstruction("gather_details", "book_appointment", CONFIG, EXTRAS);
  const { inside, outside } = partition(prompt);

  it.each([
    ["generalInfo", M.generalInfo],
    ["customInstructions", M.customInstructions],
    ["capability notes", M.capabilityNotes],
    ["knowledge question", M.kbQuestion],
    ["knowledge answer", M.kbAnswer],
  ])("%s is wrapped in [BEGIN/END BUSINESS CONFIG]", (_label, marker) => {
    // Sanity: the marker actually made it into the prompt (guards against a
    // silently-dropped field making the wrapping assertion vacuously true).
    expect(prompt).toContain(marker);
    expect(inside).toContain(marker);
    expect(outside).not.toContain(marker);
  });

  it("the greeting context line is intentionally OUTSIDE the delimiters (engine-sanitized)", () => {
    expect(prompt).toContain(M.greeting);
    expect(outside).toContain(M.greeting);
    expect(inside).not.toContain(M.greeting);
  });

  it("the custom identity ask is intentionally OUTSIDE the delimiters (bounded spoken script)", () => {
    expect(prompt).toContain(M.identityAsk);
    expect(outside).toContain(M.identityAsk);
    expect(inside).not.toContain(M.identityAsk);
  });

  it("every [BEGIN BUSINESS CONFIG] has a matching [END BUSINESS CONFIG]", () => {
    const begins = prompt.split(BEGIN).length - 1;
    const ends = prompt.split(END).length - 1;
    expect(begins).toBe(ends);
    expect(begins).toBeGreaterThan(0);
  });
});
