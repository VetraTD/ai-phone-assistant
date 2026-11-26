import { DEFAULT_BARGE_MS } from "./turnEnd/constants.js";

// ---------------------------------------------------------------------------
// The half-duplex gate: do not forward inbound audio while we are speaking.
//
// ---------------------------------------------------------------------------
// This is the FREE half of manual activity detection
// ---------------------------------------------------------------------------
//
// The design treated "manual activity detection" as one decision for most of
// its life. It is two, and they have completely different costs:
//
//   this gate     costs no latency at all. Not forwarding audio adds no delay.
//   the hangover  costs ~900 ms a turn, and lives in turnEnd/.
//
// Conflating them made the expensive half look mandatory and the cheap half
// look optional, when the truth is the other way round.
//
// ---------------------------------------------------------------------------
// What it guards, and how thin the margin actually is
// ---------------------------------------------------------------------------
//
// The far-end detector sits at the other end of a WebSocket. It has never
// heard our output, so it cannot tell our own voice coming back off a
// speakerphone from the caller speaking. It reads echo as barge-in and cuts
// itself off -- the exact defect three rounds of live-call debugging already
// found in the cascade, which speech-to-speech does not fix.
//
// Measured on nine calls, after two wrong measurements of the same thing:
//
//   worst echo frame                    RMS 211
//   caller's own speech, peak           RMS 14,334   (68x louder)
//   inboundVad's minRms floor           700
//   headroom, echo peak to VAD floor    ~10 dB
//
// Nothing fired in nine calls, including an arm with no gate at all. That is a
// MARGIN, not an absence -- and it is one handset, one room, one carrier's
// echo canceller. A louder speaker, a harder surface or a worse canceller
// closes it.
//
// Free insurance on a thin margin, so it applies in every arm, including the
// vendor-detection one. Worth stating plainly for whoever reads the numbers
// next: the spike's vendor arm ran UNGATED, so its 1,325 ms came from a
// configuration this file changes.
//
// ---------------------------------------------------------------------------
// WHAT THE OTHER HALF OF THAT ASSUMPTION COST -- measured on a real call,
// 2026-09-04 (LVX70)
// ---------------------------------------------------------------------------
//
// The ring was discarded at the end of playback on the grounds stated below:
// the withheld frames were our own echo and the room. For one utterance on that
// call they were not.
//
//   duration 740ms   voiced 280ms   peak_rms 5993   playing_at_open: true
//   frames 38   ->   forwarded 0    held 38    barge: no
//
// The caller answered "Okay" over the top of a long reply. voicedRunMs reached
// 280 against a bargeMs of 300, so it did not count as an interruption;
// playback then ended and all 38 frames were dropped. Gemini never received the
// audio, so no endpointing setting on either side could have ended that turn --
// which is the measurement that took LIVE_TURN_END out of LVX70 entirely.
//
// The numbers above already contained the answer. Echo peaks at RMS 211 against
// inboundVad's floor of 700, so ECHO CANNOT PRODUCE A VOICED FRAME AT ALL. The
// VAD already separates the two things this file was conflating, and the ring
// can now be released on that evidence rather than discarded on the assumption.
// ---------------------------------------------------------------------------

/** Twilio media frames are 20 ms. */
const FRAME_MS = 20;

/**
 * Voiced audio held during playback that is RELEASED rather than discarded when
 * playback ends. LVX70.
 *
 * 200 ms because that is inboundVad's own `activeMs` -- the point at which the
 * VAD stops calling a burst a transient and calls it voice. Borrowing that
 * number rather than inventing one keeps a single definition of "this is
 * speech" on this path.
 *
 * DELIBERATELY NOT bargeMs, and the two are not interchangeable. A barge CUTS
 * OFF the assistant mid-sentence, so a false one is expensive and 300 ms is
 * right there: inboundVad records that a cough is a ~200 ms high-energy burst,
 * and that margin is the whole difference between a cough and a sentence. A
 * release costs nothing but a short burst of audio reaching the vendor just as
 * our own reply ends, which the model can ignore. Lowering bargeMs to catch
 * this case would have paid the expensive price for the cheap problem.
 */
const DEFAULT_RELEASE_MS = 200;

// ---------------------------------------------------------------------------
// Hammersleys round 4 (2026-11-26), owner ruling R29 "keep the start".
//
// Measured on 33 prod calls: 68 of 571 caller utterances lost voiced audio,
// and EVERY loss of 200 ms or more came from the 500 ms ring overflowing while
// we talked: the caller started speaking over our reply and the start of it
// fell out before the interruption registered (the end-of-playback rule below
// can drop at most 180 ms). So, with keepStart:
//   - the ring keeps up to KEEP_MS, still bounded;
//   - what it hands over (a barge, or a release when our audio ends) starts
//     LEAD_IN_MS before the first voiced frame of the caller's latest stretch
//     of speech (voiced frames no more than STRETCH_GAP_MS apart), so their
//     first word survives and the echo and room tone before it are not sent;
//   - speech still going as our audio ends (this frame voiced, and voiced in
//     the last CONTINUE_MS) is handed over even under releaseMs. Echo cannot
//     outlast our own audio, so a voiced frame after it is the caller.
// A short sound said over us that ended well before our audio did -- an
// "okay" mid-reply -- is still dropped: sent late, it could be read as the
// answer to the question we end on. keepStart: false is the gate as it was
// (LIVE_GATE_KEEP_START=off).
// ---------------------------------------------------------------------------
const KEEP_MS = 1_500;
const LEAD_IN_MS = 200;
const STRETCH_GAP_MS = 500;
const CONTINUE_MS = 300;

/**
 * @param {object} [opts]
 * @param {number} [opts.lookbackMs=500] - inbound audio withheld during playback,
 *   released on a confirmed barge so an interruption keeps its first syllable.
 *   With keepStart it is also the window the release test reads.
 * @param {number} [opts.bargeMs] - sustained voiced speech required before
 *   inbound audio during our own playback counts as an interruption.
 * @param {number} [opts.releaseMs] - voiced audio held during playback that is
 *   released rather than discarded once playback ends. See LVX70 in the header.
 * @param {boolean} [opts.keepStart=true] - round 4: keep the start of speech
 *   said over us (see above). False = the gate before round 4.
 */
export function createHalfDuplexGate({
  lookbackMs = 500,
  bargeMs = DEFAULT_BARGE_MS,
  releaseMs = DEFAULT_RELEASE_MS,
  keepStart = true,
} = {}) {
  const windowFrames = Math.max(1, Math.ceil(lookbackMs / FRAME_MS));
  const maxFrames = keepStart ? Math.max(windowFrames, Math.ceil(KEEP_MS / FRAME_MS)) : windowFrames;
  const leadFrames = Math.round(LEAD_IN_MS / FRAME_MS);
  const gapFrames = Math.round(STRETCH_GAP_MS / FRAME_MS);
  const continueFrames = Math.round(CONTINUE_MS / FRAME_MS);
  /** Frames withheld during playback, each tagged with the VAD's verdict. */
  const lookback = [];
  /** Latch: one flush per stretch of playback, not one per frame. */
  let barged = false;

  /** Voiced frames among the newest `n` held. */
  function voicedInNewest(n) {
    let count = 0;
    for (let i = Math.max(0, lookback.length - n); i < lookback.length; i++) if (lookback[i].voiced) count += 1;
    return count;
  }

  /**
   * Where a hand-over starts. keepStart: LEAD_IN_MS before the first voiced
   * frame of the latest stretch of speech. Without a voiced frame, or without
   * keepStart, the newest lookbackMs -- the ring as it always was.
   */
  function handOverStart() {
    // Without keepStart the ring IS the lookbackMs window: hand all of it over.
    if (!keepStart) return 0;
    const windowStart = Math.max(0, lookback.length - windowFrames);
    let last = -1;
    for (let i = lookback.length - 1; i >= 0; i--) {
      if (lookback[i].voiced) {
        last = i;
        break;
      }
    }
    if (last < 0) return windowStart;
    let start = last;
    for (let i = last - 1; i >= 0 && start - i <= gapFrames; i--) if (lookback[i].voiced) start = i;
    return Math.max(0, start - leadFrames);
  }

  /** Empty the ring, handing over the frames from `from`; voiced frames before it are lost. */
  function drainFrom(from) {
    let dropped = 0;
    for (let i = 0; i < from; i++) if (lookback[i].voiced) dropped += 1;
    const frames = lookback.slice(from).map((e) => e.frame);
    lookback.length = 0;
    return { frames, dropped };
  }

  /** Hold one frame; returns the voiced frames that fell out of the bounded ring. */
  function hold(frame, voiced) {
    lookback.push({ frame, voiced: Boolean(voiced) });
    let overflow = 0;
    while (lookback.length > maxFrames) {
      if (lookback.shift().voiced) overflow += 1;
    }
    return overflow;
  }

  /**
   * @param {object} f
   * @param {Buffer} f.frame - the inbound mu-law frame
   * @param {boolean} f.playing - is our own audio playing right now
   * @param {boolean} f.isActive - inboundVad's voiceActive
   * @param {number} f.voicedRunMs - inboundVad's sustained voiced run
   * @returns {{forward: Buffer[], barge: boolean, held: number, dropped: number}}
   *
   * `held` and `dropped` exist for LVX70 and change no behaviour. This gate is
   * the only place on the Live path that discards caller audio, and until these
   * were returned it did so without a trace -- `forward.length` was computed at
   * the call site and thrown away. Two counters reading zero were then taken as
   * proof that "nothing on our side discarded it", when neither of them watches
   * this file. See lib/voice/metrics.js, the live_utterance_* block.
   *
   * `dropped` counts VOICED frames the caller really did speak into and the
   * model was never given. It ignores unvoiced ones deliberately: counting
   * every frame that fell out of the ring during a long reply reported 2,540
   * lost frames on an utterance whose own 374 frames were every one forwarded,
   * which is a number that looks alarming and means nothing.
   *
   * `released` counts frames handed over at the end of playback that would
   * previously have been discarded. See LVX70 in the header.
   *
   * `droppedOverflow` (round 4) is the part of `dropped` that fell out of the
   * bounded ring while we were still playing, as opposed to a ring discarded
   * or trimmed at a hand-over.
   */
  function push({ frame, playing, voiced, isActive, voicedRunMs }) {
    if (!playing) {
      // The normal path while we are silent: nothing held, nothing to decide.
      if (lookback.length === 0) {
        barged = false;
        return { forward: frame ? [frame] : [], barge: false, held: 0, dropped: 0, droppedOverflow: 0, released: 0 };
      }
      // Playback is over, and what happens to the ring here is LVX70.
      //
      // It used to be discarded unconditionally, because the withheld frames
      // were assumed to be our own echo and the room. That is true of the
      // UNVOICED ones and provably false of the voiced ones: echo peaks at RMS
      // 211 against inboundVad's floor of 700, so a frame the VAD called voiced
      // is not our own audio coming back. On 2026-09-04 that assumption threw
      // away a caller's "Okay" -- 280 ms of speech at RMS 5993 -- and the model
      // never learned they had answered at all.
      //
      // So: release it when the ring holds real speech, drop it otherwise. The
      // audio reaches the vendor just as our own reply ends, which is a natural
      // point to receive it, and the caller does not have to say it twice.
      const speech = voicedInNewest(windowFrames) * FRAME_MS >= releaseMs;
      // Round 4: their voice carries on past our audio, so this is speech
      // crossing the end, not a blip under it.
      const carriesOn = keepStart && Boolean(voiced) && voicedInNewest(continueFrames) > 0;
      barged = false;
      if (speech || carriesOn) {
        const { frames, dropped } = drainFrom(handOverStart());
        return {
          forward: frame ? [...frames, frame] : frames,
          barge: false,
          held: 0,
          dropped,
          droppedOverflow: 0,
          released: frames.length,
        };
      }
      // Only the voiced part of a discarded ring is a loss. The rest is silence
      // leaving a buffer.
      const { dropped } = drainFrom(lookback.length);
      return { forward: frame ? [frame] : [], barge: false, held: 0, dropped, droppedOverflow: 0, released: 0 };
    }

    const interrupting = Boolean(isActive) && Number(voicedRunMs) >= bargeMs;

    if (interrupting && !barged) {
      barged = true;
      // The interrupting frame joins the held frames (unbounded for this one
      // push) so the hand-over can find the start of the stretch it belongs to.
      if (frame) lookback.push({ frame, voiced: Boolean(voiced) });
      const { frames, dropped } = drainFrom(handOverStart());
      return { forward: frames, barge: true, held: 0, dropped, droppedOverflow: 0, released: 0 };
    }

    if (barged) {
      // Already flushed; the caller is mid-interruption and their audio should
      // now flow normally even though our own tail may still be draining.
      return { forward: frame ? [frame] : [], barge: false, held: 0, dropped: 0, droppedOverflow: 0, released: 0 };
    }

    // Held rather than dropped, and bounded: a long reply must not buffer the
    // whole call.
    const overflow = frame ? hold(frame, voiced) : 0;
    return { forward: [], barge: false, held: frame ? 1 : 0, dropped: overflow, droppedOverflow: overflow, released: 0 };
  }

  return {
    push,
    reset() {
      lookback.length = 0;
      barged = false;
    },
  };
}
