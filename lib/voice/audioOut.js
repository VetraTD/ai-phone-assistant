import { performance } from "node:perf_hooks";
import { log } from "../logger.js";
import { rampFrame } from "./mulaw.js";

// ---------------------------------------------------------------------------
// Outbound Twilio Media Streams audio pacing/marks/clear — standalone module
// for the voice-pipeline rewrite. One `createAudioOut(opts)` instance per
// call. WS-agnostic: the caller injects `sendFrame`, a function that writes
// one JSON message to the Twilio WS; this module never touches a socket
// directly, which keeps it unit-testable without a real connection.
//
// This module also maintains the *estimated* AI playback window
// (`playingUntil`), one of the three signals turnManager.js combines to
// decide whether the caller is genuinely speaking during an AI turn (there
// is no acoustic echo cancellation in this pipeline, so the AI's own audio
// can bleed back into the inbound stream).
//
// Twilio mark-echo behavior (verified, load-bearing): after a `clear` event,
// Twilio immediately echoes back all marks that were queued but unplayed at
// the time of the clear — it does not silently discard them. notifyMarkPlayed
// must therefore tolerate being called for marks the module no longer knows
// about (because clear() already dropped them) without throwing or
// resurrecting any state.
// ---------------------------------------------------------------------------

const FRAME_BYTES = 160; // Twilio mu-law frame size: 20ms @ 8kHz, 1 byte/sample
const MULAW_SILENCE_BYTE = 0xff; // mu-law encoding of PCM zero (see lib/voice/mulaw.js)
const BYTES_PER_MS = 8; // 8kHz * 1 byte/sample / 1000 ms
const FRAME_MS = FRAME_BYTES / BYTES_PER_MS; // 20

// ---------------------------------------------------------------------------
// Paced playout
//
// Twilio buffers every `media` message it receives, in order, with no
// documented size limit, and its only stop primitive is `clear` — which
// empties the ENTIRE buffer instantly. There is no partial stop and no fade.
// So handing Twilio a whole utterance up front (the original behavior) makes
// a graceful barge-in impossible by construction: whatever the caller
// interrupts, the cut lands wherever playback happens to be, mid-syllable.
//
// Instead the frames are held here and pumped out on a timer, keeping only
// LOOKAHEAD_MS of unplayed audio inside Twilio. On a barge-in the bulk of
// the utterance is still local (dropped for free), and the small remainder
// already in Twilio is allowed to drain and is followed by a short amplitude
// ramp to silence — so the caller hears the AI trail off rather than vanish.
//
// The lookahead is deliberately SMALL. Barge-in already fires several hundred
// ms after the caller starts talking (STT endpointing + network), so the AI
// is by then already talking over them; a large lookahead would extend that
// overlap, not soften it. Gracefulness comes from the shape of the cut, not
// from delay.
// ---------------------------------------------------------------------------

const LOOKAHEAD_MS = Number.parseInt(process.env.VOICE_LOOKAHEAD_MS, 10) || 100;

// Pump interval. One frame is 20ms, so this keeps the queue topped up at
// roughly the rate Twilio drains it.
const PUMP_INTERVAL_MS = 20;

// Duration of the amplitude ramp appended on a tapered clear(). No vendor or
// framework publishes a value for this; general audio-engineering practice
// for a declick is 5-20ms, and a longer ramp reads as "trailing off" rather
// than "clicked off". 40ms (2 frames) is a starting point meant to be tuned
// by ear on real calls.
const DEFAULT_FADE_MS = Number.parseInt(process.env.VOICE_BARGE_FADE_MS, 10) || 40;

// Escape hatch: VOICE_PACED_PLAYOUT=false restores the original behavior of
// writing every frame to Twilio immediately (and a hard, instant clear).
const PACING_ENABLED = process.env.VOICE_PACED_PLAYOUT !== "false";

/**
 * Create an outbound-audio pacing/marks/clear controller for one call.
 *
 * @param {object} opts
 * @param {function(object): void} opts.sendFrame - writes one JSON message to the Twilio WS
 * @param {string} opts.streamSid - Twilio Media Streams stream SID
 * @param {function(): number} [opts.now] - injectable clock (ms), defaults to performance.now()
 * @returns {{
 *   enqueue: function(Buffer, string=): void,
 *   sendMark: function(string): void,
 *   clear: function(): void,
 *   notifyMarkPlayed: function(string): void,
 *   aiAudioPlayingUntil: function(): number,
 *   isPlaying: function(number=): boolean,
 *   hasOutstandingMarks: function(): boolean,
 *   reset: function(): void,
 * }}
 */
export function createAudioOut({ sendFrame, streamSid, now = () => performance.now() } = {}) {
  let playingUntil = 0;
  const outstandingMarks = new Set();

  // Paced-playout state. `queue` holds {frame} and {mark} items in strict
  // submission order, so a mark never overtakes the audio it was queued
  // behind. `sentUntil` is when everything ALREADY handed to Twilio finishes
  // playing — the pump keeps (sentUntil - now) at or under LOOKAHEAD_MS.
  const queue = [];
  let sentUntil = 0;
  let pumpTimer = null;

  function safeSend(msg) {
    try {
      sendFrame?.(msg);
    } catch (err) {
      log.error("audio_out_send_failed", { streamSid, event: msg?.event, reason: err?.message });
    }
  }

  function sendAudioFrame(frame) {
    safeSend({ event: "media", streamSid, media: { payload: frame.toString("base64") } });
    sentUntil = Math.max(sentUntil, now()) + FRAME_MS;
  }

  /**
   * Drain the queue into Twilio while the unplayed audio already sitting
   * there is under LOOKAHEAD_MS. Marks carry no duration, so they pass
   * through as soon as they reach the head.
   */
  function pump() {
    try {
      while (queue.length > 0) {
        const head = queue[0];
        if (head.mark !== undefined) {
          queue.shift();
          safeSend({ event: "mark", streamSid, mark: { name: head.mark } });
          continue;
        }
        if (sentUntil - now() >= LOOKAHEAD_MS) return;
        queue.shift();
        sendAudioFrame(head.frame);
      }
    } catch (err) {
      log.error("audio_out_pump_failed", { streamSid, reason: err?.message });
    } finally {
      if (queue.length === 0) stopPump();
    }
  }

  function startPump() {
    if (pumpTimer) return;
    pumpTimer = setInterval(pump, PUMP_INTERVAL_MS);
    pumpTimer.unref?.();
  }

  function stopPump() {
    if (!pumpTimer) return;
    clearInterval(pumpTimer);
    pumpTimer = null;
  }

  /**
   * Send a standalone mark event and track it as outstanding.
   *
   * The mark is tracked as outstanding immediately (so hasOutstandingMarks
   * is true the instant it is requested, as before) but, when pacing is on,
   * only reaches the wire once the audio queued ahead of it has been sent —
   * otherwise a mark would arrive at Twilio before its own audio and echo
   * back early, which is exactly the "-done fired before the line finished"
   * class of bug the close/silence lifecycle depends on not happening.
   * @param {string} markName
   */
  function sendMark(markName) {
    try {
      if (!markName) return;
      outstandingMarks.add(markName);
      if (!PACING_ENABLED) {
        safeSend({ event: "mark", streamSid, mark: { name: markName } });
        return;
      }
      queue.push({ mark: markName });
      startPump();
      pump();
    } catch (err) {
      log.error("audio_out_send_mark_failed", { streamSid, markName, reason: err?.message });
    }
  }

  /**
   * Split a mu-law buffer into 160-byte Twilio media frames (padding the
   * final short frame with mu-law silence) and send them, followed by an
   * optional mark.
   * @param {Buffer} mulawBuf
   * @param {string} [markName]
   */
  function enqueue(mulawBuf, markName) {
    try {
      if (!mulawBuf || mulawBuf.length === 0) {
        if (markName) sendMark(markName);
        return;
      }

      const buf = Buffer.isBuffer(mulawBuf) ? mulawBuf : Buffer.from(mulawBuf);

      for (let offset = 0; offset < buf.length; offset += FRAME_BYTES) {
        let frame = buf.subarray(offset, offset + FRAME_BYTES);
        if (frame.length < FRAME_BYTES) {
          const padded = Buffer.alloc(FRAME_BYTES, MULAW_SILENCE_BYTE);
          frame.copy(padded, 0);
          frame = padded;
        }
        if (PACING_ENABLED) {
          queue.push({ frame });
        } else {
          safeSend({ event: "media", streamSid, media: { payload: frame.toString("base64") } });
        }
      }

      // Use the padded/wire byte count (rounded up to a whole FRAME_BYTES),
      // not buf.length — the final short frame is padded with silence up to
      // FRAME_BYTES before being sent, and that padding takes real playback
      // time too. Using the unpadded input length understated playingUntil
      // by up to one frame (~20ms @ 8kHz), letting turnManager's AI-speaking
      // window end slightly early.
      //
      // NOTE: this advances on ENQUEUE, not on send, and that is deliberate
      // — playingUntil must keep meaning "when the caller stops hearing
      // audio", counting both what Twilio holds and what is still queued
      // here. isPlaying() feeds armSilenceTimer, armCloseFallback and
      // turnManager's AI-speaking window, none of which should change
      // behavior just because the frames now leave in smaller batches.
      const wireBytes = Math.ceil(buf.length / FRAME_BYTES) * FRAME_BYTES;
      const nowMs = now();
      playingUntil = Math.max(playingUntil, nowMs) + wireBytes / BYTES_PER_MS;

      if (PACING_ENABLED) {
        startPump();
        pump();
      }

      if (markName) sendMark(markName);
    } catch (err) {
      log.error("audio_out_enqueue_failed", { streamSid, markName, reason: err?.message });
    }
  }

  /**
   * Stop playback.
   *
   * `clear()` — a hard stop. Sends Twilio's `clear`, which empties its whole
   * buffer instantly. Correct for teardown, where nothing should be heard.
   *
   * `clear({ fadeMs })` — a tapered stop for barge-in. Drops the queued
   * remainder locally and, instead of sending `clear`, hands Twilio a short
   * amplitude ramp built from the frames that were about to play. Twilio
   * therefore plays [<=LOOKAHEAD_MS of real audio it already holds] followed
   * by [fadeMs ramping to silence] and then stops on its own — the AI trails
   * off instead of being chopped. Falls back to a hard clear when pacing is
   * disabled, since without a local queue there is nothing to ramp.
   *
   * Either way the playback window collapses and outstanding-mark
   * bookkeeping is dropped — any marks Twilio echoes back afterward are
   * simply unknown to notifyMarkPlayed and silently ignored (module header).
   *
   * @param {{fadeMs?: number}} [opts]
   * @returns {{fadedMs: number, droppedFrames: number}} what actually happened
   */
  function clear({ fadeMs } = {}) {
    try {
      const wantFade = PACING_ENABLED && fadeMs !== undefined && fadeMs > 0;
      const droppedFrames = queue.filter((item) => item.frame !== undefined).length;

      if (!wantFade) {
        queue.length = 0;
        stopPump();
        safeSend({ event: "clear", streamSid });
        playingUntil = now();
        sentUntil = now();
        outstandingMarks.clear();
        return { fadedMs: 0, droppedFrames };
      }

      // Build the ramp from the frames that were next in line, so the taper
      // is a continuation of the actual speech rather than injected tone.
      const rampFrames = Math.max(1, Math.round(fadeMs / FRAME_MS));
      const upcoming = [];
      for (const item of queue) {
        if (item.frame !== undefined) upcoming.push(item.frame);
        if (upcoming.length >= rampFrames) break;
      }
      queue.length = 0;
      stopPump();

      // Nothing queued to ramp (TTS had already drained into Twilio): a hard
      // clear would chop, so let what Twilio holds simply finish playing.
      if (upcoming.length === 0) {
        outstandingMarks.clear();
        playingUntil = Math.max(now(), sentUntil);
        return { fadedMs: 0, droppedFrames };
      }

      const n = upcoming.length;
      for (let i = 0; i < n; i++) {
        // Gain walks 1 -> 0 across the whole ramp, continuous across frames.
        sendAudioFrame(rampFrame(upcoming[i], 1 - i / n, 1 - (i + 1) / n));
      }

      outstandingMarks.clear();
      playingUntil = Math.max(now(), sentUntil);
      return { fadedMs: n * FRAME_MS, droppedFrames };
    } catch (err) {
      log.error("audio_out_clear_failed", { streamSid, reason: err?.message });
      return { fadedMs: 0, droppedFrames: 0 };
    }
  }

  /**
   * Record that Twilio confirmed a mark was played. Safe to call for a
   * mark name this instance no longer knows about (e.g. one echoed back
   * after clear()) — that's a no-op, not an error.
   * @param {string} markName
   */
  function notifyMarkPlayed(markName) {
    try {
      outstandingMarks.delete(markName);
    } catch (err) {
      log.error("audio_out_notify_mark_failed", { streamSid, markName, reason: err?.message });
    }
  }

  /** @returns {number} estimated timestamp (ms, same clock as `now`) when queued AI audio finishes playing */
  function aiAudioPlayingUntil() {
    return playingUntil;
  }

  /**
   * @param {number} [graceMs=150] - extra window past playingUntil to still count as "playing"
   *   (accounts for playback/network jitter and trailing echo settle time)
   * @returns {boolean}
   */
  function isPlaying(graceMs = 150) {
    try {
      return now() < playingUntil + graceMs;
    } catch {
      return false;
    }
  }

  /** @returns {boolean} whether any mark is still awaiting a notifyMarkPlayed confirmation */
  function hasOutstandingMarks() {
    return outstandingMarks.size > 0;
  }

  /** Reset all state (playback window, queue, outstanding marks) to initial conditions. */
  function reset() {
    playingUntil = 0;
    sentUntil = 0;
    queue.length = 0;
    stopPump();
    outstandingMarks.clear();
  }

  /**
   * Release the pump timer. Call once at call teardown — without it the
   * interval would survive the socket for as long as anything held a
   * reference (it is unref'd, so it can't hold the process open, but one
   * live timer per finished call is still a leak).
   */
  function stop() {
    stopPump();
    queue.length = 0;
  }

  return {
    enqueue,
    sendMark,
    clear,
    notifyMarkPlayed,
    aiAudioPlayingUntil,
    isPlaying,
    hasOutstandingMarks,
    reset,
    stop,
    /** @returns {number} frames still held locally (not yet sent to Twilio). For tests/telemetry. */
    _queuedFrames: () => queue.filter((item) => item.frame !== undefined).length,
  };
}
