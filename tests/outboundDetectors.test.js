// tests/outboundDetectors.test.js
import { describe, it, expect } from "vitest";
import {
  detectOptOut,
  detectClaimedHuman,
  isSessionSilent,
  isMachineOrFaxAnswer,
  resolveSilentVerdict,
  sessionEndSilent,
} from "../lib/outbound/detectors.js";

describe("detectOptOut (spec §13.3)", () => {
  it("'stop calling me' on the caller side is a hit", () => {
    expect(detectOptOut({ callerText: "please stop calling me" })).toEqual({ hit: true, side: "caller" });
  });

  it("\"I've made sure we won't call you again\" on the assistant side is a hit", () => {
    expect(detectOptOut({ assistantText: "I've made sure we won't call you again." })).toEqual({ hit: true, side: "assistant" });
  });

  it("no match on either side is not a hit", () => {
    expect(detectOptOut({ assistantText: "Great, I'll book that in.", callerText: "Sounds good, thanks." })).toEqual({
      hit: false,
      side: null,
    });
  });

  it("the caller side takes precedence when both sides match", () => {
    expect(
      detectOptOut({ assistantText: "I've made sure we won't call you again.", callerText: "don't call me" })
    ).toEqual({ hit: true, side: "caller" });
  });

  it.each([
    ["remove you from our list"],
    ["take you off our list"],
  ])("assistant pattern: %s", (phrase) => {
    expect(detectOptOut({ assistantText: `Okay, ${phrase}.` })).toEqual({ hit: true, side: "assistant" });
  });

  it.each([["take me off"], ["remove me"]])("caller pattern: %s", (phrase) => {
    expect(detectOptOut({ callerText: `Please ${phrase} your list.` })).toEqual({ hit: true, side: "caller" });
  });

  // Checkpoint 2b review, b40. `/remove me/` matched "remove medication" as a
  // bare substring ("remove me" is literally the first nine characters of
  // "remove medication"). A word boundary after "me" fixes it without
  // narrowing the real caller phrasing above.
  it("does NOT match 'remove medication' -- a false opt-out would lose a real lead", () => {
    expect(detectOptOut({ callerText: "Can you remove medication from what we're discussing?" })).toEqual({
      hit: false,
      side: null,
    });
  });

  // Fix round 1, item 6: curly apostrophes/quotes (a model or a
  // transcription service routinely uses them) folded before matching.
  it("curly apostrophe: ‘don’t call me’ (caller) is a hit", () => {
    expect(detectOptOut({ callerText: "please don’t call me again" })).toEqual({ hit: true, side: "caller" });
  });

  it("curly apostrophe: “I’ve made sure we won’t call you again” (assistant) is a hit", () => {
    expect(detectOptOut({ assistantText: "I’ve made sure we won’t call you again." })).toEqual({ hit: true, side: "assistant" });
  });
});

describe("detectClaimedHuman (spec §13.2)", () => {
  it("\"I'm not a real person, I'm an AI\" is NOT claimed-human", () => {
    expect(detectClaimedHuman("I'm not a real person, I'm an AI")).toBe(false);
  });

  it("\"Yes, I'm a real person\" is claimed-human", () => {
    expect(detectClaimedHuman("Yes, I'm a real person")).toBe(true);
  });

  it("\"I am a human\" is claimed-human", () => {
    expect(detectClaimedHuman("I am a human, how can I help?")).toBe(true);
  });

  it("no claim in ordinary speech is not claimed-human", () => {
    expect(detectClaimedHuman("I'm calling about your enquiry.")).toBe(false);
  });

  it("a claim immediately retracted ('not really') is not claimed-human", () => {
    expect(detectClaimedHuman("I'm human, not really, I'm an AI assistant.")).toBe(false);
  });

  it("a claim followed by an unrelated negation elsewhere still counts", () => {
    expect(detectClaimedHuman("I'm a real person, not that it should matter.")).toBe(true);
  });

  it("empty/null input is not claimed-human", () => {
    expect(detectClaimedHuman("")).toBe(false);
    expect(detectClaimedHuman(null)).toBe(false);
  });

  // Fix round 1, item 6.
  it("curly apostrophe: “Yes, I’m a real person” is claimed-human", () => {
    expect(detectClaimedHuman("Yes, I’m a real person")).toBe(true);
  });

  it("curly apostrophe negation still retracts: “I’m human, not really” is not claimed-human", () => {
    expect(detectClaimedHuman("I’m human, not really, I’m an AI assistant.")).toBe(false);
  });

  // Checkpoint 2b review, b40. \b treats the hyphen in "human-like" as a word
  // boundary (a hyphen is a non-word character), so the old regex's trailing
  // \b was satisfied by "human" alone and read a compound word as the claim.
  it("'I'm human-like' (compound word via hyphen) is NOT claimed-human", () => {
    expect(detectClaimedHuman("I'm human-like, but actually an AI assistant.")).toBe(false);
  });

  it("a genuine claim still matches right up against a hyphenated word later in the sentence", () => {
    expect(detectClaimedHuman("I'm a real person -- not a bot.")).toBe(true);
  });
});

describe("isSessionSilent (spec §13.4, the two limbs)", () => {
  it("spoke, from_speech_ms 2300 -> silent", () => {
    expect(isSessionSilent({ from_speech_ms: 2300, from_answer_ms: 2500 })).toBe(true);
  });

  it("spoke at 1,870ms, Live replied 1,030ms later: from_speech_ms 1,030 -> NOT silent even though from_answer_ms is 2,900", () => {
    expect(isSessionSilent({ from_speech_ms: 1030, from_answer_ms: 2900 })).toBe(false);
  });

  it("never spoke, from_answer_ms 2300 -> silent", () => {
    expect(isSessionSilent({ from_speech_ms: null, from_answer_ms: 2300 })).toBe(true);
  });

  it("never spoke, from_answer_ms 1500 -> not silent", () => {
    expect(isSessionSilent({ from_speech_ms: null, from_answer_ms: 1500 })).toBe(false);
  });

  it("no measurement at all -> not silent (nothing to judge)", () => {
    expect(isSessionSilent(null)).toBe(false);
    expect(isSessionSilent({})).toBe(false);
  });
});

describe("isMachineOrFaxAnswer / resolveSilentVerdict", () => {
  it("machine_end_beep at any timing is not silent, even if the session flagged it", () => {
    expect(isMachineOrFaxAnswer("machine_end_beep")).toBe(true);
    expect(resolveSilentVerdict({ hasSession: true, sessionSilent: true, answeredBy: "machine_end_beep" })).toBe(false);
  });

  it("fax is excluded the same way", () => {
    expect(resolveSilentVerdict({ hasSession: true, sessionSilent: true, answeredBy: "fax" })).toBe(false);
  });

  it("human, session silent -> silent stands", () => {
    expect(resolveSilentVerdict({ hasSession: true, sessionSilent: true, answeredBy: "human" })).toBe(true);
  });

  it("human, session not silent -> not silent", () => {
    expect(resolveSilentVerdict({ hasSession: true, sessionSilent: false, answeredBy: "human" })).toBe(false);
  });

  it("unknown counts as human (spec §17): silent stands", () => {
    expect(resolveSilentVerdict({ hasSession: true, sessionSilent: true, answeredBy: "unknown" })).toBe(true);
  });

  it("answered with no stream (no session ever finished) is silent", () => {
    expect(resolveSilentVerdict({ hasSession: false, sessionSilent: false, answeredBy: "human" })).toBe(true);
  });

  it("no session, but machine answered by the time AMD landed -> still excluded", () => {
    expect(resolveSilentVerdict({ hasSession: false, sessionSilent: false, answeredBy: "machine_end_silence" })).toBe(false);
  });
});

// Fix round 1, item 3: the session-end-bounded fallback, for when
// firstAudio() could not confirm a real playout (nothing ever queued, or a
// mark that never echoed -- by finish() time a late echo is impossible).
describe("sessionEndSilent (fix round 1, item 3)", () => {
  it("nothing ever queued, never spoke: bounded by (session end - answer)", () => {
    // streamStartAtMs=0, answerToStreamMs=350 -> "answer" was at -350.
    // atMs=2500 -> from_answer_ms = 2500 - 0 + 350 = 2850 > 2000: silent.
    expect(sessionEndSilent({ onsetAt: null, streamStartAtMs: 0, answerToStreamMs: 350, atMs: 2500 })).toBe(true);
  });

  it("nothing ever queued, never spoke, ended quickly: not silent", () => {
    // from_answer_ms = 1000 - 0 + 350 = 1350 <= 2000.
    expect(sessionEndSilent({ onsetAt: null, streamStartAtMs: 0, answerToStreamMs: 350, atMs: 1000 })).toBe(false);
  });

  it("they spoke (onsetAt known): bounded by (session end - onset), NOT by the answer time", () => {
    // onset at 1870ms; session ends at 4200ms -> 4200-1870 = 2330 > 2000: silent,
    // even though from-answer alone (4200-0+350=4550) would also read silent --
    // the point is which clock governs when they DID speak.
    expect(sessionEndSilent({ onsetAt: 1870, streamStartAtMs: 0, answerToStreamMs: 350, atMs: 4200 })).toBe(true);
  });

  it("they spoke, session ended soon after (within 2s of onset): not silent", () => {
    expect(sessionEndSilent({ onsetAt: 1870, streamStartAtMs: 0, answerToStreamMs: 350, atMs: 3500 })).toBe(false);
  });

  it("an enqueue-only measurement (mark never echoed) is superseded: the session-end bound is what runs, not the understated enqueue time", () => {
    // Mirrors the reviewer's concern directly: an enqueue time of, say,
    // 1700ms would read "not silent" on its own, but the session actually
    // ran another 2000ms+ with no confirmed playout.
    expect(sessionEndSilent({ onsetAt: null, streamStartAtMs: 0, answerToStreamMs: 350, atMs: 3800 })).toBe(true);
  });
});
