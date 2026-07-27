import { describe, it, expect } from "vitest";
import { createEchoGuard } from "../lib/voice/echoGuard.js";

// ---------------------------------------------------------------------------
// echoGuard.test.js
//
// The failure this module exists to prevent, observed live on speakerphone:
// with no acoustic echo cancellation anywhere in the pipeline, the AI's own
// voice re-enters the caller's mic, Deepgram transcribes it, and turnManager
// sees >=4 words of "caller speech" arriving with real mic energy behind it.
// The AI interrupts itself, then answers its own sentence as if the caller had
// said it, which produces more audio, which echoes again. The loop only ends
// when the caller stops talking long enough for it to die out.
//
// Time is always caller-supplied so these tests never touch the system clock
// (same pattern as inboundVad.test.js / metrics.test.js).
// ---------------------------------------------------------------------------

/**
 * Build a guard whose "AI is audible" window the test controls directly.
 * Defaults to a window far in the future so arrival timing is not the thing
 * under test unless a case says so.
 */
function makeGuard(overrides = {}) {
  let audibleUntil = 1_000_000;
  const guard = createEchoGuard({
    aiAudibleUntil: () => audibleUntil,
    ...overrides,
  });
  return {
    guard,
    setAudibleUntil(v) { audibleUntil = v; },
  };
}

const AI_LINE =
  "We're open Monday through Friday from nine in the morning until five in the afternoon.";

describe("echoGuard.js — createEchoGuard", () => {
  describe("the core case: the AI's own sentence coming back", () => {
    it("classifies a verbatim echo of what the AI just said as echo", () => {
      const { guard } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      expect(guard.isEcho(AI_LINE, 1_200)).toBe(true);
    });

    it("classifies a partial echo (STT only caught the middle) as echo", () => {
      const { guard } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      expect(guard.isEcho("Monday through Friday from nine in the morning", 1_200)).toBe(true);
    });

    it("tolerates a couple of STT word errors inside an otherwise verbatim echo", () => {
      const { guard } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      // "until" -> "til", "afternoon" -> "afternoons": the kind of damage a
      // phone-bandwidth echo path does. Still unmistakably the AI's sentence.
      expect(
        guard.isEcho("open Monday through Friday from nine in the morning til five", 1_200)
      ).toBe(true);
    });

    it("matches an echo that spans two separately-spoken chunks", () => {
      // The turn loop writes sentence by sentence, so the AI's speech arrives
      // here in pieces; an echo does not respect those boundaries.
      const { guard } = makeGuard();
      guard.noteSpoken("I can book you in for Thursday.", 1_000);
      guard.noteSpoken("Does two thirty work for you?", 1_100);
      expect(guard.isEcho("for Thursday does two thirty work", 1_300)).toBe(true);
    });
  });

  describe("what must NOT be suppressed", () => {
    it("does not classify unrelated caller speech as echo", () => {
      const { guard } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      expect(guard.isEcho("I need to cancel my appointment tomorrow", 1_200)).toBe(false);
    });

    it("does not classify a SHORT caller confirmation as echo, even when the AI just said those words", () => {
      // The load-bearing false-positive guard: the caller repeating a slot
      // back ("Thursday at three?") is the single most common thing a caller
      // says right after the AI proposes one, and it is real speech.
      const { guard } = makeGuard();
      guard.noteSpoken("I have Thursday at three available.", 1_000);
      expect(guard.isEcho("Thursday at three", 1_200)).toBe(false);
    });

    it("does not classify a partial echo carrying NEW information as echo", () => {
      // "...but can we do four thirty instead" — high overlap on the prefix,
      // yet the caller is plainly saying something the AI never said.
      const { guard } = makeGuard();
      guard.noteSpoken("I have Thursday at three available.", 1_000);
      expect(
        guard.isEcho("Thursday at three but can we do four thirty instead please", 1_200)
      ).toBe(false);
    });

    it("does not classify a paraphrase that reuses the same words in a different order as echo", () => {
      // Word ORDER is the discriminator — this is why matching is on bigrams
      // rather than on a bag of words.
      const { guard } = makeGuard();
      guard.noteSpoken("We're open from nine until five on Friday.", 1_000);
      expect(guard.isEcho("Friday until five open from nine we're", 1_200)).toBe(false);
    });

    it("does not classify anything as echo before the AI has said a word", () => {
      const { guard } = makeGuard();
      expect(guard.isEcho("We're open Monday through Friday", 1_200)).toBe(false);
    });
  });

  describe("the arrival window", () => {
    it("does not classify identical content arriving long after playback ended as echo", () => {
      // The caller quoting the AI back a few seconds later is real speech.
      const { guard, setAudibleUntil } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      setAudibleUntil(2_000);
      expect(guard.isEcho(AI_LINE, 9_000)).toBe(false);
    });

    it("still classifies an echo arriving in the tail just after a barge-in cut the audio", () => {
      // The single worst case in the live bug. audioOut.clear() collapses the
      // playback estimate to roughly now+140ms, but the echo that CAUSED the
      // barge is still inside Deepgram's buffer and its final will not arrive
      // for another 300ms (endpointing) to 1000ms (utterance_end_ms). Without
      // the stop-stamp that final lands outside the window and gets answered.
      const { guard, setAudibleUntil } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      setAudibleUntil(2_000);
      guard.noteAudioStopped(2_000);
      expect(guard.isEcho(AI_LINE, 2_900)).toBe(true);
    });

    it("stops trusting the stop-stamp once the tail has elapsed", () => {
      const { guard, setAudibleUntil } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      setAudibleUntil(2_000);
      guard.noteAudioStopped(2_000);
      expect(guard.isEcho(AI_LINE, 4_000)).toBe(false);
    });
  });

  describe("normalization", () => {
    it("matches across the digit-grouping mismatch between TTS text and STT output", () => {
      // toSpeakable hands ElevenLabs "817 580 3291" so it is read as digits;
      // Deepgram with numerals:true returns "8175803291". Without merging
      // consecutive digit tokens, every phone-number readback echo is missed.
      const { guard } = makeGuard();
      guard.noteSpoken("Let me read that back: 817 580 3291, is that right?", 1_000);
      expect(guard.isEcho("let me read that back 8175803291 is that right", 1_200)).toBe(true);
    });

    it("ignores punctuation and casing differences", () => {
      const { guard } = makeGuard();
      guard.noteSpoken("Sure — I can help with that, absolutely!", 1_000);
      expect(guard.isEcho("sure i can help with that absolutely", 1_200)).toBe(true);
    });
  });

  describe("retention", () => {
    it("forgets AI speech older than the retention window", () => {
      const { guard } = makeGuard({ retainMs: 5_000 });
      guard.noteSpoken(AI_LINE, 1_000);
      expect(guard.isEcho(AI_LINE, 20_000)).toBe(false);
    });

    it("reset() clears everything it remembers", () => {
      const { guard } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      guard.reset();
      expect(guard.isEcho(AI_LINE, 1_200)).toBe(false);
    });
  });

  describe("the kill switch", () => {
    it("never reports echo when disabled", () => {
      const { guard } = makeGuard({ enabled: false });
      guard.noteSpoken(AI_LINE, 1_000);
      expect(guard.isEcho(AI_LINE, 1_200)).toBe(false);
      expect(guard.classify(AI_LINE, 1_200).reason).toBe("disabled");
    });
  });

  describe("classify() reports why", () => {
    it("returns the matched-bigram ratio and novel-token count for logging", () => {
      const { guard } = makeGuard();
      guard.noteSpoken(AI_LINE, 1_000);
      const d = guard.classify(AI_LINE, 1_200);
      expect(d.isEcho).toBe(true);
      expect(d.ratio).toBeGreaterThan(0.6);
      expect(d.novel).toBe(0);
    });

    it("names the reason a candidate was let through", () => {
      const { guard } = makeGuard();
      guard.noteSpoken("I have Thursday at three available.", 1_000);
      expect(guard.classify("Thursday at three", 1_200).reason).toBe("too_short");
    });
  });

  describe("never throws", () => {
    it("survives garbage input", () => {
      const { guard } = makeGuard();
      expect(() => guard.noteSpoken(null, 1_000)).not.toThrow();
      expect(() => guard.noteSpoken(42, 1_000)).not.toThrow();
      expect(guard.isEcho(null, 1_000)).toBe(false);
      expect(guard.isEcho(undefined, 1_000)).toBe(false);
      expect(guard.isEcho({}, 1_000)).toBe(false);
      expect(guard.isEcho("   ", 1_000)).toBe(false);
    });

    it("survives an aiAudibleUntil that throws", () => {
      const guard = createEchoGuard({
        aiAudibleUntil: () => { throw new Error("boom"); },
      });
      guard.noteSpoken(AI_LINE, 1_000);
      expect(guard.isEcho(AI_LINE, 1_200)).toBe(false);
    });
  });
});
