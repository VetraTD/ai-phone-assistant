import { performance } from "node:perf_hooks";
import { log } from "../logger.js";
import { createProbeRun, FRAME_BYTES } from "./probeRun.js";

// ---------------------------------------------------------------------------
// Twilio Media Streams handler for the ORIGINATING leg of a probe call.
//
// The assistant's own number answers normally on the other leg; this side is
// the scripted caller. Twilio bridges the two, so every frame crosses the real
// telephony path in both directions — which is the entire point. A local
// simulation would exclude exactly the transit time we are trying to measure.
//
// Results are collected in-process and read back by scripts/latency-probe.js
// through the same token-gated debug endpoint as the server-side stats.
// ---------------------------------------------------------------------------

/** Frame cadence. One 160-byte mu-law frame per 20ms is realtime at 8kHz. */
const TICK_MS = 20;

/** Safety net: no probe call should ever outlive the script by this much. */
const MAX_CALL_MS = 180_000;

/** Completed probe calls this process has run, newest last. */
const _runs = [];

// ---------------------------------------------------------------------------
// The caller audio is UPLOADED, not read from disk.
//
// This handler runs on the deployed server; the audio is synthesized on the
// operator's machine (scripts/latency-probe.js --synth). Reading it from the
// server's filesystem would mean either committing audio to the repo or
// depending on Google TTS being configured on the deployed box — and if the
// two ends ever synthesized separately, two runs could differ because the
// audio differed rather than because the system did. Uploading the exact bytes
// before each run removes that whole class of doubt.
// ---------------------------------------------------------------------------

/** @type {Array<{label: string, mulaw: Buffer, bargeInAfterMs?: number}>|null} */
let _script = null;

/**
 * Install the caller script for the upcoming run.
 * @param {Array<{label: string, audioBase64: string, bargeInAfterMs?: number}>} lines
 * @returns {{lines: number, seconds: number}}
 */
export function setProbeScript(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("script must be a non-empty array");
  const parsed = lines.map((line) => {
    if (!line?.label || !line?.audioBase64) throw new Error("each line needs a label and audioBase64");
    const mulaw = Buffer.from(line.audioBase64, "base64");
    if (!mulaw.length) throw new Error(`line "${line.label}" decoded to no audio`);
    return {
      label: String(line.label),
      mulaw,
      ...(line.bargeInAfterMs ? { bargeInAfterMs: Number(line.bargeInAfterMs) } : {}),
    };
  });
  _script = parsed;
  const bytes = parsed.reduce((n, l) => n + l.mulaw.length, 0);
  return { lines: parsed.length, seconds: Number((bytes / 8000).toFixed(2)) };
}

/** @returns {boolean} whether a script has been uploaded */
export function hasProbeScript() {
  return Array.isArray(_script) && _script.length > 0;
}

/** @returns {object[]} turn records from every completed probe call */
export function getProbeResults() {
  return _runs.slice();
}

/** Discard collected probe results. Called before a fresh measurement run. */
export function clearProbeResults() {
  _runs.length = 0;
}

/**
 * Handle one probe-leg Media Streams connection.
 *
 * @param {import("ws").WebSocket} ws
 * @param {object} [opts]
 * @param {object[]} [opts.script] - override the default script (tests)
 * @param {function(): number} [opts.now]
 */
export function handleProbeConnection(ws, { script, now = () => performance.now() } = {}) {
  let streamSid = null;
  let run = null;
  let timer = null;
  let callSid = null;
  const startedAt = now();

  function finish(reason) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (run) {
      const turns = run.getTurns();
      run.stop();
      _runs.push({ callSid, streamSid, reason, turns });
      log.info("probe_call_finished", {
        callSid,
        reason,
        turns: turns.length,
        answered: turns.filter((t) => t.probeV2vMs !== null).length,
      });
      run = null;
    }
    try {
      if (ws.readyState === 1) ws.close();
    } catch {
      // socket already gone
    }
  }

  function startRun() {
    const active = script ?? _script;
    if (!active) {
      // Better to hang up immediately than to hold a billable call open with
      // nothing to say into it.
      log.error("probe_no_script", { callSid, reason: "no script uploaded" });
      return finish("no_script");
    }
    run = createProbeRun({
      script: active,
      now,
      sendFrame: (frame) => {
        if (ws.readyState !== 1) return;
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: Buffer.from(frame).toString("base64") },
          })
        );
      },
    });

    timer = setInterval(() => {
      try {
        if (!run) return;
        // Backstop against a call that never reaches the end of the script —
        // an unanswered leg would otherwise hold the line open and bill.
        if (now() - startedAt > MAX_CALL_MS) return finish("max_duration");
        run.tick();
        if (run.isDone()) finish("script_complete");
      } catch (err) {
        log.error("probe_tick_error", { callSid, reason: err?.message });
        finish("tick_error");
      }
    }, TICK_MS);
    timer.unref?.();
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid ?? msg.streamSid ?? null;
        callSid = msg.start?.callSid ?? null;
        log.info("probe_call_started", { callSid, streamSid });
        startRun();
        break;

      case "media": {
        if (!run) return;
        const payload = msg.media?.payload;
        if (!payload) return;
        const buf = Buffer.from(payload, "base64");
        // Twilio sends 160-byte frames; anything else is still fed through so
        // the VAD sees all the audio rather than silently dropping a partial.
        run.handleInbound(buf.length === FRAME_BYTES ? buf : buf);
        break;
      }

      case "stop":
        finish("twilio_stop");
        break;
    }
  });

  ws.on("close", () => finish("ws_closed"));
  ws.on("error", (err) => {
    log.error("probe_ws_error", { callSid, reason: err?.message });
    finish("ws_error");
  });
}
