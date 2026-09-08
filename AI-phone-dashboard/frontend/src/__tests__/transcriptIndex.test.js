import { describe, it, expect } from "vitest";
import {
  findActiveWordIndex,
  groupIntoTurns,
  turnIndexForWord,
  formatClock,
  TAIL_SECONDS,
} from "../site/components/transcriptIndex.js";
import transcript from "../site/content/demo-call.transcript.json";

// Twelve words, two speakers, a 3s silence between "today?" and "I".
const WORDS = [
  { w: "Thank", start: 0.0, end: 0.3, speaker: 0 },
  { w: "you", start: 0.3, end: 0.5, speaker: 0 },
  { w: "for", start: 0.5, end: 0.7, speaker: 0 },
  { w: "calling.", start: 0.7, end: 1.2, speaker: 0 },
  { w: "How", start: 1.4, end: 1.6, speaker: 0 },
  { w: "can", start: 1.6, end: 1.8, speaker: 0 },
  { w: "I", start: 1.8, end: 1.9, speaker: 0 },
  { w: "help", start: 1.9, end: 2.2, speaker: 0 },
  { w: "today?", start: 2.2, end: 2.7, speaker: 0 },
  { w: "I", start: 5.7, end: 5.9, speaker: 1 },
  { w: "need", start: 5.9, end: 6.2, speaker: 1 },
  { w: "help.", start: 6.2, end: 6.8, speaker: 1 },
];

describe("findActiveWordIndex", () => {
  it("is -1 before the first word", () => {
    expect(findActiveWordIndex(WORDS, -1)).toBe(-1);
    expect(findActiveWordIndex(WORDS, 0)).toBe(0); // exactly at start counts
  });

  it("returns the word whose start was most recently passed", () => {
    expect(findActiveWordIndex(WORDS, 0.6)).toBe(2);
    expect(findActiveWordIndex(WORDS, 1.9)).toBe(7);
    expect(findActiveWordIndex(WORDS, 5.95)).toBe(10);
  });

  it("keeps the previous word lit through a gap", () => {
    // Between "today?" (ends 2.7) and "I" (starts 5.7).
    expect(findActiveWordIndex(WORDS, 4.0)).toBe(8);
  });

  it("clears after the last word plus the tail", () => {
    const last = WORDS[WORDS.length - 1];
    expect(findActiveWordIndex(WORDS, last.end + TAIL_SECONDS)).toBe(11);
    expect(findActiveWordIndex(WORDS, last.end + TAIL_SECONDS + 0.01)).toBe(-1);
  });

  it("tolerates empty input and NaN time", () => {
    expect(findActiveWordIndex([], 1)).toBe(-1);
    expect(findActiveWordIndex(undefined, 1)).toBe(-1);
    expect(findActiveWordIndex(WORDS, NaN)).toBe(-1);
  });

  it("gives the same answer with any hint as with no hint", () => {
    // Deterministic pseudo-random sweep so the fast path can never disagree
    // with the full search.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 200; k++) {
      const t = rand() * 8 - 0.5;
      const expected = findActiveWordIndex(WORDS, t);
      const hint = Math.floor(rand() * (WORDS.length + 2)) - 1;
      expect(findActiveWordIndex(WORDS, t, hint)).toBe(expected);
    }
  });

  it("works on the real transcript", () => {
    const words = transcript.words;
    expect(words.length).toBeGreaterThan(100);
    expect(findActiveWordIndex(words, words[0].start)).toBe(0);
    const mid = Math.floor(words.length / 2);
    expect(findActiveWordIndex(words, words[mid].start + 0.001)).toBe(mid);
    expect(findActiveWordIndex(words, transcript.duration + 5)).toBe(-1);
  });
});

describe("groupIntoTurns", () => {
  it("splits on speaker change with half-open ranges", () => {
    const turns = groupIntoTurns(WORDS);
    expect(turns).toEqual([
      { speaker: 0, start: 0.0, end: 2.7, from: 0, to: 9 },
      { speaker: 1, start: 5.7, end: 6.8, from: 9, to: 12 },
    ]);
  });

  it("returns [] for no words", () => {
    expect(groupIntoTurns([])).toEqual([]);
  });

  it("matches the turns shipped in the real transcript", () => {
    expect(groupIntoTurns(transcript.words)).toEqual(transcript.turns);
  });
});

describe("turnIndexForWord", () => {
  const turns = groupIntoTurns(WORDS);
  it("finds the containing turn", () => {
    expect(turnIndexForWord(turns, 0)).toBe(0);
    expect(turnIndexForWord(turns, 8)).toBe(0);
    expect(turnIndexForWord(turns, 9)).toBe(1);
    expect(turnIndexForWord(turns, 11)).toBe(1);
  });
  it("is -1 for no active word", () => {
    expect(turnIndexForWord(turns, -1)).toBe(-1);
  });
});

describe("formatClock", () => {
  it("formats m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(163.32)).toBe("2:43");
  });
  it("shows a placeholder when duration is unknown", () => {
    expect(formatClock(NaN)).toBe("–:––");
    expect(formatClock(undefined)).toBe("–:––");
  });
});
