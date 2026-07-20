import { performance } from "node:perf_hooks";
import { log } from "../logger.js";

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
const MULAW_SILENCE_BYTE = 0xff; // mu-law encoding of PCM zero (see inboundVad.js's decode table)
const BYTES_PER_MS = 8; // 8kHz * 1 byte/sample / 1000 ms

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

  function safeSend(msg) {
    try {
      sendFrame?.(msg);
    } catch (err) {
      log.error("audio_out_send_failed", { streamSid, event: msg?.event, reason: err?.message });
    }
  }

  /**
   * Send a standalone mark event and track it as outstanding.
   * @param {string} markName
   */
  function sendMark(markName) {
    try {
      if (!markName) return;
      outstandingMarks.add(markName);
      safeSend({ event: "mark", streamSid, mark: { name: markName } });
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
        safeSend({ event: "media", streamSid, media: { payload: frame.toString("base64") } });
      }

      const nowMs = now();
      playingUntil = Math.max(playingUntil, nowMs) + buf.length / BYTES_PER_MS;

      if (markName) sendMark(markName);
    } catch (err) {
      log.error("audio_out_enqueue_failed", { streamSid, markName, reason: err?.message });
    }
  }

  /**
   * Tell Twilio to stop playing queued audio immediately. Resets the
   * playback window to "now" and drops outstanding-mark bookkeeping — any
   * marks Twilio echoes back afterward for the cleared audio are simply
   * unknown to notifyMarkPlayed and silently ignored (see module header).
   */
  function clear() {
    try {
      safeSend({ event: "clear", streamSid });
      playingUntil = now();
      outstandingMarks.clear();
    } catch (err) {
      log.error("audio_out_clear_failed", { streamSid, reason: err?.message });
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

  /** Reset all state (playback window, outstanding marks) to initial conditions. */
  function reset() {
    playingUntil = 0;
    outstandingMarks.clear();
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
  };
}
