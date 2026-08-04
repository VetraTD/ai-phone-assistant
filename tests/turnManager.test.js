import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTurnManager, BACKCHANNELS, INTERRUPT_CUES } from "../lib/voice/turnManager.js";

// voicedRunMs defaults to a value comfortably above BARGE_MIN_VOICED_MS (250),
// i.e. "the caller has genuinely been speaking". Tests that care about the
// cough case override it — a cough is a ~200ms burst, which clears isActive()
// but not this.
function makeDeps({ speaking = true, vadActive = true, voicedRunMs = 800 } = {}) {
  const vad = {
    processFrame: vi.fn(() => ({ voiced: true, voiceActive: vadActive, rms: 1000 })),
    isActive: vi.fn(() => vadActive),
  };
  // Derived from the LIVE isActive mock, not the captured flag, so a test that
  // flips isActive to "no voice" gets a zero run for free — which is what the
  // real VAD does, since a run cannot outlive its activation.
  vad.voicedRunMs = vi.fn(() => (vad.isActive() ? voicedRunMs : 0));
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

    it("while speaking, a final containing a cue amid filler interrupts when the caller really spoke", () => {
      tm.handleFinal("uh wait");
      expect(deps.onInterrupt).toHaveBeenCalledWith("uh wait");
      expect(deps.onTurnEnd).toHaveBeenCalledWith("uh wait");
    });

    // CONTRACT CHANGE. A cue used to bypass every remaining gate, on the theory
    // that "stop"/"wait" is urgent enough to act on unverified. That is also
    // exactly how a mis-transcribed noise burst cut a caller off: a cough
    // rendered as "no" or "sorry" went straight through to an interrupt.
    //
    // A cue still exempts a final from the WORD-COUNT rule — an urgent "stop"
    // is one word and must work — but no longer from the evidence that the
    // caller actually made a sound.
    it("while speaking, a cue with NO mic energy at all is treated as a phantom", () => {
      deps.vad.isActive.mockReturnValue(false);
      deps.vad.voicedRunMs.mockReturnValue(0);
      const result = tm.handleFinal("uh wait");
      expect(result).toEqual({ action: "ignore", reason: "no_vad" });
      expect(deps.onInterrupt).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// The cutoff path, end to end.
//
// Reported symptom: "the AI receptionist kept randomly cutting me off when it
// should not have". The mechanism has nothing to do with silence windows —
// "no" is an INTERRUPT_CUE, and a one-word cue used to bypass every remaining
// gate on the final path. Meanwhile echoGuard.classify() refuses transcripts
// under 4 tokens, so nothing checked whether that "no" was the AI's own
// "No problem, I can get that booked" coming back off a speakerphone.
// ---------------------------------------------------------------------------
describe("turnManager.js — short-final echo containment (the cutoff bug)", () => {
  const AI_REPLY = "No problem, I can get that booked for you.";

  function makeEchoGuard(spokenByAi) {
    return {
      classify: () => ({ isEcho: false, reason: "too_short", ratio: 0, novel: 0 }),
      isEcho: () => false,
      isShortEcho: (text) =>
        String(text)
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((t) => spokenByAi.includes(t)),
    };
  }

  it("does not cut the caller off when the AI's own word echoes back as a cue", () => {
    const deps = makeDeps({ speaking: true, vadActive: true });
    const echoGuard = makeEchoGuard(["no", "problem", "i", "can", "get", "that", "booked", "for", "you"]);
    const tm = createTurnManager({ ...deps, echoGuard, now: () => 1000 });

    const result = tm.handleFinal("no");

    expect(result).toEqual({ action: "ignore", reason: "echo_short" });
    expect(deps.onInterrupt).not.toHaveBeenCalled();
    expect(deps.onTurnEnd).not.toHaveBeenCalled();
  });

  it("STILL interrupts on a genuine one-word cue the AI never said", () => {
    const deps = makeDeps({ speaking: true, vadActive: true });
    const echoGuard = makeEchoGuard(["no", "problem", "i", "can", "get", "that", "booked"]);
    const tm = createTurnManager({ ...deps, echoGuard, now: () => 1000 });

    const result = tm.handleFinal("stop");

    expect(result.action).toBe("interrupt");
    expect(deps.onInterrupt).toHaveBeenCalled();
  });

  it("STILL interrupts when the caller adds a word the AI did not say", () => {
    const deps = makeDeps({ speaking: true, vadActive: true });
    const echoGuard = makeEchoGuard(["no", "problem", "i", "can", "get", "that", "booked"]);
    const tm = createTurnManager({ ...deps, echoGuard, now: () => 1000 });

    expect(tm.handleFinal("no wait").action).toBe("interrupt");
  });

  it("leaves longer finals to the main echo classifier", () => {
    const deps = makeDeps({ speaking: true, vadActive: true });
    const echoGuard = makeEchoGuard(["no", "problem", "i", "can", "get", "that", "booked"]);
    const tm = createTurnManager({ ...deps, echoGuard, now: () => 1000 });

    // 4 words: isShortEcho declines by length, classify() is the right gate.
    expect(tm.handleFinal("no problem i can").action).toBe("interrupt");
  });

  it("is inert when no echoGuard is wired at all", () => {
    const deps = makeDeps({ speaking: true, vadActive: true });
    const tm = createTurnManager({ ...deps, now: () => 1000 });
    expect(tm.handleFinal("no").action).toBe("interrupt");
  });
});

// ---------------------------------------------------------------------------
// The reported bug: "we accidentally slip a word or rarely a cough and it cuts".
//
// A cough is a ~200ms burst of high energy. The VAD latches voiceActive after
// activeMs (200) and holds it for hangoverMs (300), and turnManager then
// vouched for any transcript arriving within FINAL_VOICE_WINDOW_MS (1500). So
// every cheap noise arrived pre-corroborated: whatever Deepgram forced it into
// — "huh", "no", "sorry" — was treated as a caller interrupting.
//
// Nothing measured HOW LONG the caller had been speaking, and that is the one
// thing that actually separates a cough from a sentence.
// ---------------------------------------------------------------------------
describe("turnManager.js — cough and noise rejection", () => {
  /** VAD state for a single short burst: energy present, but no real speech. */
  const coughDeps = () => makeDeps({ speaking: true, vadActive: true, voicedRunMs: 180 });

  it("does not let a cough transcribed as a cue interrupt", () => {
    const deps = coughDeps();
    const tm = createTurnManager({ ...deps, now: () => 1000 });

    const result = tm.handleFinal("sorry");

    expect(result).toEqual({ action: "ignore", reason: "no_vad" });
    expect(deps.onInterrupt).not.toHaveBeenCalled();
  });

  it("does not let a cough transcribed as two words interrupt", () => {
    // The old rule doubted only ONE-word finals (SHORT_FINAL_MIN_WORDS = 2), so
    // any two-word scrap went straight through with no VAD check whatsoever.
    const deps = coughDeps();
    const tm = createTurnManager({ ...deps, now: () => 1000 });

    const result = tm.handleFinal("uh huh what");

    expect(deps.onInterrupt).not.toHaveBeenCalled();
    expect(result.action).toBe("ignore");
  });

  it("does not let a low-confidence scrap interrupt, even with sustained energy", () => {
    // Deepgram reports how sure it is; the pipeline threw that away entirely.
    // Noise forced into the nearest vocabulary item is exactly what a speech
    // model is uncertain about.
    const deps = makeDeps({ speaking: true, vadActive: true, voicedRunMs: 900 });
    const tm = createTurnManager({ ...deps, now: () => 1000 });

    const result = tm.handleFinal("stop", { confidence: 0.21 });

    expect(result).toEqual({ action: "ignore", reason: "low_confidence" });
    expect(deps.onInterrupt).not.toHaveBeenCalled();
  });

  // The other half of the bug report: "whenever we intend to cut it off, it
  // cuts off". That must not regress — a guard that stops real interruptions
  // is worse than the noise it filters.
  it("STILL interrupts on a deliberate one-word interruption", () => {
    const deps = makeDeps({ speaking: true, vadActive: true, voicedRunMs: 400 });
    const tm = createTurnManager({ ...deps, now: () => 1000 });

    const result = tm.handleFinal("stop", { confidence: 0.95 });

    expect(result.action).toBe("interrupt");
    expect(deps.onInterrupt).toHaveBeenCalledWith("stop");
  });

  it("STILL interrupts on a full sentence, without needing to clear the short-final bars", () => {
    // A caller who says a whole sentence over the assistant is unambiguously
    // interrupting, so the sustained-voice and confidence gates never apply.
    const deps = makeDeps({ speaking: true, vadActive: true, voicedRunMs: 50 });
    const tm = createTurnManager({ ...deps, now: () => 1000 });

    const result = tm.handleFinal("actually can we make it Wednesday instead", { confidence: 0.4 });

    expect(result.action).toBe("interrupt");
  });

  it("treats an unreported confidence as acceptable rather than as noise", () => {
    // Deepgram omits confidence on some events. Reading "not reported" as "not
    // confident" would suppress real interruptions on a whole class of message.
    const deps = makeDeps({ speaking: true, vadActive: true, voicedRunMs: 400 });
    const tm = createTurnManager({ ...deps, now: () => 1000 });

    expect(tm.handleFinal("stop", {}).action).toBe("interrupt");
  });

  it("falls back to isActive when the VAD has no voicedRunMs (injected stub)", () => {
    // turnManager accepts an injected vad; a stub without the method must not
    // silently suppress every barge-in.
    const deps = makeDeps({ speaking: true, vadActive: true });
    delete deps.vad.voicedRunMs;
    const tm = createTurnManager({ ...deps, now: () => 1000 });

    expect(tm.handleFinal("stop").action).toBe("interrupt");
  });
});
