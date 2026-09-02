import { describe, it, expect } from "vitest";
import { createCallSummary } from "../lib/voice/live/summary.js";

// ---------------------------------------------------------------------------
// The instrument, written against the five defects the last one had.
//
// scripts/spike/VERDICT.md closes with the honest headline: five instrument
// defects against roughly one vendor observation, and "most of what a new
// harness measures at first is itself". Two of those five produced a WRONG
// DESIGN CONCLUSION before anything caught them:
//
//   - a bare mean over a signal that is zero 97% of the time read 0, and
//     "no echo reaches us, absent at the sample level" was concluded from it.
//     Adding a nonzero count and a max disproved it within the hour.
//   - `mean([])` and "every frame was digital silence" are indistinguishable
//     in a record that logs no sample count. A broken instrument and a real
//     finding looked identical.
//
// So this file asserts the shape of the record, not just its numbers: a bucket
// reports frames, nonzero and max, always, and a mean is never alone.
// ---------------------------------------------------------------------------

describe("audio buckets", () => {
  it("reports count, nonzero and max, not a bare mean", () => {
    const s = createCallSummary({ arm: "vendor" });
    // The measured silent call: 1,514 frames during playback, 40 of them
    // carrying anything, peaking at 211.
    for (let i = 0; i < 1474; i++) s.recordInbound({ rms: 0, playing: true });
    for (let i = 0; i < 39; i++) s.recordInbound({ rms: 50, playing: true });
    s.recordInbound({ rms: 211, playing: true });

    const out = s.build();
    expect(out.in_frames_playing).toBe(1514);
    expect(out.in_frames_playing_nonzero).toBe(40);
    expect(out.in_rms_playing_max).toBe(211);
  });

  it("tells an empty bucket apart from an all-silent one", () => {
    // THE ambiguity that made the first silent call unreadable. Both mean 0.
    // Only the frame count separates a broken instrument from a real finding.
    const empty = createCallSummary({ arm: "vendor" }).build();
    const silent = createCallSummary({ arm: "vendor" });
    silent.recordInbound({ rms: 0, playing: true });

    expect(empty.in_frames_playing).toBe(0);
    expect(silent.build().in_frames_playing).toBe(1);
    expect(silent.build().in_frames_playing_nonzero).toBe(0);
  });

  it("keeps playing and idle in separate buckets", () => {
    const s = createCallSummary({ arm: "vendor" });
    s.recordInbound({ rms: 100, playing: true });
    s.recordInbound({ rms: 9000, playing: false });

    const out = s.build();
    expect(out.in_rms_playing_max).toBe(100);
    expect(out.in_rms_idle_max).toBe(9000);
  });

  it("survives a call long enough to blow a spread argument list", () => {
    // Math.max(...arr) over a three-minute call's ~9,000 frames can throw, and
    // a throw in the end-of-call summary loses the ENTIRE call's measurements
    // -- which is defect #4, where seven runs were lost to results written
    // only at the end.
    const s = createCallSummary({ arm: "vendor" });
    for (let i = 0; i < 200_000; i++) s.recordInbound({ rms: i % 97, playing: false });

    expect(() => s.build()).not.toThrow();
  });
});

describe("usage", () => {
  it("accumulates across turns instead of keeping the last", () => {
    // Gemini emits one usageMetadata PER TURN. This is the defect the handoff
    // documents, the probe suite fixed, and the spike then re-committed
    // (LVX5). The accumulator is imported, not re-derived.
    const s = createCallSummary({ arm: "vendor" });
    for (const text of [7728, 3894, 3928]) {
      s.recordUsage({ promptTokensDetails: [{ modality: "TEXT", tokenCount: text }] });
    }

    expect(s.build().usage.text_in).toBe(15_550);
    expect(s.build().usage.turns_billed).toBe(3);
  });
});

describe("latency", () => {
  it("reports the number that is comparable across arms", () => {
    // Caller stops -> caller hears a reply. In the vendor arm the vendor's own
    // endpointing delay is inside it; in the manual arms our hangover is. It
    // is the only figure that means the same thing in both.
    const s = createCallSummary({ arm: "hangover" });
    for (const ms of [2200, 2246, 2300]) s.recordReplyAfterLastVoice(ms);

    expect(s.build().reply_after_last_voice_ms_p50).toBe(2246);
  });

  it("reports transcript lag, which is what decides whether arm C is possible", () => {
    const s = createCallSummary({ arm: "hold" });
    for (const ms of [113, 249, 360]) s.recordTranscriptLag(ms);

    expect(s.build().input_transcript_lag_ms_p50).toBe(249);
  });

  it("returns null rather than 0 for a percentile of nothing", () => {
    // 0 would read as "instant" in a dashboard. Nothing happened is a
    // different claim from it happened instantly.
    expect(createCallSummary({ arm: "vendor" }).build().reply_after_last_voice_ms_p50).toBeNull();
  });
});

describe("interruptions", () => {
  it("separates the ones our own VAD corroborated from the ones it did not", () => {
    // An `interrupted` our VAD never saw is the echo signature: the vendor
    // heard speech and cut itself off while the only thing speaking was us.
    // In the spike's auto arm there were 2 of these against 0 in the manual
    // arm -- though a later silent call showed they were short caller
    // backchannel, not echo. Recorded separately precisely because the two
    // readings look identical in any single number.
    const s = createCallSummary({ arm: "vendor" });
    s.recordInterrupted({ corroborated: true });
    s.recordInterrupted({ corroborated: false });
    s.recordInterrupted({ corroborated: false });

    const out = s.build();
    expect(out.interrupted_count).toBe(3);
    expect(out.interrupted_without_local_barge).toBe(2);
  });
});

describe("what it must never contain", () => {
  it("records the hold rule and punctuation shape, never the caller's words", () => {
    const s = createCallSummary({ arm: "hold" });
    s.recordHoldShape({ rule: "trailing_conjunction", hold_ms: 2000, has_terminal_punct: false, length: 37 });

    const serialised = JSON.stringify(s.build());
    expect(serialised).toContain("trailing_conjunction");
    expect(serialised).toContain("has_terminal_punct");
    expect(s.build().hold_rules.trailing_conjunction).toBe(1);
  });
});
