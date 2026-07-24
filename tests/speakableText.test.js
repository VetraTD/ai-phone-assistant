import { describe, it, expect } from "vitest";
import { toSpeakable, expandAbbreviations } from "../lib/voice/speakableText.js";
import { buildSayContent } from "../lib/twiml.js";

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
      expect(toSpeakable("Thanks for calling! \u{1F600}")).toBe("Thanks for calling!");
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

  describe("idempotence — toSpeakable(toSpeakable(x)) === toSpeakable(x)", () => {
    const inputs = [
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
    ];
    it.each(inputs)("is idempotent for: %s", (input) => {
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
