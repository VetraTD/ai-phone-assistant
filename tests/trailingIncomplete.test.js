/**
 * The caller stopped mid-thought on a word that needs an object.
 *
 * Reported from a live call: "sometimes it still comes in too early, like if
 * the caller is taking a second to think... then there is overlap and the
 * caller gets confused and it becomes messy."
 *
 * `sim/cutoffSim.sim.js` reproduces it and names the culprits precisely. On the
 * hesitant script the four cutoffs are fragments ending on `book`, `get`,
 * `having` and `five` — and `TRAILING_CONJUNCTION` / `TRAILING_LEAD_IN` catch
 * none of them, because those lists match a trailing *function* word, not a
 * transitive verb waiting for its object.
 *
 * Deepgram runs smart_format, so those fragments arrive PUNCTUATED, hit the
 * terminal-punctuation branch, and get a zero hold. Placing this list with the
 * other two — above that branch — is what lets them be caught, and costs
 * nothing on genuinely complete turns because it never runs for them.
 *
 * The exclusions below matter as much as the inclusions. Every word here is one
 * a caller can legitimately end a sentence on, and holding after it would add
 * dead air to a turn that was finished.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

const ENV_KEYS = ["VOICE_HOLD_TRAILING_MS", "VOICE_HOLD_NO_PUNCT_MS"];
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  vi.resetModules();
});

/** classifyHold reads its knobs at call time, so a plain import is enough. */
async function classify(text, rawText, env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const { classifyHold } = await import("../lib/transcriptUtils.js");
  return classifyHold(text, rawText);
}

const ON = { VOICE_HOLD_TRAILING_MS: "800" };

describe("classifyHold — trailing incomplete", () => {
  it("is inert by default, so merging this changes nothing", async () => {
    // Punctuated, exactly as smart_format delivers it mid-thought.
    expect(await classify("I'd like to book", "I'd like to book.")).toEqual({
      holdMs: 0,
      rule: "terminal_punctuation",
    });
  });

  it("holds the four fragments the simulator actually cuts off", async () => {
    for (const [clean, raw] of [
      ["I'd like to book", "I'd like to book."],
      ["Can I get", "Can I get."],
      ["I've been having", "I've been having."],
    ]) {
      expect(await classify(clean, raw, ON), `should hold: "${raw}"`).toEqual({
        holdMs: 800,
        rule: "trailing_incomplete",
      });
    }
  });

  it("catches it whether or not smart_format punctuated", async () => {
    // The whole point of sitting ABOVE the punctuation branch: the same
    // fragment is treated the same either way.
    expect((await classify("I'd like to book", "I'd like to book", ON)).rule).toBe("trailing_incomplete");
    expect((await classify("I'd like to book", "I'd like to book.", ON)).rule).toBe("trailing_incomplete");
  });

  it("holds a trailing determiner", async () => {
    expect((await classify("I need to cancel the", "I need to cancel the.", ON)).rule).toBe(
      "trailing_incomplete",
    );
  });

  it("does NOT hold sentences a caller legitimately ends on", async () => {
    // Each of these is a complete caller turn. A hold here is pure dead air,
    // and this is the list that keeps the word set honest.
    for (const [clean, raw] of [
      ["Yes that works", "Yes that works."],
      ["No that's everything thank you", "No that's everything thank you."],
      ["Tuesday morning", "Tuesday morning."],
      ["I don't know", "I don't know."],
      ["Yes I have", "Yes I have."],
      ["Yes it is", "Yes it is."],
      ["I'd like that", "I'd like that."],
      ["That's all I need for now", "That's all I need for now."],
    ]) {
      expect((await classify(clean, raw, ON)).rule, `should NOT hold: "${raw}"`).toBe(
        "terminal_punctuation",
      );
    }
  });

  it("does not fire on a bare -ing word that ends a real answer", async () => {
    // No /\w+ing$/ catch-all: "Tuesday morning." and "just a cleaning." are
    // complete answers.
    expect((await classify("just a cleaning", "just a cleaning.", ON)).rule).toBe("terminal_punctuation");
  });

  it("leaves the stronger rules above it untouched", async () => {
    expect((await classify("book an appointment for", "book an appointment for.", ON)).rule).toBe(
      "trailing_conjunction",
    );
    expect((await classify("my name is", "my name is.", ON)).rule).toBe("trailing_lead_in");
    expect((await classify("my number is 555 12", "my number is 555 12", ON)).rule).toBe(
      "partial_digits",
    );
  });

  it("respects the 3s chain ceiling even if misconfigured", async () => {
    const res = await classify("I'd like to book", "I'd like to book.", {
      VOICE_HOLD_TRAILING_MS: "99000",
    });
    expect(res.holdMs).toBeLessThanOrEqual(3_000);
  });
});
