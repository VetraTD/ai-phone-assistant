import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTurnManager, BACKCHANNELS, INTERRUPT_CUES } from "../lib/voice/turnManager.js";

function makeDeps({ speaking = true, vadActive = true } = {}) {
  const vad = {
    processFrame: vi.fn(() => ({ voiced: true, voiceActive: vadActive, rms: 1000 })),
    isActive: vi.fn(() => vadActive),
  };
  const audioOut = {
    isPlaying: vi.fn(() => speaking),
  };
  const onInterrupt = vi.fn();
  const onTurnEnd = vi.fn();
  return { vad, audioOut, onInterrupt, onTurnEnd };
}

describe("turnManager.js — constants", () => {
  it("exports the exact BACKCHANNELS list", () => {
    expect(BACKCHANNELS).toEqual([
      "yeah", "yes", "yep", "yup", "uh-huh", "uh huh", "mm-hmm", "mm hmm", "mhm",
      "mm", "mmm", "hmm", "hm", "mhmm",
      "ok", "okay", "right", "sure", "got it", "gotcha", "alright", "all right",
      "i see", "cool",
    ]);
  });

  it("exports the exact INTERRUPT_CUES list", () => {
    expect(INTERRUPT_CUES).toEqual([
      "stop", "wait", "hold on", "hang on", "no", "actually", "excuse me",
      "one second", "one sec", "question", "sorry", "pause", "shut up", "listen",
    ]);
  });
});

describe("turnManager.js — createTurnManager", () => {
  let deps;
  let tm;

  beforeEach(() => {
    deps = makeDeps({ speaking: true, vadActive: true });
    tm = createTurnManager({ ...deps, now: () => 1000 });
  });

  describe("handleInterim() while AI is speaking", () => {
    it("ignores a pure backchannel", () => {
      const result = tm.handleInterim("yeah");
      expect(result).toEqual({ action: "ignore", reason: "backchannel" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("ignores a multi-word pure-backchannel phrase", () => {
      const result = tm.handleInterim("yeah uh-huh");
      expect(result).toEqual({ action: "ignore", reason: "backchannel" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("treats punctuation-variant backchannels as pure backchannel", () => {
      const result = tm.handleInterim("Okay, got it!");
      expect(result).toEqual({ action: "ignore", reason: "backchannel" });
    });

    it("interrupts on an interrupt cue when VAD confirms voice", () => {
      const result = tm.handleInterim("wait");
      expect(result).toEqual({ action: "interrupt" });
      expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
      expect(deps.onInterrupt).toHaveBeenCalledWith("wait");
    });

    it("does not interrupt on a cue when VAD does not confirm voice (likely echo)", () => {
      deps.vad.isActive.mockReturnValue(false);
      const result = tm.handleInterim("wait");
      expect(result).toEqual({ action: "ignore", reason: "no_vad" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("interrupts on >=4 words even without a cue, when VAD confirms voice", () => {
      const result = tm.handleInterim("can you help me");
      expect(result).toEqual({ action: "interrupt" });
      expect(deps.onInterrupt).toHaveBeenCalledWith("can you help me");
    });

    it("does not interrupt on >=4 words when VAD does not confirm voice", () => {
      deps.vad.isActive.mockReturnValue(false);
      const result = tm.handleInterim("can you help me");
      expect(result).toEqual({ action: "ignore", reason: "no_vad" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("defers a 3-word cue-less interim (likely echo or a thinking mutter)", () => {
      const result = tm.handleInterim("can you help");
      expect(result).toEqual({ action: "defer" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("does not treat a substring match as a cue: 'I know' does not match the 'no' cue", () => {
      // "know" contains "no" as a substring but must not whole-word match
      // the "no" cue. 2 words, so also below the >=3-word auto-interrupt
      // rule — isolates cue-matching correctness from the word-count rule.
      const result = tm.handleInterim("I know");
      expect(result).toEqual({ action: "defer" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("does not treat a substring match as a cue: 'you know' does not match the 'no' cue", () => {
      const result = tm.handleInterim("you know");
      expect(result).toEqual({ action: "defer" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("does match standalone 'no' as the interrupt cue it is", () => {
      const result = tm.handleInterim("no");
      expect(result).toEqual({ action: "interrupt" });
      expect(deps.onInterrupt).toHaveBeenCalledWith("no");
    });

    it("defers a short (1-2 word) non-backchannel, non-cue phrase like a name", () => {
      const result = tm.handleInterim("John Smith");
      expect(result).toEqual({ action: "defer" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("defers a single non-backchannel, non-cue word", () => {
      const result = tm.handleInterim("Bob");
      expect(result).toEqual({ action: "defer" });
    });

    it("dedupes onInterrupt across repeated interim triggers in the same speaking turn", () => {
      tm.handleInterim("wait");
      tm.handleInterim("wait");
      tm.handleInterim("hold on");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
    });

    it("resumes calling onInterrupt after reset()", () => {
      tm.handleInterim("wait");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
      tm.reset();
      tm.handleInterim("wait");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleInterim() while AI is NOT speaking", () => {
    it("ignores everything with reason not_speaking, regardless of content", () => {
      const quiet = createTurnManager({ ...makeDeps({ speaking: false }), now: () => 1000 });
      expect(quiet.handleInterim("wait")).toEqual({ action: "ignore", reason: "not_speaking" });
      expect(quiet.handleInterim("can you help me today")).toEqual({
        action: "ignore",
        reason: "not_speaking",
      });
    });
  });

  describe("handleInterim() with empty/null text", () => {
    it("ignores null/empty text with reason empty, without touching callbacks, even while speaking", () => {
      expect(tm.handleInterim(null)).toEqual({ action: "ignore", reason: "empty" });
      expect(tm.handleInterim("")).toEqual({ action: "ignore", reason: "empty" });
      expect(tm.handleInterim("   ")).toEqual({ action: "ignore", reason: "empty" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
      expect(deps.onTurnEnd).not.toHaveBeenCalled();
    });
  });

  describe("handleFinal()", () => {
    it("while speaking, non-backchannel final triggers onInterrupt + onTurnEnd without requiring VAD", () => {
      deps.vad.isActive.mockReturnValue(false); // VAD not confirming — must not matter for finals
      tm.handleFinal("actually never mind about that");
      expect(deps.onInterrupt).toHaveBeenCalledWith("actually never mind about that");
      expect(deps.onTurnEnd).toHaveBeenCalledWith("actually never mind about that");
    });

    it("while speaking, a pure-backchannel final is ignored (no interrupt, no turn end)", () => {
      tm.handleFinal("okay");
      expect(deps.onInterrupt).not.toHaveBeenCalled();
      expect(deps.onTurnEnd).not.toHaveBeenCalled();
    });

    it("while speaking, Deepgram mm-hmm variants are ignored as backchannels", () => {
      for (const t of ["mm", "mmm", "hmm", "hm.", "Mm-mm", "mhmm"]) {
        expect(tm.handleFinal(t).action).toBe("ignore");
      }
      expect(deps.onInterrupt).not.toHaveBeenCalled();
      expect(deps.onTurnEnd).not.toHaveBeenCalled();
    });

    it("while speaking, a filler-only final ('er', 'uh uh') is ignored even with VAD active", () => {
      const result = tm.handleFinal("er, uh");
      expect(result).toEqual({ action: "ignore", reason: "filler_only" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
    });

    it("while speaking, a one-word cue-less final without VAD is ignored as an STT phantom", () => {
      deps.vad.isActive.mockReturnValue(false);
      const result = tm.handleFinal("Bob");
      expect(result).toEqual({ action: "ignore", reason: "no_vad" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
      expect(deps.onTurnEnd).not.toHaveBeenCalled();
    });

    it("while speaking, a one-word cue-less final WITH VAD still interrupts", () => {
      tm.handleFinal("Bob");
      expect(deps.onInterrupt).toHaveBeenCalledWith("Bob");
      expect(deps.onTurnEnd).toHaveBeenCalledWith("Bob");
    });

    it("while speaking, a final containing a cue amid filler still interrupts", () => {
      deps.vad.isActive.mockReturnValue(false);
      tm.handleFinal("uh wait");
      expect(deps.onInterrupt).toHaveBeenCalledWith("uh wait");
      expect(deps.onTurnEnd).toHaveBeenCalledWith("uh wait");
    });

    it("while speaking, a null final does not trigger a spurious interrupt (STT silence-timeout artifact)", () => {
      const result = tm.handleFinal(null);
      expect(result).toEqual({ action: "ignore", reason: "empty" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
      expect(deps.onTurnEnd).not.toHaveBeenCalled();
    });

    it("while speaking, an empty-string final does not trigger a spurious interrupt", () => {
      const result = tm.handleFinal("");
      expect(result).toEqual({ action: "ignore", reason: "empty" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
      expect(deps.onTurnEnd).not.toHaveBeenCalled();
    });

    it("while speaking, a whitespace/punctuation-only final is treated as empty", () => {
      const result = tm.handleFinal("   ...  ");
      expect(result).toEqual({ action: "ignore", reason: "empty" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
      expect(deps.onTurnEnd).not.toHaveBeenCalled();
    });

    it("while quiet, calls onTurnEnd only (not onInterrupt)", () => {
      const localDeps = makeDeps({ speaking: false });
      const quiet = createTurnManager({ ...localDeps, now: () => 1000 });
      quiet.handleFinal("what time do you close today");
      expect(localDeps.onInterrupt).not.toHaveBeenCalled();
      expect(localDeps.onTurnEnd).toHaveBeenCalledWith("what time do you close today");
    });

    it("dedupes onInterrupt if an interim already triggered it this turn", () => {
      tm.handleInterim("wait");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
      tm.handleFinal("wait actually never mind");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
      expect(deps.onTurnEnd).toHaveBeenCalledTimes(1);
    });

    it("clears the dedupe on turn end so the next speaking turn can interrupt again", () => {
      tm.handleInterim("wait");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(1);
      tm.handleFinal("wait actually never mind");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(1);

      // New turn: AI starts speaking again, same manager instance.
      tm.handleInterim("wait");
      expect(deps.onInterrupt).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleAudioFrame()", () => {
    it("forwards the frame and current time to vad.processFrame", () => {
      const buf = Buffer.from([1, 2, 3]);
      tm.handleAudioFrame(buf);
      expect(deps.vad.processFrame).toHaveBeenCalledWith(buf, 1000);
    });
  });

  describe("reset()", () => {
    it("does not throw and clears dedupe state", () => {
      expect(() => tm.reset()).not.toThrow();
    });
  });

  describe("never throws", () => {
    it("handleInterim/handleFinal survive garbage input", () => {
      expect(() => tm.handleInterim(null)).not.toThrow();
      expect(() => tm.handleInterim(undefined)).not.toThrow();
      expect(() => tm.handleInterim(123)).not.toThrow();
      expect(() => tm.handleFinal(null)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Self-echo suppression (lib/voice/echoGuard.js)
  //
  // On a speakerphone the AI's own voice comes back through the caller's mic
  // with real energy behind it, so neither the VAD nor the playback window can
  // tell it from caller speech. Only content can.
  // ---------------------------------------------------------------------------
  describe("echo suppression", () => {
    /** A guard that calls exactly the listed texts echo, and nothing else. */
    function echoGuardFor(...echoTexts) {
      return {
        classify: vi.fn((text) =>
          echoTexts.includes(text)
            ? { isEcho: true, reason: "echo", ratio: 1, novel: 0 }
            : { isEcho: false, reason: "low_overlap", ratio: 0, novel: 9 }
        ),
      };
    }

    it("an echo interim does NOT interrupt, even with VAD confirming voice", () => {
      // The speakerphone reproduction condition: echo is loud, so the VAD
      // says yes. Before the guard existed, this is the call cutting itself
      // off mid-sentence.
      const d = makeDeps({ speaking: true, vadActive: true });
      const t = createTurnManager({
        ...d,
        echoGuard: echoGuardFor("We're open Monday through Friday"),
        now: () => 1000,
      });

      const r = t.handleInterim("We're open Monday through Friday");
      expect(r).toEqual({ action: "ignore", reason: "echo" });
      expect(d.onInterrupt).not.toHaveBeenCalled();
    });

    it("an echo final while the AI is still audible neither interrupts NOR ends the turn", () => {
      const d = makeDeps({ speaking: true, vadActive: true });
      const t = createTurnManager({
        ...d,
        echoGuard: echoGuardFor("We're open Monday through Friday"),
        now: () => 1000,
      });

      const r = t.handleFinal("We're open Monday through Friday");
      expect(r).toEqual({ action: "ignore", reason: "echo" });
      expect(d.onInterrupt).not.toHaveBeenCalled();
      expect(d.onTurnEnd).not.toHaveBeenCalled();
    });

    it("an echo final arriving after the AI went quiet also does not end the turn", () => {
      // This is the one that fed the AI its own sentence as caller input. The
      // quiet branch reaches endTurn directly, so a check placed only in the
      // speaking branch would miss it.
      const d = makeDeps({ speaking: false, vadActive: false });
      const t = createTurnManager({
        ...d,
        echoGuard: echoGuardFor("We're open Monday through Friday"),
        now: () => 1000,
      });

      const r = t.handleFinal("We're open Monday through Friday");
      expect(r).toEqual({ action: "ignore", reason: "echo" });
      expect(d.onTurnEnd).not.toHaveBeenCalled();
    });

    it("a non-echo final still ends the turn normally while the guard is installed", () => {
      const d = makeDeps({ speaking: false, vadActive: false });
      const t = createTurnManager({
        ...d,
        echoGuard: echoGuardFor("We're open Monday through Friday"),
        now: () => 1000,
      });

      const r = t.handleFinal("I need to cancel my appointment");
      expect(r).toEqual({ action: "turn_end" });
      expect(d.onTurnEnd).toHaveBeenCalledWith("I need to cancel my appointment");
    });

    it("a real interruption still interrupts while the guard is installed", () => {
      const d = makeDeps({ speaking: true, vadActive: true });
      const t = createTurnManager({
        ...d,
        echoGuard: echoGuardFor("something else entirely"),
        now: () => 1000,
      });

      const r = t.handleInterim("wait");
      expect(r).toEqual({ action: "interrupt" });
      expect(d.onInterrupt).toHaveBeenCalled();
    });

    it("a guard that throws is treated as 'not echo', never as a reason to drop caller speech", () => {
      const d = makeDeps({ speaking: false, vadActive: false });
      const t = createTurnManager({
        ...d,
        echoGuard: { classify: () => { throw new Error("boom"); } },
        now: () => 1000,
      });

      expect(t.handleFinal("I need to cancel my appointment")).toEqual({ action: "turn_end" });
      expect(d.onTurnEnd).toHaveBeenCalled();
    });

    it("with NO guard injected, behavior is exactly as before", () => {
      const d = makeDeps({ speaking: true, vadActive: true });
      const t = createTurnManager({ ...d, now: () => 1000 });
      expect(t.handleInterim("we are open monday through friday")).toEqual({ action: "interrupt" });
    });
  });
});
