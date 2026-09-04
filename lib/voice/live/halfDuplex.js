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
// ---------------------------------------------------------------------------

/** Twilio media frames are 20 ms. */
const FRAME_MS = 20;

/**
 * @param {object} [opts]
 * @param {number} [opts.lookbackMs=500] - inbound audio withheld during playback,
 *   released on a confirmed barge so an interruption keeps its first syllable.
 * @param {number} [opts.bargeMs] - sustained voiced speech required before
 *   inbound audio during our own playback counts as an interruption.
 */
export function createHalfDuplexGate({ lookbackMs = 500, bargeMs = DEFAULT_BARGE_MS } = {}) {
  const maxFrames = Math.max(1, Math.ceil(lookbackMs / FRAME_MS));
  /** Frames withheld during playback. */
  const lookback = [];
  /** Latch: one flush per stretch of playback, not one per frame. */
  let barged = false;

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
   * `dropped` counts frames the caller really did speak into and the model was
   * never given: the ring discarded at the end of playback, and anything that
   * fell out of the bounded ring before that.
   */
  function push({ frame, playing, isActive, voicedRunMs }) {
    if (!playing) {
      // Playback is over. The withheld frames were our own echo and the room;
      // releasing them now would hand the model a burst of audio the caller
      // never spoke. Drop them and reset the latch for the next reply.
      const dropped = lookback.length;
      lookback.length = 0;
      barged = false;
      return { forward: frame ? [frame] : [], barge: false, held: 0, dropped };
    }

    const interrupting = Boolean(isActive) && Number(voicedRunMs) >= bargeMs;

    if (interrupting && !barged) {
      barged = true;
      const held = lookback.splice(0, lookback.length);
      return { forward: frame ? [...held, frame] : held, barge: true, held: 0, dropped: 0 };
    }

    if (barged) {
      // Already flushed; the caller is mid-interruption and their audio should
      // now flow normally even though our own tail may still be draining.
      return { forward: frame ? [frame] : [], barge: false, held: 0, dropped: 0 };
    }

    // Held rather than dropped, and bounded: a long reply must not buffer the
    // whole call.
    let dropped = 0;
    if (frame) {
      lookback.push(frame);
      while (lookback.length > maxFrames) {
        lookback.shift();
        dropped += 1;
      }
    }
    return { forward: [], barge: false, held: frame ? 1 : 0, dropped };
  }

  return {
    push,
    reset() {
      lookback.length = 0;
      barged = false;
    },
  };
}
