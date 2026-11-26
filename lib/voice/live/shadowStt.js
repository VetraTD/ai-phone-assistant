// lib/voice/live/shadowStt.js
//
// Hammersleys round 4 (2026-11-26), item 6: a Deepgram SHADOW transcript.
//
// On the Live front-end the model is its own ASR, and on 8 kHz phone audio it
// hears UK place names badly (Plaistow -> "Play Store"/"Cresta", Lingfield ->
// "Springfield", 5 a.m. -> "midnight"). Live has no custom vocabulary. Before
// anything ACTS on a second transcript (the dashboard, our guards, a save
// cross-check), measure one: the caller's raw inbound audio goes to a parallel
// Deepgram nova-3 stream with the business's local names as keyterms, and its
// final segments are stored beside the call. Nothing the caller hears changes.
//
// Rules, every one a gate in shadowSttEnabled():
//   - off unless LIVE_SHADOW_STT is "on" or a comma list of business ids;
//   - inbound only; never a healthcare tenant or a hipaa deployment;
//   - only through Deepgram's EU endpoint (DEEPGRAM_REGION=eu);
//   - English calls only (keyterms are English place names).
// The caller's words go to the call row (calls.answers._shadow_stt), never to
// a log line: log lines carry counts only.

import { createDeepgramSttStream, deepgramEnvironment } from "../sttDeepgram.js";
import { isHealthcareTier } from "../../capabilities/intakeSettings.js";

const EU_STREAM = "wss://api.eu.deepgram.com";
/** Deepgram accepts up to 100 keyterms; 50 keeps the request small. */
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_WORDS = 5;
/** Bounds on what one call stores (a 10-minute call is ~150 segments). */
const MAX_SEGMENTS = 400;
const MAX_SEGMENT_CHARS = 500;
const MAX_TOTAL_CHARS = 20_000;
/** How long close() waits for a connect still in flight, and for the last finals. */
const CLOSE_WAIT_MS = 1_500;

/**
 * Is the shadow on for this call? Pure.
 * @param {{env?: object, config?: object, businessId?: string, outbound?: boolean, hipaa?: boolean, language?: string}} f
 * @returns {{on: boolean, reason: string}}
 */
export function shadowSttEnabled({ env = {}, config, businessId, outbound, hipaa, language } = {}) {
  const raw = String(env.LIVE_SHADOW_STT ?? "").trim();
  if (!raw || ["off", "0", "false"].includes(raw.toLowerCase())) return { on: false, reason: "off" };
  // Review M7: nowhere to save it, so never stream it.
  if (!businessId) return { on: false, reason: "no_business" };
  if (raw.toLowerCase() !== "on") {
    // Review M1: ids compared case-insensitively (a uuid typed in capitals).
    const ids = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!ids.includes(String(businessId).toLowerCase())) return { on: false, reason: "not_listed" };
  }
  if (outbound) return { on: false, reason: "outbound" };
  if (hipaa || isHealthcareTier(config)) return { on: false, reason: "healthcare" };
  if (!String(env.DEEPGRAM_API_KEY ?? "").trim()) return { on: false, reason: "no_key" };
  if (!String(deepgramEnvironment(env).production || "").startsWith(EU_STREAM)) return { on: false, reason: "not_eu" };
  if (!/^en(-|$)/i.test(String(language || ""))) return { on: false, reason: "language" };
  return { on: true, reason: "on" };
}

/**
 * The words Deepgram should listen for: the business name, then each item of
 * a general_info line that begins "Local names" (the same list the receptionist
 * reads, so one config line serves both). "label: item" prefixes inside the
 * line ("stations: Lingfield") are dropped. Deduped, capped.
 * @param {object} config
 * @returns {string[]}
 */
export function shadowKeyterms(config) {
  const terms = [];
  const add = (t) => {
    const x = String(t || "").replace(/\s+/g, " ").replace(/[.]+$/, "").trim();
    if (!x || x.split(" ").length > MAX_KEYTERM_WORDS || terms.length >= MAX_KEYTERMS) return;
    if (!terms.some((y) => y.toLowerCase() === x.toLowerCase())) terms.push(x);
  };
  add(config?.businessName);
  // Review M3: "Local names:", "- Local names: ...", "LOCAL NAMES – ...".
  const line = String(config?.generalInfo || "")
    .split(/\r?\n/)
    .find((l) => /^\s*[-*\u2022]?\s*local names\b/i.test(l));
  const head = line ? line.match(/^\s*[-*\u2022]?\s*local names\b[^:\u2013\u2014]*[:\u2013\u2014]/i) : null;
  if (head) {
    for (const part of line.slice(head[0].length).split(/[,;/]|\band\b/i)) {
      add(part.includes(":") ? part.slice(part.lastIndexOf(":") + 1) : part);
    }
  }
  return terms;
}

/**
 * One call's shadow stream. push() is synchronous, never throws and never
 * awaits: it is called on the media path for every inbound frame. Frames that
 * arrive while the stream is still connecting are dropped (counted).
 *
 * @param {object} o
 * @param {string} o.callSid
 * @param {string} o.language
 * @param {string[]} o.keyterms
 * @param {Function} [o.connect] - createDeepgramSttStream, injectable
 * @param {{info: Function, error: Function}} o.log
 * @param {() => number} [o.now]
 * @param {number} [o.closeWaitMs]
 */
export function createShadowStt({ callSid, language, keyterms, connect = createDeepgramSttStream, log, now = Date.now, closeWaitMs = CLOSE_WAIT_MS }) {
  const startedAt = now();
  const segments = [];
  let totalChars = 0;
  let stream = null;
  let error = null;
  let ending = false;
  let done = false;
  let framesSent = 0;
  let framesDropped = 0;
  let result = null;

  const onFinal = (text, meta) => {
    if (done || typeof text !== "string" || !text.trim()) return;
    if (segments.length >= MAX_SEGMENTS || totalChars >= MAX_TOTAL_CHARS) return;
    const t = text.trim().slice(0, MAX_SEGMENT_CHARS);
    totalChars += t.length;
    const conf = Number.isFinite(meta?.confidence) ? Math.round(meta.confidence * 100) / 100 : null;
    segments.push({ t_ms: Math.max(0, Math.round(now() - startedAt)), text: t, conf });
  };

  const ready = Promise.resolve()
    .then(() =>
      connect({
        language,
        keyterms,
        callSid,
        onFinal,
        onError: (err) => {
          error = err?.code || "stream_error";
        },
      })
    )
    .then((s) => {
      if (ending) {
        try {
          s?.close?.();
        } catch {
          // already gone
        }
        return;
      }
      stream = s;
    })
    .catch(() => {
      error = "connect_failed";
    });

  return {
    push(frame) {
      if (ending) return;
      if (!stream) {
        framesDropped += 1;
        return;
      }
      try {
        stream.sendAudio(frame);
        framesSent += 1;
      } catch {
        // The shadow never touches the call.
      }
    },
    /** End the stream, keep its last finals, and report. Never throws. */
    async close() {
      if (result) return result;
      if (ending) return ready.then(() => result);
      ending = true;
      const timeout = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
      await Promise.race([ready, timeout(closeWaitMs)]);
      const s = stream;
      stream = null;
      try {
        if (s?.finalize) await Promise.race([s.finalize({ timeoutMs: closeWaitMs }), timeout(closeWaitMs + 200)]);
        else s?.close?.();
      } catch {
        error = error || "close_failed";
      }
      done = true;
      result = { segments, frames_sent: framesSent, frames_dropped: framesDropped, error };
      // Counts only: the words are on the call row, never in a log line.
      log?.info?.("live_shadow_stt", {
        callSid,
        segments: segments.length,
        chars: totalChars,
        frames_sent: framesSent,
        frames_dropped: framesDropped,
        ms: Math.round(now() - startedAt),
        error,
      });
      return result;
    },
  };
}
