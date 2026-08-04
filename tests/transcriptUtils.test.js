import { describe, it, expect } from "vitest";
import {
  stripFillers,
  cleanTranscript,
  isIncomplete,
  extractFinalIntent,
  holdDurationFor,
  classifyHold,
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

describe("isIncomplete() — Spanish parity", () => {
  it.each([
    ["necesito una cita para", "trailing preposition"],
    ["quiero reservar y", "trailing conjunction"],
    ["no puedo ir porque", "trailing subordinator"],
    ["mi nombre es", "trailing lead-in"],
    ["me llamo", "trailing lead-in"],
    ["llamo para", "trailing lead-in"],
  ])("holds %s (%s)", (text) => {
    expect(isIncomplete(text)).toBe(true);
  });

  it("does not hold a finished Spanish sentence", () => {
    expect(isIncomplete("Quiero reservar una cita para el martes.")).toBe(false);
  });

  it("does not match a conjunction inside a longer word", () => {
    // "para" must not fire on "reparar"; the \b anchors carry this.
    expect(isIncomplete("necesito reparar")).toBe(false);
  });
});

describe("isIncomplete() — added English lead-ins", () => {
  it.each(["can I", "do you", "is there", "the reason", "we need"])(
    "holds a final ending in %s",
    (text) => {
      expect(isIncomplete(text)).toBe(true);
    }
  );
});

describe("holdDurationFor()", () => {
  it("gives the longest window to a trailing conjunction — the clearest mid-sentence cue", () => {
    expect(holdDurationFor("I need to book an appointment for")).toBe(2_000);
    expect(holdDurationFor("my name is")).toBe(2_000);
  });

  it("waits on a partially dictated number", () => {
    expect(holdDurationFor("my number is 555 12")).toBe(1_500);
  });

  it("does not hold a sentence STT closed with terminal punctuation", () => {
    expect(holdDurationFor("I'd like to book an appointment.")).toBe(0);
    expect(holdDurationFor("Are you open on Saturday?")).toBe(0);
  });

  // 1500 -> 500: this branch was unreachable for ordinary speech while
  // classifyHold sat behind an isIncomplete() gate in lib/voice/session.js. Now
  // that every final is classified it fires often, and 1500ms would hand back
  // more than the whole latency win the 300->150ms endpointing change bought.
  it("holds briefly when there is no terminal punctuation at all", () => {
    expect(holdDurationFor("I'd like to book an appointment")).toBe(500);
  });

  // stripFillers removes a trailing "." (but not "?" or "!"), so the cleaned
  // text handed to classifyHold by session.js has already lost the full stop.
  // Judging punctuation on the cleaned text would therefore hold EVERY
  // declarative sentence a caller speaks. The raw transcript is the authority.
  it("judges terminal punctuation on the raw transcript, not the filler-stripped one", () => {
    expect(classifyHold("I'd like to book an appointment", "I'd like to book an appointment.")).toEqual({
      holdMs: 0,
      rule: "terminal_punctuation",
    });
    // No raw text supplied — falls back to the cleaned text, as before.
    expect(classifyHold("I'd like to book an appointment").rule).toBe("no_terminal_punctuation");
  });

  it("returns 0 for empty input rather than starting a pointless hold", () => {
    expect(holdDurationFor("")).toBe(0);
    expect(holdDurationFor("   ")).toBe(0);
    expect(holdDurationFor(null)).toBe(0);
  });

  it("reports which rule fired, so a too-eager hold can be diagnosed", () => {
    expect(classifyHold("book an appointment for")).toEqual({
      holdMs: 2_000,
      rule: "trailing_conjunction",
    });
    expect(classifyHold("my name is")).toEqual({ holdMs: 2_000, rule: "trailing_lead_in" });
    expect(classifyHold("my number is 555 12")).toEqual({
      holdMs: 1_500,
      rule: "partial_digits",
    });
    expect(classifyHold("Book me for Friday.")).toEqual({
      holdMs: 0,
      rule: "terminal_punctuation",
    });
    expect(classifyHold("book me for Friday")).toEqual({
      holdMs: 500,
      rule: "no_terminal_punctuation",
    });
    expect(classifyHold("")).toEqual({ holdMs: 0, rule: "empty" });
  });

  it("never asks for a hold longer than the pipeline's 3s chain ceiling", () => {
    for (const t of ["for", "and", "555 12", "no punctuation here", "done."]) {
      expect(holdDurationFor(t)).toBeLessThanOrEqual(3_000);
    }
  });
});
