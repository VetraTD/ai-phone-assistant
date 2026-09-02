import { describe, it, expect } from "vitest";
import { createHalfDuplexGate } from "../lib/voice/live/halfDuplex.js";

// ---------------------------------------------------------------------------
// Do not forward inbound audio while we are speaking.
//
// This is the half of "manual activity detection" that is FREE, and separating
// it from the half that is expensive is the main thing the spike taught. They
// were treated as one decision throughout the design and they are two:
//
//   the gate      costs no latency whatsoever. Keep it.
//   the hangover  costs ~900 ms a turn. That is the contested one, and it
//                 lives in turnEnd/, not here.
//
// What the gate guards, measured rather than assumed, and the measurement was
// wrong twice before it was right:
//
//   "echo return loss 23-40 dB"  -> the metric was reading caller speech
//                                   bleeding into the playback window's tail.
//   "no echo at all, absent at   -> a mean over a signal that is zero 97% of
//    the sample level"              the time. Disproved within the hour by
//                                   adding a nonzero count and a max.
//
// The true numbers: 40 of 1,514 frames carried signal while we were speaking,
// peaking at RMS 211, against inboundVad's minRms floor of 700 and a caller
// speech peak of 14,334. So roughly 10 dB of headroom, on ONE handset, in one
// room, through one carrier's echo canceller. Nothing fired because of a
// margin, not an absence -- and a louder speaker or a worse canceller closes
// that gap.
//
// Free insurance on a thin margin. That is the whole argument for this file.
// ---------------------------------------------------------------------------

const frame = (n) => Buffer.from([n]);

/** Silence, from the gate's point of view: no sustained voiced run. */
const QUIET = { isActive: false, voicedRunMs: 0 };
/** A caller genuinely interrupting: past the sustained-speech threshold. */
const TALKING = { isActive: true, voicedRunMs: 400 };
/** A cough: loud, brief, and not an interruption. */
const COUGH = { isActive: true, voicedRunMs: 200 };

describe("the gate itself", () => {
  it("forwards inbound audio when we are not speaking", () => {
    const g = createHalfDuplexGate();
    const out = g.push({ frame: frame(1), playing: false, atMs: 0, ...QUIET });

    expect(out.forward).toEqual([frame(1)]);
  });

  it("forwards nothing at all while we are speaking", () => {
    // The load-bearing assertion. If any frame escapes here, our own output is
    // reaching a detector that sits at the other end of a WebSocket and has
    // never heard our voice, so it cannot tell that voice from the caller's.
    const g = createHalfDuplexGate();
    const forwarded = [];
    for (let i = 0; i < 50; i++) {
      forwarded.push(...g.push({ frame: frame(i), playing: true, atMs: i * 20, ...QUIET }).forward);
    }

    expect(forwarded).toEqual([]);
  });
});

describe("barge-in", () => {
  it("flushes the withheld audio so an interruption keeps its first syllable", () => {
    // Held, not dropped. A caller who cuts in mid-sentence has already spoken
    // the start of their word by the time sustained speech is confirmed, and
    // discarding it makes the model answer half a question.
    const g = createHalfDuplexGate({ lookbackMs: 200, bargeMs: 300 });
    for (let i = 0; i < 10; i++) g.push({ frame: frame(i), playing: true, atMs: i * 20, ...QUIET });

    const out = g.push({ frame: frame(99), playing: true, atMs: 200, ...TALKING });

    expect(out.barge).toBe(true);
    expect(out.forward.length).toBeGreaterThan(1);
    expect(out.forward.at(-1)).toEqual(frame(99));
  });

  it("flushes exactly once, not on every frame of the interrupting sentence", () => {
    // The VAD stays active for the whole interrupting utterance. Without a
    // latch this fires on every frame and re-flushes the same lookback dozens
    // of times into one barge -- which the spike hit and had to fix.
    const g = createHalfDuplexGate({ lookbackMs: 200, bargeMs: 300 });
    for (let i = 0; i < 10; i++) g.push({ frame: frame(i), playing: true, atMs: i * 20, ...QUIET });

    let barges = 0;
    for (let i = 0; i < 20; i++) {
      if (g.push({ frame: frame(100 + i), playing: true, atMs: 200 + i * 20, ...TALKING }).barge) barges++;
    }

    expect(barges).toBe(1);
  });

  it("does not treat a cough as an interruption", () => {
    // isActive alone cannot tell a 200 ms cough from a sentence: activeMs is
    // 200 ms and a cough is a ~200 ms burst. That is why voicedRunMs exists,
    // and it is why a stray transcript once cut the assistant off on a live
    // call.
    const g = createHalfDuplexGate({ lookbackMs: 200, bargeMs: 300 });
    const out = g.push({ frame: frame(1), playing: true, atMs: 0, ...COUGH });

    expect(out.barge).toBe(false);
    expect(out.forward).toEqual([]);
  });

  it("keeps the lookback bounded, so a long reply does not buffer the whole call", () => {
    const g = createHalfDuplexGate({ lookbackMs: 100, bargeMs: 300 }); // 5 frames
    for (let i = 0; i < 500; i++) g.push({ frame: frame(i % 256), playing: true, atMs: i * 20, ...QUIET });

    const out = g.push({ frame: frame(255), playing: true, atMs: 10_000, ...TALKING });

    expect(out.forward.length).toBeLessThanOrEqual(6);
  });

  it("discards the lookback when playback ends without an interruption", () => {
    // Those frames are our own echo and the room. Forwarding them once the
    // gate opens would feed the model a burst of noise it never heard live.
    const g = createHalfDuplexGate({ lookbackMs: 200, bargeMs: 300 });
    for (let i = 0; i < 10; i++) g.push({ frame: frame(i), playing: true, atMs: i * 20, ...QUIET });

    const out = g.push({ frame: frame(50), playing: false, atMs: 220, ...QUIET });

    expect(out.forward).toEqual([frame(50)]);
  });

  it("can barge again on the next reply", () => {
    const g = createHalfDuplexGate({ lookbackMs: 200, bargeMs: 300 });
    expect(g.push({ frame: frame(1), playing: true, atMs: 0, ...TALKING }).barge).toBe(true);
    g.push({ frame: frame(2), playing: false, atMs: 500, ...QUIET });

    expect(g.push({ frame: frame(3), playing: true, atMs: 1000, ...TALKING }).barge).toBe(true);
  });
});
