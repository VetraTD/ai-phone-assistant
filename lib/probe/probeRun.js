import { performance } from "node:perf_hooks";
import { log } from "../logger.js";
import { createVad } from "../voice/inboundVad.js";

// ---------------------------------------------------------------------------
// Scripted caller side of a measured test call.
//
// A Twilio->Twilio probe call has two legs: the assistant answers its own
// number normally, and this runs the ORIGINATING leg, playing pre-recorded
// caller audio and timing how long the reply takes to come back.
//
// Why bother, when the server already records per-turn latency: the server's
// clock starts when Deepgram's final reaches it and stops when audio is handed
// to the pacing queue. Deepgram's endpointing window, both carrier hops and
// the pump's lookahead all sit outside that window. This runner's clock sits
// outside the server entirely, so `probeV2vMs` is the wait a caller actually
// experiences. Subtracting the server's own number gives the remainder Twilio
// and the network own — a quantity nothing in this codebase has ever measured.
//
// Determinism is the point of the design: identical audio every call, one
// frame per tick, and every input injected (clock, frame sink, inbound audio).
// The state machine can therefore be tested without a socket or a phone call,
// and two runs differ only because the system under test differed.
// ---------------------------------------------------------------------------

/** Twilio mu-law frame: 20ms @ 8kHz, 1 byte/sample. */
export const FRAME_BYTES = 160;
const FRAME_MS = 20;

const STATE = {
  GREETING: "greeting", // assistant is delivering its opening line
  SPEAKING: "speaking", // we are playing an utterance
  AWAITING: "awaiting_reply", // we finished; timing the silence before the reply
  LISTENING: "listening", // assistant is replying
  GAP: "gap", // reply over; brief pause before the next utterance
  DONE: "done",
};

/**
 * Create the scripted caller for one probe call.
 *
 * @param {object} opts
 * @param {Array<{label: string, mulaw: Buffer, bargeInAfterMs?: number}>} opts.script
 *   Utterances in order. `bargeInAfterMs` makes the utterance interrupt the
 *   assistant that many ms after its reply starts, instead of waiting for it
 *   to finish.
 * @param {function(Buffer): void} opts.sendFrame - writes one 160-byte mu-law frame to the call
 * @param {function(): number} [opts.now] - injectable clock (ms)
 * @param {number} [opts.replyTimeoutMs=8000] - give up waiting for a reply after this long
 * @param {number} [opts.silenceMs=800] - unvoiced time that counts as "the assistant stopped"
 * @param {number} [opts.gapMs=400] - pause between the assistant finishing and our next utterance
 * @param {object} [opts.vad] - injectable VAD (defaults to lib/voice/inboundVad.js)
 * @returns {{tick: function(): void, handleInbound: function(Buffer): void,
 *   getTurns: function(): object[], isDone: function(): boolean, stop: function(): void}}
 */
export function createProbeRun({
  script = [],
  sendFrame,
  now = () => performance.now(),
  replyTimeoutMs = 8000,
  silenceMs = 800,
  gapMs = 400,
  vad = createVad(),
} = {}) {
  let state = STATE.GREETING;
  let index = -1; // index of the utterance being spoken / just spoken
  let offset = 0; // byte offset into the current utterance
  let speechEndAt = null; // when our last frame went out
  let replyStartAt = null; // when the assistant's audio first came back
  let lastVoicedAt = null;
  let gapStartAt = null;
  let stopped = false;

  const turns = [];

  function currentUtterance() {
    return script[index] ?? null;
  }

  /**
   * Begin (or resume) speaking utterance `i`. Called both for ordinary turns
   * and for a barge-in, which is the same action taken at a different moment.
   */
  function beginUtterance(i) {
    index = i;
    offset = 0;
    speechEndAt = null;
    replyStartAt = null;
    state = STATE.SPEAKING;
  }

  /** Advance past the utterance just measured, or finish the run. */
  function advance() {
    if (index + 1 >= script.length) {
      state = STATE.DONE;
      return;
    }
    beginUtterance(index + 1);
  }

  /**
   * Close out the current turn's measurement.
   * @param {number|null} v2vMs - null when the assistant never replied
   */
  function recordTurn(v2vMs) {
    const utt = currentUtterance();
    if (!utt) return;
    turns.push({
      label: utt.label,
      index,
      probeV2vMs: v2vMs === null ? null : Math.round(v2vMs),
      bargeIn: Boolean(utt.bargeInAfterMs),
      timedOut: v2vMs === null,
      speechEndAt,
      replyStartAt,
    });
  }

  /**
   * Should the NEXT utterance cut in over the assistant's current reply?
   * Only true once the reply has been running for its configured offset, so
   * the interruption lands mid-sentence the way a real one does.
   */
  function bargeDue(atMs) {
    const next = script[index + 1];
    if (!next?.bargeInAfterMs) return false;
    if (replyStartAt === null) return false;
    return atMs - replyStartAt >= next.bargeInAfterMs;
  }

  function tick() {
    if (stopped || state === STATE.DONE) return;
    try {
      const t = now();

      switch (state) {
        case STATE.SPEAKING: {
          const utt = currentUtterance();
          if (!utt) {
            state = STATE.DONE;
            return;
          }
          if (offset >= utt.mulaw.length) {
            state = STATE.AWAITING;
            return;
          }
          // Exactly one frame per tick keeps playback at realtime. Bursting
          // would compress the utterance and desynchronise everything after.
          const frame = utt.mulaw.subarray(offset, offset + FRAME_BYTES);
          offset += FRAME_BYTES;
          try {
            sendFrame?.(frame);
          } catch (err) {
            log.error("probe_send_frame_failed", { reason: err?.message });
          }
          if (offset >= utt.mulaw.length) {
            // Stamp the end of speech from the frame itself — the moment it
            // was sent plus the 20ms it occupies — rather than waiting for the
            // next tick to notice. Same value when ticks are punctual, but it
            // no longer moves if the driver's timer drifts, and it is the one
            // number every measurement in this run is subtracted from.
            speechEndAt = t + FRAME_MS;
            state = STATE.AWAITING;
          }
          return;
        }

        case STATE.AWAITING: {
          if (speechEndAt !== null && t - speechEndAt >= replyTimeoutMs) {
            // Record the miss rather than stalling the call: one unanswered
            // turn should not cost the whole run.
            recordTurn(null);
            advance();
          }
          return;
        }

        case STATE.LISTENING: {
          if (bargeDue(t)) {
            beginUtterance(index + 1);
            return;
          }
          if (lastVoicedAt !== null && t - lastVoicedAt >= silenceMs) {
            state = STATE.GAP;
            gapStartAt = t;
          }
          return;
        }

        case STATE.GREETING:
        case STATE.GAP: {
          if (gapStartAt === null) return; // assistant hasn't finished yet
          if (t - gapStartAt < gapMs) return;
          if (state === STATE.GREETING) {
            beginUtterance(0);
          } else {
            advance();
          }
          gapStartAt = null;
          return;
        }
      }
    } catch (err) {
      log.error("probe_tick_failed", { reason: err?.message, state });
    }
  }

  /**
   * Feed one inbound mu-law frame from the call.
   * @param {Buffer} mulawBuf
   */
  function handleInbound(mulawBuf) {
    if (stopped || state === STATE.DONE) return;
    try {
      const t = now();
      const { voiced } = vad.processFrame(mulawBuf, t);
      if (!voiced) {
        // Silence during the greeting/reply starts the countdown to our turn.
        if ((state === STATE.GREETING || state === STATE.LISTENING) && lastVoicedAt !== null) {
          if (t - lastVoicedAt >= silenceMs && gapStartAt === null) {
            gapStartAt = t;
            if (state === STATE.LISTENING) state = STATE.GAP;
          }
        }
        return;
      }

      lastVoicedAt = t;
      // Voice again before the gap elapsed: the assistant was mid-pause, not
      // finished. Cancel the countdown so we don't talk over a continuation.
      if (gapStartAt !== null && state !== STATE.GAP) gapStartAt = null;

      if (state === STATE.AWAITING) {
        // Assistant audio arriving only AFTER our speech ended is the reply
        // to it. Anything earlier is the previous line still finishing (or
        // echo), and is deliberately not measured — see the module header.
        replyStartAt = t;
        recordTurn(t - speechEndAt);
        state = STATE.LISTENING;
      }
    } catch (err) {
      log.error("probe_inbound_failed", { reason: err?.message });
    }
  }

  return {
    tick,
    handleInbound,
    getTurns: () => turns.slice(),
    isDone: () => state === STATE.DONE || stopped,
    stop: () => {
      stopped = true;
    },
  };
}
