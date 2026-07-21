import { describe, it, expect } from "vitest";
import { toSpeakable } from "../lib/voice/speakableText.js";

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
