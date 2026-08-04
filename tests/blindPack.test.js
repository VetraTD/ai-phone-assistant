import { describe, it, expect } from "vitest";
import { buildBlindPack } from "../lib/tts/blindPack.js";

// ---------------------------------------------------------------------------
// The listening test is the one part of this work a machine cannot do, which
// makes it the part most vulnerable to the listener knowing which sample is
// which. Incumbent bias is real: told that a clip is the current vendor, a
// listener hears it as "fine", and told it is a challenger, hears the same
// clip as "different".
//
// So the pack strips vendor identity from filenames, randomises order within
// each sentence, and writes the mapping to a key that isn't opened until the
// scoring is done. Seeded so a pack can be regenerated exactly.
// ---------------------------------------------------------------------------

const PROVIDERS = ["elevenlabs", "cartesia", "inworld", "gemini"];

function items(lines = ["greeting", "spelling"]) {
  return lines.flatMap((line) =>
    PROVIDERS.map((provider) => ({
      provider,
      line,
      mulaw: Buffer.alloc(160, 0x10),
      ttfaMs: 100,
    }))
  );
}

describe("buildBlindPack — enforcing blindness on the listening test", () => {
  it("includes every sample exactly once", () => {
    const pack = buildBlindPack({ items: items(), seed: 1 });

    expect(pack.entries.length).toBe(8);
    const seen = pack.entries.map((e) => `${e.line}:${e.provider}`).sort();
    expect(new Set(seen).size).toBe(8);
  });

  it("keeps the vendor out of every filename", () => {
    const pack = buildBlindPack({ items: items(), seed: 1 });

    for (const entry of pack.entries) {
      for (const provider of PROVIDERS) {
        expect(entry.filename.toLowerCase()).not.toContain(provider);
      }
    }
  });

  it("keeps sentences grouped so the scorecard can be followed in order", () => {
    // Order WITHIN a sentence is randomised; the sentences themselves stay in
    // script order, or the listener cannot tell which row to score.
    const pack = buildBlindPack({ items: items(["greeting", "spelling"]), seed: 3 });
    const lines = pack.entries.map((e) => e.line);

    expect(lines.slice(0, 4).every((l) => l === "greeting")).toBe(true);
    expect(lines.slice(4).every((l) => l === "spelling")).toBe(true);
  });

  it("shuffles providers within a sentence rather than leaving script order", () => {
    const pack = buildBlindPack({ items: items(["greeting"]), seed: 7 });
    const order = pack.entries.map((e) => e.provider);

    expect(order).not.toEqual(PROVIDERS);
    expect([...order].sort()).toEqual([...PROVIDERS].sort());
  });

  it("varies the order between sentences so position is not a tell", () => {
    // If every sentence played the vendors in the same order, one identified
    // clip would deanonymise the whole pack.
    const pack = buildBlindPack({ items: items(["a", "b", "c", "d"]), seed: 11 });
    const perLine = ["a", "b", "c", "d"].map((line) =>
      pack.entries.filter((e) => e.line === line).map((e) => e.provider).join(",")
    );

    expect(new Set(perLine).size).toBeGreaterThan(1);
  });

  it("reproduces the same pack for the same seed", () => {
    const a = buildBlindPack({ items: items(), seed: 42 });
    const b = buildBlindPack({ items: items(), seed: 42 });

    expect(a.entries.map((e) => e.filename)).toEqual(b.entries.map((e) => e.filename));
    expect(a.entries.map((e) => e.provider)).toEqual(b.entries.map((e) => e.provider));
  });

  it("produces a different arrangement for a different seed", () => {
    const a = buildBlindPack({ items: items(["a", "b", "c"]), seed: 1 });
    const b = buildBlindPack({ items: items(["a", "b", "c"]), seed: 2 });

    expect(a.entries.map((e) => e.provider)).not.toEqual(b.entries.map((e) => e.provider));
  });

  it("writes a key that maps every filename back to its vendor", () => {
    const pack = buildBlindPack({ items: items(), seed: 5 });

    for (const entry of pack.entries) {
      expect(pack.answerKey[entry.filename]).toBe(entry.provider);
    }
    expect(Object.keys(pack.answerKey).length).toBe(pack.entries.length);
  });

  it("names files in playback order so sorting them cannot reorder the test", () => {
    const pack = buildBlindPack({ items: items(["a", "b"]), seed: 9 });
    const names = pack.entries.map((e) => e.filename);

    expect([...names].sort()).toEqual(names);
  });

  it("builds a scorecard with a row per sample and no vendor names on it", () => {
    const pack = buildBlindPack({ items: items(), seed: 5 });

    for (const provider of PROVIDERS) {
      expect(pack.scorecard.toLowerCase()).not.toContain(provider);
    }
    for (const entry of pack.entries) {
      expect(pack.scorecard).toContain(entry.filename);
    }
  });

  it("returns an empty pack for no items rather than throwing", () => {
    const pack = buildBlindPack({ items: [], seed: 1 });
    expect(pack.entries).toEqual([]);
  });
});
