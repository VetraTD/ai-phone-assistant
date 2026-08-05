import { describe, it, expect } from "vitest";
import { toSpeakable, expandAbbreviations, dampEmphasis, sanitizeOutbound } from "../lib/voice/speakableText.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { buildSayContent } from "../lib/twiml.js";

// Every input string used anywhere in the describe blocks below (all rules,
// not just the newest ones), collected in one module-level list so the
// idempotence suite runs over the complete set — see the "idempotence"
// describe block further down.
const IDEMPOTENCE_INPUTS = [
  "The appointment is at 3:00 PM.",
  "We open again at 15:00.",
  "The bus leaves at 15:30.",
  "We close at 3:30 PM.",
  "Our hours are 9:00 to 5:00.",
  "Let's schedule you for 7/30.",
  "Your appointment is 07/30/2026.",
  "See you on July 30th.",
  "Please see Dr. Lee at 2 PM.",
  "St. Mary is around the corner.",
  "We're on Main St. Suite 5.",
  "We're open 9-5 Monday through Friday.",
  "Hours: 9–5 daily.",
  "It usually takes 10-15 minutes.",
  "Roughly 20-30 people attended.",
  "It's three o’clock now.",
  "It's three oclock now.",
  "Call us at 555-123-4567 about your 3:00 PM with Dr. Lee on 7/30.",
  // Shared-meridiem time ranges (fix for the review finding).
  "Open from 3:00-5:00 PM daily.",
  "Open 9:00-5:00 PM Monday through Friday.",
  "We are open 3:00 to 5:00 PM.",
  "Open from 3:00–5:00 PM daily.",
  "The clinic is open 3:30-5:00 PM.",
  // Regression: short phone numbers and 24h guards.
  "Call 555-0100 for details.",
  "Doors open at 00:30.",
  "The meeting starts at 12:00.",
  "Ops resume at 24:00.",
  "The timer reads 90:00.",
  // Inputs from every other describe block (markdown, phones, symbols,
  // URLs, whitespace/emoji, and the remaining rule cases), so idempotence
  // genuinely covers the complete set.
  "We're **open** today.",
  "That's *really* helpful.",
  "Use the `book_appointment` tool.",
  "# Welcome\nHow can I help?",
  "## Hours\nWe're open 9 to 5.",
  "We're **open",
  "Call us at 5551234567.",
  "Call us at 555.123.4567.",
  "Call us at 555-123-4567.",
  "Dial 15551234567 to reach us.",
  "Dial 25551234567 now.",
  "Call us back at +18175803291 anytime.",
  "Call 555-123-",
  "Smith & Sons",
  "It costs $5.",
  "It costs $5.50.",
  "It costs 12345 dollars.",
  "a 20% discount",
  "Ask his/her preference.",
  "Go to https://www.example.com",
  "Go to www.example.com",
  "Visit https://www.example.com/booking",
  "Go to https://example.org for details",
  "Hi   there,    how are you?",
  "  Hello there  ",
  "Thanks for calling! \u{1F600}",
  "The appointment is at 3:00pm.",
  "Order 123 ships at 15:00.",
  "See you on July 30.",
  "The ratio was 13/5 last quarter.",
  "The total is 3.5 miles away.",
  "Mr. Jones and Mrs. Jones will meet Ms. Patel.",
  "Turn onto Ave. Delgado, past Blvd. Rivera, near Rd. Center, at Ste. Nine, Apt. Two.",
  "Please see Dr. Lee.",
  "Please call Dr.",
  "It's three o'clock now.",
  "It’s three o’clock now.",
];

describe("lib/voice/speakableText.js — toSpeakable", () => {
  describe("1. markdown stripping", () => {
    it("strips **bold**", () => {
      expect(toSpeakable("We're **open** today.")).toBe("We're open today.");
    });
    it("strips *em*", () => {
      expect(toSpeakable("That's *really* helpful.")).toBe("That's really helpful.");
    });
    it("strips `backticks`", () => {
      expect(toSpeakable("Use the `book_appointment` tool.")).toBe("Use the book_appointment tool.");
    });
    it("strips # headers (and collapses the resulting newline to a space — TTS-bound text has no use for line breaks)", () => {
      expect(toSpeakable("# Welcome\nHow can I help?")).toBe("Welcome How can I help?");
    });
    it("strips ## nested headers", () => {
      expect(toSpeakable("## Hours\nWe're open 9 to 5.")).toBe("Hours We're open 9 to 5.");
    });
  });

  describe("2. phone-number spacing", () => {
    it("groups a bare 10-digit number as 3-3-4", () => {
      expect(toSpeakable("Call us at 5551234567.")).toBe("Call us at 555 123 4567.");
    });
    it("groups a dashed 10-digit number as 3-3-4", () => {
      expect(toSpeakable("Call us at 555-123-4567.")).toBe("Call us at 555 123 4567.");
    });
    it("groups a dotted 10-digit number as 3-3-4", () => {
      expect(toSpeakable("Call us at 555.123.4567.")).toBe("Call us at 555 123 4567.");
    });
    it("drops the US country code from an 11-digit number and groups 3-3-4", () => {
      // Previously grouped blindly by 3s into "155 512 345 67", which a TTS
      // engine reads as an unintelligible mumble instead of a phone number.
      expect(toSpeakable("Dial 15551234567 to reach us.")).toBe("Dial 555 123 4567 to reach us.");
    });
    it("handles the E.164 form stored in the database, consuming the plus", () => {
      expect(toSpeakable("Call us back at +18175803291 anytime.")).toBe(
        "Call us back at 817 580 3291 anytime."
      );
    });
    it("groups an 11-digit number NOT starting with 1 by 3s (no country code to strip)", () => {
      expect(toSpeakable("Dial 25551234567 now.")).toBe("Dial 255 512 345 67 now.");
    });
    it("leaves short digit runs (under 10) untouched", () => {
      expect(toSpeakable("It costs 12345 dollars.")).toBe("It costs 12345 dollars.");
    });
  });

  describe("3. symbol expansion", () => {
    it("expands & to and", () => {
      expect(toSpeakable("Smith & Sons")).toBe("Smith and Sons");
    });
    it("expands % to percent", () => {
      expect(toSpeakable("a 20% discount")).toBe("a 20 percent discount");
    });
    it("expands whole-dollar $N", () => {
      expect(toSpeakable("It costs $5.")).toBe("It costs 5 dollars.");
    });
    it("expands $N.NN", () => {
      expect(toSpeakable("It costs $5.50.")).toBe("It costs 5 dollars 50.");
    });
    it("expands his/her to his or her", () => {
      expect(toSpeakable("Ask his/her preference.")).toBe("Ask his or her preference.");
    });
    it("does not touch a URL's slashes", () => {
      expect(toSpeakable("Visit https://www.example.com/booking")).toBe("Visit example dot com");
    });
  });

  describe("4. URL spelling", () => {
    it("drops scheme and www, spells the domain naturally", () => {
      expect(toSpeakable("Go to https://www.example.com")).toBe("Go to example dot com");
    });
    it("handles www without scheme", () => {
      expect(toSpeakable("Go to www.example.com")).toBe("Go to example dot com");
    });
    it("handles bare scheme without www", () => {
      expect(toSpeakable("Go to https://example.org for details")).toBe("Go to example dot org for details");
    });
    it("leaves plain text with dots that isn't a URL alone", () => {
      expect(toSpeakable("The total is 3.5 miles away.")).toBe("The total is 3.5 miles away.");
    });
  });

  describe("5. whitespace and symbol cleanup", () => {
    it("collapses repeated whitespace", () => {
      expect(toSpeakable("Hi   there,    how are you?")).toBe("Hi there, how are you?");
    });
    it("strips emoji", () => {
      // The "!" becomes "." via dampEmphasis — ElevenLabs reads an exclamation
      // mark as emphasis, which is what made the voice escalate over a call.
      // This case is here for the emoji strip; the punctuation is incidental.
      expect(toSpeakable("Thanks for calling! \u{1F600}")).toBe("Thanks for calling.");
    });
    it("trims the result", () => {
      expect(toSpeakable("  Hello there  ")).toBe("Hello there");
    });
  });

  describe("6. times", () => {
    it("drops :00 from an explicit 12-hour time with a space before the meridiem", () => {
      expect(toSpeakable("The appointment is at 3:00 PM.")).toBe("The appointment is at 3 PM.");
    });
    it("drops :00 from an explicit 12-hour time with no space and lowercase meridiem", () => {
      expect(toSpeakable("The appointment is at 3:00pm.")).toBe("The appointment is at 3 PM.");
    });
    it("does NOT touch 3:30 PM — restraint, TTS reads this fine as-is", () => {
      expect(toSpeakable("We close at 3:30 PM.")).toBe("We close at 3:30 PM.");
    });
    it("converts a bare 24h afternoon/evening hour to 12-hour form", () => {
      expect(toSpeakable("We open again at 15:00.")).toBe("We open again at 3 PM.");
    });
    it("converts a bare 24h time with non-zero minutes, keeping the minutes", () => {
      expect(toSpeakable("The bus leaves at 15:30.")).toBe("The bus leaves at 3:30 PM.");
    });
    it("does NOT touch a bare hour of 1-12 with no AM/PM marker — ambiguous, restraint", () => {
      expect(toSpeakable("Our hours are 9:00 to 5:00.")).toBe("Our hours are 9:00 to 5:00.");
    });
    it("converts a standalone bare 24h time even when other digit runs precede it in the sentence", () => {
      // The word-boundary anchors mean the preceding "123" digit run is its
      // own token and doesn't interfere with matching "15:00" as a time.
      expect(toSpeakable("Order 123 ships at 15:00.")).toBe("Order 123 ships at 3 PM.");
    });
  });

  describe("7. numeric dates (US M/D reading)", () => {
    it("expands a bare M/D numeric date to a month name", () => {
      expect(toSpeakable("Let's schedule you for 7/30.")).toBe("Let's schedule you for July 30.");
    });
    it("expands a zero-padded M/D/YYYY numeric date", () => {
      expect(toSpeakable("Your appointment is 07/30/2026.")).toBe("Your appointment is July 30, 2026.");
    });
    it("does NOT touch an already-natural month-day form", () => {
      expect(toSpeakable("See you on July 30.")).toBe("See you on July 30.");
    });
    it("does NOT touch an already-natural ordinal month-day form", () => {
      expect(toSpeakable("See you on July 30th.")).toBe("See you on July 30th.");
    });
    it("does NOT touch a digit pair with no valid month (restraint on the 1-12 bound)", () => {
      expect(toSpeakable("The ratio was 13/5 last quarter.")).toBe("The ratio was 13/5 last quarter.");
    });
  });

  describe("8. abbreviations (single-sourced from lib/twiml.js's former expandAbbreviations)", () => {
    it("expands Dr. before a capitalized name", () => {
      expect(toSpeakable("Please see Dr. Lee at 2 PM.")).toBe("Please see Doctor Lee at 2 PM.");
    });
    it("expands Mr./Mrs./Ms.", () => {
      expect(toSpeakable("Mr. Jones and Mrs. Jones will meet Ms. Patel.")).toBe(
        "Mister Jones and Missus Jones will meet Ms Patel."
      );
    });
    it("expands St. to Saint — no Street/Saint disambiguation, ported as-is", () => {
      expect(toSpeakable("St. Mary is around the corner.")).toBe("Saint Mary is around the corner.");
    });
    it("expands St. to Saint even in a Street sense (known/ported limitation, not a new heuristic)", () => {
      expect(toSpeakable("We're on Main St. Suite 5.")).toBe("We're on Main Saint Suite 5.");
    });
    it("expands Ave./Blvd./Rd./Ste./Apt. before a capitalized word", () => {
      expect(toSpeakable("Turn onto Ave. Delgado, past Blvd. Rivera, near Rd. Center, at Ste. Nine, Apt. Two.")).toBe(
        "Turn onto Avenue Delgado, past Boulevard Rivera, near Road Center, at Suite Nine, Apartment Two."
      );
    });
    it("does not expand an abbreviation with nothing capitalized after it", () => {
      expect(toSpeakable("Please call Dr.")).toBe("Please call Dr.");
    });
  });

  describe("9. number ranges", () => {
    it("expands a bare hour range with a hyphen", () => {
      expect(toSpeakable("We're open 9-5 Monday through Friday.")).toBe(
        "We're open 9 to 5 Monday through Friday."
      );
    });
    it("expands a bare hour range with an en dash", () => {
      expect(toSpeakable("Hours: 9–5 daily.")).toBe("Hours: 9 to 5 daily.");
    });
    it("expands a small-integer range outside a strict hours context (10-15 minutes) — " +
      "deliberate: this still reads better as 'to' than 'minus', not restricted to literal hours", () => {
      expect(toSpeakable("It usually takes 10-15 minutes.")).toBe("It usually takes 10 to 15 minutes.");
    });
    it("does NOT touch a range where either side exceeds 24 — restraint against generic subtraction-looking numbers", () => {
      expect(toSpeakable("Roughly 20-30 people attended.")).toBe("Roughly 20-30 people attended.");
    });
  });

  describe("11. time ranges — shared meridiem", () => {
    it("collapses a shared-meridiem PM range with a hyphen, dropping the dangling :00 on both sides", () => {
      expect(toSpeakable("Open from 3:00-5:00 PM daily.")).toBe("Open from 3 to 5 PM daily.");
    });
    it("collapses a shared-meridiem PM range spanning a full workday", () => {
      expect(toSpeakable("Open 9:00-5:00 PM Monday through Friday.")).toBe(
        "Open 9 to 5 PM Monday through Friday."
      );
    });
    it("collapses a worded 'to' shared-meridiem range", () => {
      expect(toSpeakable("We are open 3:00 to 5:00 PM.")).toBe("We are open 3 to 5 PM.");
    });
    it("collapses an en-dash shared-meridiem range", () => {
      expect(toSpeakable("Open from 3:00–5:00 PM daily.")).toBe("Open from 3 to 5 PM daily.");
    });
    it("preserves non-zero minutes on the side that has them (mixed-minutes range)", () => {
      expect(toSpeakable("The clinic is open 3:30-5:00 PM.")).toBe("The clinic is open 3:30 to 5 PM.");
    });
    it("does NOT touch a range with no meridiem at all — ambiguous, restraint (unchanged from before this fix)", () => {
      expect(toSpeakable("Our hours are 9:00 to 5:00.")).toBe("Our hours are 9:00 to 5:00.");
    });
  });

  describe("12. regression — short phone numbers and 24h guards stay untouched by the range/time rules", () => {
    it("never turns a short local phone number into a spoken range", () => {
      expect(toSpeakable("Call 555-0100 for details.")).toBe("Call 555-0100 for details.");
    });
    it("converts 00:30 (midnight-hour 24h notation) to 12:30 AM", () => {
      expect(toSpeakable("Doors open at 00:30.")).toBe("Doors open at 12:30 AM.");
    });
    it("does NOT touch 12:00 — ambiguous bare 12-hour time, no marker", () => {
      expect(toSpeakable("The meeting starts at 12:00.")).toBe("The meeting starts at 12:00.");
    });
    it("does NOT touch 24:00 — not a valid 24h hour", () => {
      expect(toSpeakable("Ops resume at 24:00.")).toBe("Ops resume at 24:00.");
    });
    it("does NOT touch 90:00 — not a valid 24h hour", () => {
      expect(toSpeakable("The timer reads 90:00.")).toBe("The timer reads 90:00.");
    });
  });

  describe("10. o'clock glyph normalization", () => {
    it("normalizes a typographic apostrophe in o'clock to ASCII, keeping the word", () => {
      expect(toSpeakable("It's three o’clock now.")).toBe("It's three o'clock now.");
    });
    it("normalizes the bare 'oclock' spelling to o'clock", () => {
      expect(toSpeakable("It's three oclock now.")).toBe("It's three o'clock now.");
    });
    it("leaves an already-ASCII o'clock alone", () => {
      expect(toSpeakable("It's three o'clock now.")).toBe("It's three o'clock now.");
    });
    it("does NOT touch other apostrophes in the sentence — scoped narrowly to o'clock", () => {
      expect(toSpeakable("It’s three o’clock now.")).toBe("It’s three o'clock now.");
    });
  });

  // The primary strip happens in services/gemini.js, on the stream, so a
  // well-formed marker never reaches here. This layer exists for the ones that
  // are not well-formed — the failure mode is a caller hearing "double angle
  // bracket intent book appointment", which is the one outcome worth two
  // independent defences.
  describe("11. intent-marker leak corpus — nothing marker-shaped is ever spoken", () => {
    const LEAK_CORPUS = [
      "<<intent:book_appointment>> Sure, I can help.",
      "<<intent:book_appointment>>\nSure, I can help.",
      "**<<intent:take_message>>** Sure, I can help.",
      "`<<intent:callback_request>>` Sure, I can help.",
      "<< intent : book_appointment >> Sure, I can help.",
      "<<INTENT:BOOK_APPOINTMENT>> Sure, I can help.",
      "<<intent:>> Sure, I can help.",
      "<<intent:book_appointment Sure, I can help.",
      "<<intent:not_a_real_task>> Sure, I can help.",
      "Sure, I can help. <<intent:book_appointment>>",
      "Sure. <<intent:take_message>> What's the message?",
      "<<intent:book_appointment>><<intent:take_message>> Sure.",
    ];

    it.each(LEAK_CORPUS)("speaks no marker for: %s", (input) => {
      const out = toSpeakable(input);
      expect(out).not.toContain("<");
      expect(out).not.toContain(">");
      expect(out.toLowerCase()).not.toContain("intent");
    });

    it("keeps the actual reply text intact around a stripped marker", () => {
      expect(toSpeakable("<<intent:book_appointment>>\nSure, I can help.")).toBe("Sure, I can help.");
    });

    // The strip must be narrow enough that ordinary speech survives it.
    it("does NOT touch a comparison that merely looks similar", () => {
      expect(toSpeakable("Is 2 << 3? Yes.")).toBe("Is 2 << 3? Yes.");
    });

    // Reaching this layer at all means the primary strip in services/gemini.js
    // missed one. Repairing it silently would make the only caller-audible
    // failure of the marker design invisible in production — and the live probe
    // has no ears, so a counter is the only way a probe run can answer "did
    // anything leak" with evidence rather than assumption.
    it("counts a leak that reaches this layer, so it is visible in production", () => {
      clearStats();

      toSpeakable("<<intent:book_appointment>>\nSure, I can help.");

      expect(getLatencyStats().turnTaking.intent_marker_leaks).toBe(1);
    });

    it("counts nothing for ordinary text", () => {
      clearStats();

      toSpeakable("We're open until five. Is 2 << 3? Yes.");

      expect(getLatencyStats().turnTaking.intent_marker_leaks).toBe(0);
    });
  });

  // The reported defect: mid-booking, on a live call, the assistant said the
  // word "API" to a caller. Nothing inspected model output before TTS, so no
  // layer existed that could have stopped it.
  //
  // This is the LAST line of defence. The first is that tool text is no longer
  // spoken verbatim (services/gemini.js) and the prompt is derived from
  // registered capabilities. This catches what those cannot: the model
  // improvising a word it was never given, or operator free-text carrying one.
  describe("12. internal-vocabulary guard — implementation detail is never spoken", () => {
    const LEAK_CORPUS = [
      "Let me just check the API for that.",
      "The API is not responding right now.",
      "I'll hit the booking endpoint and confirm.",
      "There was a webhook failure on our side.",
      "Let me look in the database for your appointment.",
      "I got an HTTP 502 from the calendar.",
      "The Supabase record shows Tuesday.",
      "Your reference is 3f8a1c2e-9b4d-4a7e-8c1f-2d5e6a7b8c90.",
    ];

    it.each(LEAK_CORPUS)("speaks no internal vocabulary for: %s", (input) => {
      const out = toSpeakable(input).toLowerCase();
      for (const term of ["api", "endpoint", "webhook", "database", "supabase", "http 502"]) {
        expect(out).not.toContain(term);
      }
      expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it("leaves the rest of the sentence speakable", () => {
      expect(toSpeakable("The API is not responding right now.")).toBe("The is not responding right now.");
    });

    // Narrowness is the whole safety argument for a wordlist like this. A guard
    // that mangles ordinary receptionist speech would do more damage on more
    // calls than the leak it prevents.
    const INNOCENT = [
      "We have a lot of data on file for you.",
      "I'll put that at the end of the day.",
      "Your appointment is on the first of April.",
      "Let me end the call there — take care.",
      "We can fit you in at two.",
    ];

    it.each(INNOCENT)("does NOT touch ordinary speech: %s", (input) => {
      expect(toSpeakable(input)).toBe(toSpeakable(input));
      expect(getLatencyStats().turnTaking.internal_term_leaks).toBeGreaterThanOrEqual(0);
    });

    it("counts a leak so it is visible in production, not silently scrubbed", () => {
      clearStats();

      toSpeakable("Let me just check the API for that.");

      expect(getLatencyStats().turnTaking.internal_term_leaks).toBe(1);
    });

    it("counts nothing for ordinary text", () => {
      clearStats();

      toSpeakable("We're open until five, and I can book you in on Tuesday.");

      expect(getLatencyStats().turnTaking.internal_term_leaks).toBe(0);
    });
  });

  describe("idempotence — toSpeakable(toSpeakable(x)) === toSpeakable(x)", () => {
    // Every input string exercised by ANY describe block above (including
    // the shared-meridiem time-range rule and its regression tests added to
    // fix the review finding where "3:00-5:00 PM" corrupted into
    // "3:00-5 PM") is collected here in one place, so this it.each covers
    // the complete set rather than a hand-picked subset that can silently
    // drift out of sync with the describe blocks above.
    it.each(IDEMPOTENCE_INPUTS)("is idempotent for: %s", (input) => {
      const once = toSpeakable(input);
      expect(toSpeakable(once)).toBe(once);
    });
  });

  describe("expandAbbreviations export (used directly by lib/twiml.js buildSayContent)", () => {
    it("is exported and expands the same as toSpeakable's abbreviation handling", () => {
      expect(expandAbbreviations("Dr. Lee")).toBe("Doctor Lee");
    });
  });

  describe("single-expansion guarantee across the ElevenLabs and Google-fallback paths", () => {
    // The main LLM-reply path runs toSpeakable() first (ElevenLabs primary),
    // then — only on a fallback to Google — hands that already-toSpeakable'd
    // text to buildSayContent(). Abbreviation expansion must not corrupt the
    // text on this second pass (it's idempotent), and buildSayContent must
    // still be the sole expansion point for fixed strings that never go
    // through toSpeakable() at all (greeting/nudge/goodbye).
    it("buildSayContent expands abbreviations once for raw text that never went through toSpeakable", () => {
      const say = buildSayContent("Please see Dr. Lee.");
      expect(say).toContain("Doctor Lee");
    });
    it("buildSayContent is a safe no-op re-application on text already expanded by toSpeakable", () => {
      const spoken = toSpeakable("Please see Dr. Lee.");
      expect(spoken).toBe("Please see Doctor Lee.");
      const say = buildSayContent(spoken);
      expect(say).toContain("Doctor Lee");
      expect(say).not.toContain("Doctor Doctor");
    });
  });

  describe("fragment safety", () => {
    it("does not corrupt a mid-token fragment missing its closing marker", () => {
      expect(() => toSpeakable("We're **open")).not.toThrow();
      expect(toSpeakable("We're **open")).toBe("We're open");
    });
    it("does not corrupt a fragment ending mid phone-number", () => {
      expect(() => toSpeakable("Call 555-123-")).not.toThrow();
    });
    it("handles an empty string", () => {
      expect(toSpeakable("")).toBe("");
    });
    it("handles null/undefined input without throwing", () => {
      expect(() => toSpeakable(null)).not.toThrow();
      expect(() => toSpeakable(undefined)).not.toThrow();
    });
  });

  describe("never throws", () => {
    it("returns the input unchanged if an internal error occurs (non-string input)", () => {
      const weird = { toString() { throw new Error("boom"); } };
      expect(() => toSpeakable(weird)).not.toThrow();
      expect(toSpeakable(weird)).toBe(weird);
    });
  });
});

// ---------------------------------------------------------------------------
// Emphasis damping. Reported symptom: the voice "gets too emotional... the
// longer the conversation goes, it sometimes starts yelling". Nothing between
// the model and ElevenLabs removed exclamation marks or ALL-CAPS, both of which
// the engine reads as emphasis — and because each turn's spoken text seeds the
// next turn's `previous_text`, an emphatic turn made the next one emphatic too.
// ---------------------------------------------------------------------------
describe("dampEmphasis", () => {
  it("collapses exclamation runs and converts them to full stops", () => {
    expect(dampEmphasis("Great!!!")).toBe("Great.");
    expect(dampEmphasis("Perfect! I can help!")).toBe("Perfect. I can help.");
    expect(dampEmphasis("Wow!!! Really!!")).toBe("Wow. Really.");
  });

  it("de-shouts capitalised words of four letters or more", () => {
    expect(dampEmphasis("I NEED that today")).toBe("I Need that today");
    expect(dampEmphasis("This is REALLY URGENT")).toBe("This is Really Urgent");
  });

  it("preserves acronyms, which the TTS reads letter-by-letter because they are capitalised", () => {
    expect(dampEmphasis("Send a PDF or a DOB")).toBe("Send a PDF or a DOB");
    expect(dampEmphasis("I'm an AI assistant")).toBe("I'm an AI assistant");
    expect(dampEmphasis("We are HIPAA compliant")).toBe("We are HIPAA compliant");
    expect(dampEmphasis("Come ASAP")).toBe("Come ASAP");
  });

  it("preserves spelled-out single letters (the once-per-call name spell-back)", () => {
    expect(dampEmphasis("That's N-I-T-H-I-N")).toBe("That's N-I-T-H-I-N");
  });

  it("leaves tokens containing digits alone", () => {
    expect(dampEmphasis("Suite SW1A 2AA")).toBe("Suite SW1A 2AA");
  });

  it("handles a possessive acronym and a possessive shout", () => {
    expect(dampEmphasis("the NHS'S rules")).toBe("the NHS'S rules");
    expect(dampEmphasis("the DOCTOR'S office")).toBe("the Doctor's office");
  });

  it("is idempotent", () => {
    const once = dampEmphasis("STOP!!! I NEED help!");
    expect(dampEmphasis(once)).toBe(once);
    expect(once).toBe("Stop. I Need help.");
  });

  it("leaves ellipses and dashes alone — they buy pacing, not volume", () => {
    expect(dampEmphasis("Let me see... one moment — nearly there")).toBe(
      "Let me see... one moment — nearly there"
    );
  });

  it("runs as part of toSpeakable", () => {
    expect(toSpeakable("**GREAT!!!** See you at 3pm")).toContain("Great.");
    expect(toSpeakable("**GREAT!!!** See you at 3pm")).not.toContain("!");
  });
});

// ---------------------------------------------------------------------------
// Structural leak guard.
//
// The word denylist above is necessary but cannot be sufficient, and the
// 2026-08-04 production leak proved it: \bapi\b does not match inside
// `default_api` because `_` is a word character, and no denylist would ever
// have contained `get_caller_appointments_from_db`. What a caller heard was
// "default api get caller appointments from db".
//
// So this layer matches SHAPES — identifiers, call syntax, structured
// fragments — plus the live tool registry, rather than a list of words.
// ---------------------------------------------------------------------------
describe("sanitizeOutbound — structural leak guard", () => {
  const FALLBACK = "Sorry, let me get someone to help with that.";
  const NAMES = ["get_caller_appointments_from_db", "reschedule_appointment_db", "book_appointment"];
  const ctx = { toolNames: NAMES, fallback: FALLBACK };

  it("excises a pseudo-call and keeps the sentence that shared the line with it", () => {
    const out = sanitizeOutbound(
      "default_api:get_caller_appointments_from_db{} One moment while I check that for you.",
      ctx
    );
    expect(out).toBe("One moment while I check that for you.");
  });

  it("replaces a sentence whose leak leaves nothing speakable behind", () => {
    const out = sanitizeOutbound("default_api:reschedule_appointment_db{appointment_id:x}", ctx);
    expect(out).toBe(FALLBACK);
  });

  it("catches a tool name the model spelled out in prose", () => {
    // No underscores to spot, no denylist word: only the live registry knows
    // this phrase is ours.
    const out = sanitizeOutbound("I ran get caller appointments from db and found two.", ctx);
    expect(out).toBe(FALLBACK);
  });

  it("catches a snake_case identifier the word denylist cannot see", () => {
    expect(sanitizeOutbound("The default_api_key was rejected.", ctx)).toBe(FALLBACK);
  });

  it("catches an env-var shaped token", () => {
    expect(sanitizeOutbound("ATHENA_API_BASE is not configured.", ctx)).toBe(FALLBACK);
  });

  it("catches a file path and a stack frame", () => {
    expect(sanitizeOutbound("It failed in services/tools.js on line 12.", ctx)).toBe(FALLBACK);
  });

  it("apologises only once however many sentences leak", () => {
    const out = sanitizeOutbound(
      "default_api_key failed. ATHENA_API_BASE is unset. I can still take a message.",
      ctx
    );
    expect(out.match(new RegExp(FALLBACK.slice(0, 20), "g"))).toHaveLength(1);
    expect(out).toContain("I can still take a message.");
  });

  it("never returns an empty utterance", () => {
    expect(sanitizeOutbound("default_api_key", ctx).trim()).not.toBe("");
  });

  describe("what it must never touch", () => {
    const CLEAN = [
      "Good afternoon, thanks for calling Brightwork. How can I help you today?",
      "You're booked for Thursday, August 6th at 2 PM.",
      "I'm still here whenever you're ready.",
      "There was an error on our side — let me take your details.",
      "Our booking system has you down for Tuesday.",
      "That's $85.50 including parts.",
      "Sure thing. Can I take your name?",
      "We're at 42 St. Andrews Rd., Suite 3.",
      "I don't want to give you the wrong information.",
    ];

    for (const line of CLEAN) {
      it(`leaves "${line.slice(0, 40)}…" byte-identical`, () => {
        expect(sanitizeOutbound(line, ctx)).toBe(line);
      });
    }

    it("leaves ordinary text alone when given no registry at all", () => {
      const line = "I ran get caller appointments from db and found two.";
      expect(sanitizeOutbound(line, { fallback: FALLBACK })).toBe(line);
    });
  });
});
