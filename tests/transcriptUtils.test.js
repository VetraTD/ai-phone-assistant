import { describe, it, expect } from "vitest";
import {
  stripFillers,
  cleanTranscript,
  isIncomplete,
  extractFinalIntent,
} from "../lib/transcriptUtils.js";

describe("stripFillers()", () => {
  it("removes standalone filler words, keeping the verb 'like'", () => {
    expect(stripFillers("uh, I'd like to, um, book an appointment")).toBe(
      "I'd like to, book an appointment"
    );
  });

  it("strips filler 'like' when comma-delimited", () => {
    expect(stripFillers("it's, like, Tuesday")).toBe("it's, Tuesday");
  });

  it("returns empty string for pure filler", () => {
    expect(stripFillers("um")).toBe("");
    expect(stripFillers("uh, hmm")).toBe("");
    expect(stripFillers("mm-hmm")).toBe("");
  });

  it("does not strip substrings inside real words", () => {
    expect(stripFillers("umbrella repair")).toBe("umbrella repair");
  });

  it("handles null/non-string input", () => {
    expect(stripFillers(null)).toBe("");
    expect(stripFillers(undefined)).toBe("");
  });
});

describe("cleanTranscript() — short real answers must survive", () => {
  it("keeps one-word real answers", () => {
    expect(cleanTranscript("no")).toBe("no");
    expect(cleanTranscript("yes")).toBe("yes");
    expect(cleanTranscript("morning")).toBe("morning");
    expect(cleanTranscript("Tuesday")).toBe("Tuesday");
  });

  it("keeps a single spoken number", () => {
    expect(cleanTranscript("5")).toBe("5");
    expect(cleanTranscript("five")).toBe("five");
  });

  it("still rejects pure filler", () => {
    expect(cleanTranscript("um")).toBeNull();
    expect(cleanTranscript("uh, hmm")).toBeNull();
    expect(cleanTranscript("okay")).toBeNull();
    expect(cleanTranscript("")).toBeNull();
    expect(cleanTranscript(null)).toBeNull();
  });

  it("still strips fillers from longer utterances", () => {
    expect(cleanTranscript("uh, I'd like to, um, book an appointment")).toBe(
      "I'd like to, book an appointment"
    );
  });
});

describe("isIncomplete() — lead-in and comma holds", () => {
  it("holds trailing lead-in phrases", () => {
    expect(isIncomplete("my name is")).toBe(true);
    expect(isIncomplete("I'm calling about")).toBe(true);
    expect(isIncomplete("I'd like")).toBe(true);
    expect(isIncomplete("the number is")).toBe(true);
    expect(isIncomplete("how about")).toBe(true);
  });

  it("holds a trailing comma (STT punctuated a thinking pause)", () => {
    expect(isIncomplete("I want to book an appointment,")).toBe(true);
  });

  it("does not hold complete sentences", () => {
    expect(isIncomplete("my name is John Smith.")).toBe(false);
    expect(isIncomplete("I'd like to book an appointment for Thursday")).toBe(false);
    expect(isIncomplete("no")).toBe(false);
  });

  it("keeps the original conjunction/digit/date holds", () => {
    expect(isIncomplete("I need an appointment because")).toBe(true);
    expect(isIncomplete("my number is 555 12")).toBe(true);
    expect(isIncomplete("how about January")).toBe(true);
  });
});

describe("extractFinalIntent() — unchanged behavior", () => {
  it("keeps only the corrected half", () => {
    expect(extractFinalIntent("Book at 10 AM, I mean 11 AM please")).toBe("11 AM please");
  });

  it("returns original text without a correction marker", () => {
    expect(extractFinalIntent("book me for Friday")).toBe("book me for Friday");
  });
});
