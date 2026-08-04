import { describe, it, expect } from "vitest";
import { SCRIPT_LINES, REPRESENTATIVE_LINES, resolveScriptLines } from "../lib/probe/script.js";

// ---------------------------------------------------------------------------
// The diagnostic script (SCRIPT_LINES) hand-picks utterances to trigger each
// classifyHold branch — 4 of its 8 lines carry an expectRule. That is right for
// exercising the branches, and wrong for sizing what they cost: it made
// classifyHold look like it fires on ~1 in 3 turns.
//
// REPRESENTATIVE_LINES exists to answer the other question. Its shape is taken
// from 1,000 real caller utterances in call_transcripts (aggregate statistics
// only, no transcript text was copied):
//
//   median 6 words · p25 4 · p90 14 · ~25% are 1-3 words · ~34% questions
//   · ~10% contain digits
//
// The tolerances below are wide because the target is "realistic", not "exact".
// They exist to stop this script drifting back into a rigged one.
// ---------------------------------------------------------------------------
const words = (s) => s.trim().split(/\s+/).length;
const pct = (n) => (100 * n) / REPRESENTATIVE_LINES.length;

describe("REPRESENTATIVE_LINES — shaped like real caller speech", () => {
  it("never declares an expected hold rule", () => {
    // The whole point: Deepgram decides where finals land, so the rule mix is
    // an OUTCOME of the run. Naming an expectation here would rig it again.
    for (const line of REPRESENTATIVE_LINES) {
      expect(line.expectRule).toBeUndefined();
    }
  });

  it("has a median length near the real 6 words", () => {
    const w = REPRESENTATIVE_LINES.map((l) => words(l.text)).sort((a, b) => a - b);
    const median = w[Math.floor(w.length / 2)];
    expect(median).toBeGreaterThanOrEqual(4);
    expect(median).toBeLessThanOrEqual(8);
  });

  it("carries the real proportion of short acknowledgements (~25%)", () => {
    expect(pct(REPRESENTATIVE_LINES.filter((l) => words(l.text) <= 3).length)).toBeGreaterThanOrEqual(10);
    expect(pct(REPRESENTATIVE_LINES.filter((l) => words(l.text) <= 3).length)).toBeLessThanOrEqual(40);
  });

  it("carries the real proportion of questions (~34%)", () => {
    const q = REPRESENTATIVE_LINES.filter((l) => /\?\s*$/.test(l.text)).length;
    expect(pct(q)).toBeGreaterThanOrEqual(20);
    expect(pct(q)).toBeLessThanOrEqual(50);
  });

  it("includes digits on roughly one line in ten, and a long tail utterance", () => {
    expect(REPRESENTATIVE_LINES.some((l) => /\d|five|three|seven/i.test(l.text))).toBe(true);
    expect(Math.max(...REPRESENTATIVE_LINES.map((l) => words(l.text)))).toBeGreaterThanOrEqual(12);
  });

  it("still exercises the barge-in path exactly once", () => {
    expect(REPRESENTATIVE_LINES.filter((l) => l.bargeInAfterMs).length).toBe(1);
  });

  it("uses labels that cannot collide with the diagnostic script's cached audio", () => {
    const diag = new Set(SCRIPT_LINES.map((l) => l.label));
    for (const l of REPRESENTATIVE_LINES) expect(diag.has(l.label)).toBe(false);
  });
});

describe("resolveScriptLines", () => {
  it("defaults to the diagnostic script, preserving existing behaviour", () => {
    expect(resolveScriptLines()).toBe(SCRIPT_LINES);
    expect(resolveScriptLines("diagnostic")).toBe(SCRIPT_LINES);
  });

  it("returns the representative script by name", () => {
    expect(resolveScriptLines("representative")).toBe(REPRESENTATIVE_LINES);
  });

  it("refuses an unknown name rather than silently running the wrong script", () => {
    expect(() => resolveScriptLines("nonsense")).toThrow(/unknown probe script/i);
  });
});
