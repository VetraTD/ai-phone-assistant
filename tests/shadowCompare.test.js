// Hammersleys round 4 (item 6): the Deepgram-vs-Live hard-word table. For each
// word the owner says on a test call, which transcript heard it, and what each
// heard instead. Only the hard words and their nearest matches are reported.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hardWordTable, closestMatch } from "../lib/voice/shadowCompare.js";

// Round 4: the image's smoke-verifiers step IMPORTS every migrate-job script,
// so the comparison script must do nothing on import (a pathToFileURL main
// guard, like fallback-urls.js). Without one it prints its usage and exits 2,
// failing the build.
describe("scripts/shadow-compare.js", () => {
  it("does nothing when imported (main guard): the build's smoke import can load it", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('./scripts/shadow-compare.js'); console.log('loaded')"],
      { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" }, timeout: 30_000 }
    );
    expect(out).toContain("loaded");
  });
});

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
  // Owner calls, round 4: how soon after the caller spoke did Deepgram's words
  // arrive? The segment that holds each hard word's best match gives its time
  // (ms since the shadow stream started). Times only, no extra words.
  it("with segments: each row carries the arrival time of the Deepgram segment holding the best match", () => {
    const rows = hardWordTable({
      live: "Play Store Street",
      segments: [
        { t_ms: 4200, text: "Hi, I'd like a taxi." },
        { t_ms: 9800, text: "From 5 Plaistow Street, Lingfield." },
        { t_ms: 15100, text: "To Dormans Land." },
      ],
      words: ["Plaistow Street", "Dormansland", "Gatwick"],
    });
    expect(rows.slice(0, 2).map((r) => [r.word, r.deepgram_exact, r.deepgram_t_ms])).toEqual([
      ["Plaistow Street", true, 9800],
      ["Dormansland", false, 15100],
    ]);
    expect(rows[1].deepgram_closest).toBe("dormans");
    expect(rows[2].deepgram_exact).toBe(false);
  });
  it("no segments heard: the time is null", () => {
    const [row] = hardWordTable({ live: "", segments: [], words: ["Lingfield"] });
    expect(row.deepgram_t_ms).toBeNull();
  });
  it("without segments the time is null (the plain-text form is unchanged)", () => {
    const [row] = hardWordTable({ live: "", deepgram: "Lingfield", words: ["Lingfield"] });
    expect(row.deepgram_exact).toBe(true);
    expect(row.deepgram_t_ms).toBeNull();
  });
  it("caps the list at 12 words", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    expect(hardWordTable({ live: "", deepgram: "", words })).toHaveLength(12);
  });
});
