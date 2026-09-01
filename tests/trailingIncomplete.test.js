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
  // Was "is inert by default, so merging this changes nothing". It shipped
  // inert in round 2 so the branch could land without behaviour risk, and then
  // stayed inert in production for the whole of the round-3 turn-taking work —
  // the cheap half of semantic end-of-turn detection, written, tested, and
  // switched off. The default moved to 800 on 2026-08-31 once
  // sim/cutoffSim.sim.js produced the matched pair (50.0% -> 12.5% cutoffs
  // with the fluent control's reply latency unmoved).
  it("is ON by default, and holds the fragment smart_format punctuated mid-thought", async () => {
    // Punctuated, exactly as smart_format delivers it mid-thought. Reaching
    // terminal_punctuation here would mean a zero hold and the assistant
    // answering "I'd like to book" as though it were a finished sentence.
    expect(await classify("I'd like to book", "I'd like to book.")).toEqual({
      holdMs: 800,
      rule: "trailing_incomplete",
    });
  });

  it("can still be switched off entirely without a deploy", async () => {
    expect(
      await classify("I'd like to book", "I'd like to book.", { VOICE_HOLD_TRAILING_MS: "0" }),
    ).toEqual({ holdMs: 0, rule: "terminal_punctuation" });
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

  // Found in review, and the reason the single word list had to be split.
  // Every one of these ends on a word that WAS in it, and every one is a
  // complete caller turn — several are how a call ends, so at 800ms they put
  // dead air in front of the goodbye. They were invisible while the default
  // was 0.
  it("does NOT hold a complete turn that happens to end on one of the verbs", async () => {
    for (const [clean, raw] of [
      ["Yes cancel", "Yes cancel."],
      ["Just a booking", "Just a booking."],
      ["Yes go ahead and book", "Yes go ahead and book."],
    ]) {
      expect((await classify(clean, raw, ON)).rule, `should NOT hold: "${raw}"`).toBe(
        "terminal_punctuation",
      );
    }
  });

  // NOT A PASS. Documenting a PRE-EXISTING defect found while fixing the one
  // above, in an older and stronger rule.
  //
  // "No, that's all I need." is one of the most common ways a caller signals
  // the call is over, and TRAILING_LEAD_IN matches its trailing "i need" — so
  // it takes a 2000ms hold, more than twice what the verb list would have
  // charged, and it lands immediately before the goodbye. The lead-in list was
  // built for "my name is…" / "I need…" as OPENINGS, where the caller really
  // is about to say more; it cannot tell that from the same words closing a
  // sentence.
  //
  // Left alone deliberately: it predates this branch, it is not what the round
  // was asked to fix, and changing a 2000ms rule deserves its own matched pair
  // in the simulator rather than being folded into someone else's change. This
  // assertion exists so the behaviour is recorded rather than assumed, and so
  // the day it is fixed this test fails and points at the reason.
  it("PRE-EXISTING: a caller signing off on 'I need' / 'I want' waits 2s on the lead-in rule", async () => {
    for (const [clean, raw] of [
      ["No that's all I need", "No that's all I need."],
      ["That's what I want", "That's what I want."],
      ["That's all I want", "That's all I want."],
    ]) {
      expect(await classify(clean, raw, ON), `pre-existing 2s hold: "${raw}"`).toEqual({
        holdMs: 2_000,
        rule: "trailing_lead_in",
      });
    }
  });

  it("still holds the same verbs when a cue shows they are governing something", async () => {
    // The distinction the split turns on: "to book" is unfinished, "all I
    // need" is not, and the trailing word is identical.
    for (const [clean, raw] of [
      ["I'd like to book", "I'd like to book."],
      ["Can I get", "Can I get."],
      ["I want to cancel", "I want to cancel."],
      ["Could you take", "Could you take."],
    ]) {
      expect((await classify(clean, raw, ON)).rule, `should hold: "${raw}"`).toBe(
        "trailing_incomplete",
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
