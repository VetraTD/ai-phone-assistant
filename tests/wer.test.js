import { describe, it, expect } from "vitest";
import { normalizeTranscript, wordErrorRate } from "../lib/sttEval/wer.js";

describe("normalizeTranscript — what counts as the same words", () => {
  it("lowercases and drops punctuation", () => {
    expect(normalizeTranscript("Hi, I'd like to book an appointment.")).toEqual([
      "hi", "i'd", "like", "to", "book", "an", "appointment",
    ]);
  });

  it("keeps the apostrophe inside a contraction", () => {
    // "that's" and "thats" are not the same word, and treating them as one
    // would quietly forgive a real recognition difference.
    expect(normalizeTranscript("That's all, thanks.")).toEqual(["that's", "all", "thanks"]);
  });

  it("renders spoken digits and written digits identically", () => {
    // The single most important normalisation in this file. Both providers
    // format numbers, on by default: Deepgram has numerals:true and Google has
    // its own. Comparing "five five five, two" against "5552" would score a
    // 100% error rate for BOTH on a phone number they both heard perfectly.
    expect(normalizeTranscript("My number is five five five, two")).toEqual(
      normalizeTranscript("My number is 5552.")
    );
  });

  it("splits multi-digit runs so grouping is not scored as error", () => {
    expect(normalizeTranscript("1234")).toEqual(["1", "2", "3", "4"]);
    expect(normalizeTranscript("one two three four")).toEqual(["1", "2", "3", "4"]);
  });

  it('treats "oh" as a spoken zero', () => {
    expect(normalizeTranscript("five oh five")).toEqual(["5", "0", "5"]);
  });

  it("is consistent about teens and tens", () => {
    expect(normalizeTranscript("Tuesday at ten")).toEqual(normalizeTranscript("Tuesday at 10"));
  });

  it("collapses whitespace and returns nothing for empty input", () => {
    expect(normalizeTranscript("   ")).toEqual([]);
    expect(normalizeTranscript(null)).toEqual([]);
  });
});

describe("wordErrorRate", () => {
  it("identical transcripts score zero", () => {
    const r = wordErrorRate("book an appointment", "book an appointment");
    expect(r.wer).toBe(0);
    expect(r).toMatchObject({ substitutions: 0, deletions: 0, insertions: 0, refWords: 3 });
  });

  it("counts a substitution", () => {
    const r = wordErrorRate("book an appointment", "book an apartment");
    expect(r.substitutions).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 3);
  });

  it("counts a deletion", () => {
    const r = wordErrorRate("book an appointment", "book appointment");
    expect(r.deletions).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 3);
  });

  it("counts an insertion", () => {
    const r = wordErrorRate("book an appointment", "book an urgent appointment");
    expect(r.insertions).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 3);
  });

  it("an empty hypothesis is a total loss, not a divide by zero", () => {
    const r = wordErrorRate("book an appointment", "");
    expect(r.wer).toBe(1);
    expect(r.deletions).toBe(3);
  });

  it("an empty reference with words heard reports insertions, and WER stays finite", () => {
    const r = wordErrorRate("", "hello there");
    expect(Number.isFinite(r.wer)).toBe(true);
    expect(r.insertions).toBe(2);
  });

  it("WER can exceed 1 when the provider invents words", () => {
    // Standard WER is (S+D+I)/N and is NOT capped at 1. Capping it would hide
    // the worst failure mode there is — a provider hallucinating speech.
    const r = wordErrorRate("yes", "yes i would like four appointments please");
    expect(r.wer).toBeGreaterThan(1);
  });

  it("scores the digit case as perfect once normalised", () => {
    const r = wordErrorRate("My number is five five five, two", "My number is 5552.");
    expect(r.wer).toBe(0);
  });
});
