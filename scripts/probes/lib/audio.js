// ---------------------------------------------------------------------------
// Fixture loading, resampling and REAL-TIME pacing.
//
// PLAN.md: "Frames paced at real-time 20 ms. Dumping fast fakes VAD." That is
// the whole reason this file exists rather than a `ws.send(wholeFile)`. Both
// vendors run server-side voice-activity detection; if 2 seconds of speech
// arrives in 40 ms, the VAD sees one impossibly fast utterance, endpoints on
// it immediately, and every latency and barge-in number the run produces is a
// measurement of the harness rather than of the vendor.
//
// The resampler here is the throwaway evidence for the analysis doc's claimed
// 6-10 h resampling tax: OpenAI accepts g711_ulaw natively and needs none of
// this; Gemini Live requires PCM16 at 16 kHz, so every Gemini path pays it.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { decodeMulaw } from "../../../lib/voice/mulaw.js";

export const FIXTURE_DIR = path.resolve("test-audio/caller");

/** Ground truth, from lib/probe/script.js — the text the audio was synthesized FROM. */
export const GROUND_TRUTH = {
  clean_open: "Hi, I'd like to book an appointment.",
  trailing_lead_in: "It's for, uh",
  name_spelling: "My name is Nithin. That's N, I, T, H, I, N.",
  partial_digits: "My number is five five five, two",
  digits_continuation: "three four five six",
  no_terminal_punct: "Next Tuesday afternoon works",
  barge_in: "Actually, could we make it Wednesday instead?",
  clean_close: "That's all, thanks.",
  rep_open: "Hi, I'd like to book an appointment.",
  rep_reason: "I've been having some tooth pain on the left side for about a week.",
  rep_avail_q: "Do you have anything this week?",
  rep_time_q: "Do you have anything Tuesday morning?",
  rep_confirm: "Tuesday at ten works for me.",
  rep_digits: "It's five five five, one two three four.",
  rep_repeat_q: "Sorry, could you repeat that?",
  rep_barge: "Actually, can we make it Wednesday instead?",
  rep_done: "No, that's everything.",
  rep_close: "Thanks, bye.",
};

/** Raw mu-law 8 kHz bytes, no container. */
export function loadUlaw(label) {
  const p = path.join(FIXTURE_DIR, `${label}.ulaw`);
  const buf = fs.readFileSync(p);
  return { label, ulaw: buf, bytes: buf.length, seconds: buf.length / 8000 };
}

/**
 * mu-law 8 kHz -> PCM16 LE 16 kHz, which is the only input format Gemini Live
 * accepts. Linear interpolation on the upsample: this is a throwaway probe
 * harness, and the fixtures are already band-limited 8 kHz telephony audio, so
 * a polyphase filter would buy nothing either vendor's encoder could hear.
 * @param {Buffer} ulaw
 * @returns {Buffer} PCM16 little-endian, 16 kHz
 */
export function ulawToPcm16k(ulaw) {
  const pcm8 = decodeMulaw(ulaw);
  const n = pcm8.length;
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const cur = pcm8[i];
    const next = i + 1 < n ? pcm8[i + 1] : cur;
    out[i * 2] = cur;
    out[i * 2 + 1] = (cur + next) >> 1;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/** Split a buffer into fixed-size frames; a short tail is kept, not dropped. */
export function frames(buf, bytesPerFrame) {
  const out = [];
  for (let i = 0; i < buf.length; i += bytesPerFrame) out.push(buf.subarray(i, i + bytesPerFrame));
  return out;
}

/** 20 ms of audio, in bytes, for the two formats the probes send. */
export const FRAME_BYTES = {
  ulaw8k: 160,   // 8000 samples/s * 1 byte * 0.020
  pcm16k: 640,   // 16000 samples/s * 2 bytes * 0.020
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send frames at wall-clock real time.
 *
 * Deadline-based, not `sleep(20)` in a loop: a naive loop accumulates every
 * scheduling delay, so a 2.0 s fixture takes 2.6 s and drifts differently on
 * every run. Here each frame has an absolute due time, so drift is corrected
 * rather than compounded and two runs are comparable.
 *
 * @param {Buffer[]} frameList
 * @param {(f: Buffer, i: number) => void} send
 * @param {object} [opts]
 * @param {number} [opts.frameMs=20]
 * @param {() => boolean} [opts.stop] - polled each frame; true aborts the send
 * @param {(i:number, elapsedMs:number) => void} [opts.onFrame]
 * @returns {Promise<{sent:number, elapsedMs:number, aborted:boolean}>}
 */
export async function paceFrames(frameList, send, opts = {}) {
  const frameMs = opts.frameMs ?? 20;
  const t0 = Date.now();
  let sent = 0;
  for (let i = 0; i < frameList.length; i++) {
    if (opts.stop?.()) return { sent, elapsedMs: Date.now() - t0, aborted: true };
    const due = t0 + i * frameMs;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    send(frameList[i], i);
    sent++;
    opts.onFrame?.(i, Date.now() - t0);
  }
  return { sent, elapsedMs: Date.now() - t0, aborted: false };
}

/**
 * Trailing silence, as real frames.
 *
 * Both vendors run automatic voice-activity detection, and VAD endpoints on
 * HEARING a pause. A stream that simply stops arriving is not a pause — it is
 * a stall, and the server waits. Twilio never stops: it sends a 20 ms frame
 * every 20 ms for the life of the call whether or not anyone is speaking, so
 * padding here is not a trick to make the vendor respond, it is the harness
 * finally behaving like the transport it stands in for.
 *
 * mu-law silence is 0xFF, not 0x00 — 0x00 decodes to near full-scale negative
 * and would be sent to the vendor as a loud tone.
 * @param {"ulaw8k"|"pcm16k"} format
 * @param {number} ms
 */
export function silenceFrames(format, ms) {
  const bytes = FRAME_BYTES[format];
  const count = Math.ceil(ms / 20);
  const fill = format === "ulaw8k" ? 0xff : 0x00;
  return Array.from({ length: count }, () => Buffer.alloc(bytes, fill));
}

/** Convenience: fixture -> paced 20 ms PCM16/16k frames (Gemini). */
export function geminiFrames(label) {
  const f = loadUlaw(label);
  return { ...f, frames: frames(ulawToPcm16k(f.ulaw), FRAME_BYTES.pcm16k) };
}

/** Convenience: fixture -> paced 20 ms mu-law frames (OpenAI, no resampler). */
export function openaiFrames(label) {
  const f = loadUlaw(label);
  return { ...f, frames: frames(f.ulaw, FRAME_BYTES.ulaw8k) };
}
