import { describe, it, expect } from "vitest";
import { emptyUsage, addUsage } from "../lib/voice/geminiUsage.js";

// ---------------------------------------------------------------------------
// This file exists because the defect it guards has now been committed TWICE.
//
// Gemini emits one `usageMetadata` message PER TURN, not a running session
// total. Storing `usage = msg.usageMetadata` keeps only the last turn and
// under-reports a multi-turn call by 3-4x. That is harness defect #1 in
// docs/speech-to-speech-handoff.md section 11, written up with measured
// numbers in this module's own header -- and it was re-committed anyway in
// scripts/spike/s2s-bridge.js by someone who had read both (backlog LVX5).
//
// A written-up post-mortem did not stop the recurrence. An assertion does.
// The module moved to lib/voice/ for the same reason: scripts/probes is not
// in the Dockerfile COPY list, so anything shipping in the image could not
// import it and inlined a copy instead. Reuse has to be POSSIBLE before
// "reuse the instrument, do not re-derive it" is advice rather than a wish.
// ---------------------------------------------------------------------------

/** One turn's worth of the real message shape. */
function turn({ text = 0, audioIn = 0, audioOut = 0, textOut = 0, cached = 0 }) {
  return {
    promptTokensDetails: [
      { modality: "TEXT", tokenCount: text },
      { modality: "AUDIO", tokenCount: audioIn },
    ],
    responseTokensDetails: [
      { modality: "TEXT", tokenCount: textOut },
      { modality: "AUDIO", tokenCount: audioOut },
    ],
    cacheTokensDetails: cached ? [{ modality: "TEXT", tokenCount: cached }] : [],
  };
}

describe("addUsage accumulates across turns rather than overwriting", () => {
  it("sums the three turns from the module header instead of keeping the last", () => {
    // The measured numbers that revealed the defect. Overwriting reports
    // 3,928 text_in; the truth is 15,550, which is 3.96x more.
    const acc = emptyUsage();
    addUsage(acc, turn({ text: 7728, audioIn: 96 }));
    addUsage(acc, turn({ text: 3894, audioIn: 205 }));
    addUsage(acc, turn({ text: 3928, audioIn: 389 }));

    expect(acc.text_in).toBe(15_550);
    expect(acc.audio_in).toBe(690);
    expect(acc.turns_billed).toBe(3);
  });

  it("splits response modalities so audio out is never billed as text", () => {
    const acc = emptyUsage();
    addUsage(acc, turn({ audioOut: 1200, textOut: 40 }));

    expect(acc.audio_out).toBe(1200);
    expect(acc.text_out).toBe(40);
  });

  it("counts cached input on its own axis", () => {
    const acc = emptyUsage();
    addUsage(acc, turn({ text: 100, cached: 4096 }));

    expect(acc.cached_in).toBe(4096);
    expect(acc.text_in).toBe(100);
  });

  it("falls back to the flat counters so a turn is never billed as zero", () => {
    // No detail arrays at all. Without the fallback this turn costs nothing,
    // which is how a spend cap silently stops capping.
    const acc = emptyUsage();
    addUsage(acc, { promptTokenCount: 500, responseTokenCount: 300 });

    expect(acc.text_in).toBe(500);
    expect(acc.audio_out).toBe(300);
    expect(acc.turns_billed).toBe(1);
  });

  it("ignores a missing message without advancing the turn count", () => {
    const acc = emptyUsage();
    addUsage(acc, null);

    expect(acc.turns_billed).toBe(0);
  });
});
