// Hammersleys round 4 (item 6): the Deepgram-vs-Live hard-word table. For each
// word the owner says on a test call, which transcript heard it, and what each
// heard instead. Only the hard words and their nearest matches are reported.
import { describe, it, expect } from "vitest";
import { hardWordTable, closestMatch } from "../lib/voice/shadowCompare.js";

describe("closestMatch", () => {
  it("finds the exact phrase, case and punctuation aside", () => {
    expect(closestMatch("Ahm, 5 plaistow street, Lingfield.", "Plaistow Street")).toMatchObject({ exact: true, text: "plaistow street", score: 1 });
  });
  it("finds the nearest same-length run of words when misheard", () => {
    const m = closestMatch("Got it. 5 Play Store Street, Springfield, RH7 6AU", "Plaistow Street");
    expect(m.exact).toBe(false);
    expect(m.text).toBe("play store"); // what Live heard for "Plaistow" on round-3 call 1
    expect(m.score).toBeGreaterThan(0.4);
  });
  it("an empty transcript has no match", () => {
    expect(closestMatch("", "Lingfield")).toEqual({ exact: false, text: "", score: 0 });
  });
});

describe("hardWordTable", () => {
  it("one row per hard word, Live beside Deepgram", () => {
    const rows = hardWordTable({
      live: "5 Play Store Street. Springfield. Tomorrow at half eight.",
      deepgram: "5 Plaistow Street, Lingfield. Tomorrow at half eight.",
      words: ["Plaistow Street", "Lingfield", "half eight"],
    });
    expect(rows.map((r) => [r.word, r.live_exact, r.deepgram_exact])).toEqual([
      ["Plaistow Street", false, true],
      ["Lingfield", false, true],
      ["half eight", true, true],
    ]);
    expect(rows[1].live_closest).toBe("springfield");
  });
  it("review M5: a hard 'word' is at most 4 words, so a match never prints more of the call", () => {
    const rows = hardWordTable({
      live: "one two three four five six seven eight nine ten",
      deepgram: "",
      words: ["one two three four five six seven eight nine ten"],
    });
    expect(rows[0].word).toBe("one two three four");
    expect(rows[0].live_closest.split(" ").length).toBeLessThanOrEqual(4);
  });
  it("caps the list at 12 words", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    expect(hardWordTable({ live: "", deepgram: "", words })).toHaveLength(12);
  });
});
