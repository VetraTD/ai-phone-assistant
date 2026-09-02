import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  selectStrategy,
  createVendorAd,
  createFlatHangover,
  createClassifyHoldStrategy,
} from "../lib/voice/live/turnEnd/index.js";

// ---------------------------------------------------------------------------
// Who decides the caller's turn ended is NOT decided, and this file exists to
// keep it that way until a real handset says so.
//
// docs/speech-to-speech-handoff.md section 6 demotes `classifyHold` from a
// decision to a CANDIDATE. Arm A -- the vendor's own automaticActivityDetection
// -- is the incumbent and it is winning on the only numbers anyone has:
// 1,325 ms felt against 2,246 ms for a flat 1,200 ms hangover, measured on
// matched speakerphone calls (scripts/spike/VERDICT.md). Arm C's advantage is
// a PREDICTION: classifyHold returns 0 ms for a sentence ending in terminal
// punctuation, so a caller who speaks in whole sentences should be answered
// after roughly the transcript lag (113-360 ms) instead of a flat timer.
//
// So all three arms ship, arm A is the default, and these tests assert the
// MECHANISM of each -- not that any of them is better. The comparison is a
// live-call round, not a unit test.
// ---------------------------------------------------------------------------

/**
 * Drive a strategy over a synthetic 20 ms frame timeline and report the first
 * close, so a test can assert WHEN a turn ends rather than merely that it does.
 *
 * Real Twilio streams frames continuously -- silence included -- which is why
 * no timer is needed anywhere in these strategies. `isActive` mirrors
 * inboundVad's 300 ms hangover: it stays true for 300 ms after the last voiced
 * frame, exactly as lib/voice/inboundVad.js does.
 */
function run(strategy, { voicedUntilMs, totalMs, transcriptAtMs = null, transcriptText = "" }) {
  const events = [];
  let transcriptSent = false;
  for (let atMs = 0; atMs <= totalMs; atMs += 20) {
    if (transcriptAtMs !== null && !transcriptSent && atMs >= transcriptAtMs) {
      strategy.onTranscript({ text: transcriptText, atMs });
      transcriptSent = true;
    }
    const voiced = atMs <= voicedUntilMs;
    const isActive = atMs - Math.min(atMs, voicedUntilMs) < 300;
    const out = strategy.onFrame({ voiced, isActive, atMs }) || {};
    if (out.open) events.push({ kind: "open", atMs });
    if (out.close) events.push({ kind: "close", atMs, rule: out.rule });
  }
  return {
    events,
    open: events.find((e) => e.kind === "open") || null,
    close: events.find((e) => e.kind === "close") || null,
    closes: events.filter((e) => e.kind === "close"),
  };
}

describe("arm A - the vendor's own activity detection", () => {
  it("leaves automaticActivityDetection alone so the vendor still endpoints", () => {
    const cfg = createVendorAd().connectConfig();
    expect(cfg?.realtimeInputConfig?.automaticActivityDetection?.disabled).toBeUndefined();
  });

  it("is not manual, so the session sends no activityStart/activityEnd", () => {
    // The whole point of arm A: we do not signal, the vendor decides. If this
    // flips, arm A silently becomes arm B with the vendor's detector also on.
    expect(createVendorAd().manual).toBe(false);
  });

  it("still marks turn boundaries so its latency is comparable with the other arms", () => {
    // The spike found this the hard way: without bookkeeping the auto arm
    // produced one latency sample per call and the arms could not be compared
    // at all, which is the single thing that arm exists for.
    const r = run(createVendorAd({ bookkeepingHangoverMs: 1200 }), {
      voicedUntilMs: 500,
      totalMs: 3000,
    });
    expect(r.open?.atMs).toBe(0);
    expect(r.close).not.toBeNull();
    expect(r.close.rule).toBe("vendor_bookkeeping");
  });
});

describe("arm B - manual detection with a flat hangover", () => {
  it("disables the vendor's detector", () => {
    const cfg = createFlatHangover().connectConfig();
    expect(cfg.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
  });

  it("opens the turn on the first voiced frame", () => {
    const r = run(createFlatHangover({ hangoverMs: 1200 }), { voicedUntilMs: 500, totalMs: 2000 });
    expect(r.open?.atMs).toBe(0);
  });

  it("closes one hangover after the last voiced frame, not before", () => {
    const r = run(createFlatHangover({ hangoverMs: 1200 }), { voicedUntilMs: 500, totalMs: 3000 });
    expect(r.close?.atMs).toBe(1700);
    expect(r.close?.rule).toBe("flat_hangover");
  });

  it("does not close during a mid-sentence pause shorter than the hangover", () => {
    // 400 ms of silence, then the caller carries on. A close here is a cut-off.
    const s = createFlatHangover({ hangoverMs: 1200 });
    const closes = [];
    for (let atMs = 0; atMs <= 2000; atMs += 20) {
      const voiced = atMs <= 500 || (atMs >= 900 && atMs <= 1400);
      const gap = voiced ? 0 : atMs - (atMs < 900 ? 500 : 1400);
      const out = s.onFrame({ voiced, isActive: gap < 300, atMs }) || {};
      if (out.close) closes.push(atMs);
    }
    expect(closes).toEqual([]);
  });

  it("closes once, not on every frame after the hangover", () => {
    const r = run(createFlatHangover({ hangoverMs: 1200 }), { voicedUntilMs: 500, totalMs: 6000 });
    expect(r.closes).toHaveLength(1);
  });
});

describe("arm C - manual detection priced by classifyHold", () => {
  beforeEach(() => {
    // classifyHold reads these at call time. Pinned so the arithmetic below is
    // an assertion about the strategy rather than about the ambient env.
    vi.stubEnv("VOICE_HOLD_NO_PUNCT_MS", "500");
    vi.stubEnv("VOICE_HOLD_TRAILING_MS", "800");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("disables the vendor's detector, like arm B", () => {
    const cfg = createClassifyHoldStrategy().connectConfig();
    expect(cfg.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
  });

  it("answers a finished sentence at the silence floor, not at a flat timer", () => {
    // THE prediction, stated as a number. classifyHold returns 0 ms for
    // terminal punctuation, so the turn ends at minSilenceMs after the last
    // voiced frame -- 800 ms, where arm B would still be waiting for 1,700.
    const r = run(createClassifyHoldStrategy({ minSilenceMs: 300, backstopMs: 1200 }), {
      voicedUntilMs: 500,
      totalMs: 3000,
      transcriptAtMs: 750,
      transcriptText: "I would like to book an appointment.",
    });
    expect(r.close?.atMs).toBe(800);
    expect(r.close?.rule).toBe("terminal_punctuation");
  });

  it("holds a trailing conjunction for its full 2000 ms", () => {
    // The trail-off case manual detection exists for: an utterance ending on
    // "for" is indistinguishable from a finished sentence by silence alone.
    const r = run(createClassifyHoldStrategy({ minSilenceMs: 300, backstopMs: 4000 }), {
      voicedUntilMs: 500,
      totalMs: 4000,
      transcriptAtMs: 750,
      transcriptText: "I would like to book an appointment for",
    });
    expect(r.close?.atMs).toBe(2500);
    expect(r.close?.rule).toBe("trailing_conjunction");
  });

  it("holds mid-dictation of a phone number", () => {
    const r = run(createClassifyHoldStrategy({ minSilenceMs: 300, backstopMs: 4000 }), {
      voicedUntilMs: 500,
      totalMs: 4000,
      transcriptAtMs: 750,
      transcriptText: "My number is 0771",
    });
    expect(r.close?.rule).toBe("partial_digits");
    expect(r.close?.atMs).toBe(2000);
  });

  it("falls back to the backstop when no transcript ever arrives", () => {
    // Not tested by the spike and not optional: arm C is the only arm whose
    // turn end depends on a message from the vendor. If transcription fails or
    // is disabled, without this the caller is never answered at all.
    const r = run(createClassifyHoldStrategy({ minSilenceMs: 300, backstopMs: 1200 }), {
      voicedUntilMs: 500,
      totalMs: 4000,
    });
    expect(r.close?.atMs).toBe(1700);
    expect(r.close?.rule).toBe("hold_backstop");
  });

  it("discards a pending hold when the caller starts speaking again", () => {
    // The continuation cancels the hold, which is the behaviour that makes a
    // hold cost nothing when it guesses wrong.
    const s = createClassifyHoldStrategy({ minSilenceMs: 300, backstopMs: 5000 });
    const closes = [];
    for (let atMs = 0; atMs <= 3000; atMs += 20) {
      if (atMs === 760) s.onTranscript({ text: "I would like to book an appointment for", atMs });
      const voiced = atMs <= 500 || (atMs >= 1000 && atMs <= 1600);
      const gap = voiced ? 0 : atMs - (atMs < 1000 ? 500 : 1600);
      const out = s.onFrame({ voiced, isActive: gap < 300, atMs }) || {};
      if (out.close) closes.push({ atMs, rule: out.rule });
    }
    // The 2000 ms hold measured from the FIRST pause would have fired at 2500.
    // It must not: the caller resumed at 1000.
    expect(closes.every((c) => c.atMs > 2500)).toBe(true);
  });
});

describe("selectStrategy", () => {
  it("defaults to the incumbent", () => {
    // Arm A is winning on the only measurements that exist. Nothing is locked,
    // and nothing is switched away from it by accident either.
    expect(selectStrategy({}).name).toBe("vendor");
  });

  it("maps each arm name", () => {
    expect(selectStrategy({ LIVE_TURN_END: "vendor" }).name).toBe("vendor");
    expect(selectStrategy({ LIVE_TURN_END: "hangover" }).name).toBe("hangover");
    expect(selectStrategy({ LIVE_TURN_END: "hold" }).name).toBe("hold");
  });

  it("falls back to the incumbent on an unrecognised value rather than throwing", () => {
    expect(selectStrategy({ LIVE_TURN_END: "nonsense" }).name).toBe("vendor");
  });

  it("reads LIVE_HANGOVER_MS for the flat arm", () => {
    const s = selectStrategy({ LIVE_TURN_END: "hangover", LIVE_HANGOVER_MS: "600" });
    const r = run(s, { voicedUntilMs: 500, totalMs: 3000 });
    expect(r.close?.atMs).toBe(1100);
  });
});
