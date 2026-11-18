// ---------------------------------------------------------------------------
// GPT-Live-1 session wrapper.
//
// NOT a fork of lib/openai.js. The Realtime wrapper next door cannot be adapted
// because three things it is built on do not exist here:
//
//   - no `response.done`      -- nothing says a reply finished
//   - no `output_audio.done`  -- nothing says the audio finished playing
//   - no manual audio commit  -- you never tell it the caller stopped
//
// Those absences are the product, not an oversight: GPT-Live is full duplex, so
// "whose turn is it" is not a question the protocol asks. Every timing below is
// therefore derived from ARRIVAL TIMES and AUDIO DURATIONS rather than from
// lifecycle events, which is why this uses raw `ws` and timestamps every frame
// on arrival instead of using the SDK.
//
// Protocol, confirmed against the generated SDK types on 2026-09-14/15:
//
//   wss://api.openai.com/v1/live/sessions      (no query parameters at all)
//   -> {type:"session.start", session:{model, audio:{format:{type:"audio/pcmu",rate:8000}}, ...}}
//   <- {type:"session.started", session:{...resolved...}}
//   -> {type:"session.input_audio.append", audio:"<base64>"}        (no ack)
//   <- {type:"session.output_audio.delta", delta:"<base64>"}
//   <- {type:"session.input_transcript.delta",  delta, start_ms, end_ms}
//   <- {type:"session.output_transcript.delta", delta, start_ms, end_ms}
//   <- {type:"session.delegation.created", delegation:{id,target}, offset_ms}
//   <- {type:"response.event", delegation_id, event:{...nested Responses...}}
//   <- {type:"session.usage.updated", usage:{seconds}}
//   -> {type:"session.close"}  <- {type:"session.closed"}
//
// The session config carries `model`; it is explicitly NOT a query parameter.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

export const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
export const MODEL = "gpt-live-1";

/** PLAN-gptlive.md kill switch 1. It bills per wall-clock second. */
export const HARD_SESSION_MS = 120_000;

export function apiKey() {
  const line = fs.readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY missing from .env");
  return line.slice("OPENAI_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

/** mu-law byte -> signed 16-bit sample. Used only to write listenable WAVs. */
function mulawDecodeByte(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/**
 * Write mu-law bytes out as an 8 kHz PCM16 WAV so a human can play them.
 *
 * The owner judges voices by ear and rejected one on a real call that had
 * passed on file, so saved audio is worth the four lines it costs. It is free:
 * these bytes arrive whether or not we keep them.
 */
export function writeUlawWav(ulaw, outPath) {
  const pcm = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) pcm.writeInt16LE(mulawDecodeByte(ulaw[i]), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);      // PCM
  header.writeUInt16LE(1, 22);      // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);  // byte rate
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
  return outPath;
}

/**
 * Open a Live session and install an event recorder.
 *
 * @param {object} opts
 * @param {string} opts.label                 - used for raw/ and audio/ filenames
 * @param {string} opts.instructions          - FRONTEND instructions (voice layer)
 * @param {object} [opts.delegation]          - omit for client delegation; {type:"responses",responses:{...}} for arm R
 * @param {string} [opts.voice="marin"]
 * @param {Array}  [opts.input]               - startup text history, <=128 msgs / 8192 tokens
 * @param {number} [opts.hardMs=HARD_SESSION_MS]
 */
export async function openSession(opts) {
  const {
    label, instructions, delegation, voice = "marin", input,
    hardMs = HARD_SESSION_MS,
  } = opts;

  const state = {
    label,
    events: [],                 // every server event, timestamped on arrival
    inputTranscript: [],        // {delta,start_ms,end_ms,at}
    outputTranscript: [],       // {delta,start_ms,end_ms,at}
    audioOut: [],               // {bytes,at}
    audioOutBuf: [],            // Buffers, for the WAV
    delegations: [],            // {id,target,offset_ms,at}
    responseEvents: [],         // unwrapped nested Responses events
    toolCalls: [],              // {call_id,name,arguments,at}
    usageSeconds: null,         // last session.usage.updated (a TOTAL, never summed)
    contextRatio: null,
    errors: [],
    info: [],
    startedAt: null,
    resolvedSession: null,
    closeReason: null,
    lastCallerFrameAt: null,
    t0: Date.now(),
    aborted: false,
    abortReason: null,
  };

  const ws = new WebSocket(LIVE_URL, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    followRedirects: false,
  });

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  // Kill switch 1. Fires regardless of what the caller is doing.
  const hardTimer = setTimeout(() => {
    state.aborted = true;
    state.abortReason = `hard abort at ${hardMs}ms`;
    try { ws.terminate(); } catch {}
  }, hardMs);

  const waiters = [];
  function waitFor(predicate, timeoutMs, whatFor) {
    return new Promise((resolve, reject) => {
      const existing = state.events.find(predicate);
      if (existing) return resolve(existing);
      const t = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${whatFor}`));
      }, timeoutMs);
      const entry = { predicate, resolve, reject, timer: t };
      waiters.push(entry);
    });
  }

  ws.on("message", (raw) => {
    const at = Date.now();
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    const rec = { at, sinceStart: at - state.t0, ...ev };

    // Audio is huge; keep the bytes out of the event log but record the shape.
    if (ev.type === "session.output_audio.delta") {
      const buf = Buffer.from(ev.delta || "", "base64");
      state.audioOut.push({ bytes: buf.length, at, sinceStart: at - state.t0 });
      state.audioOutBuf.push(buf);
      state.events.push({ at, sinceStart: at - state.t0, type: ev.type, bytes: buf.length });
    } else {
      state.events.push(rec);
    }

    switch (ev.type) {
      case "session.started":
        state.startedAt = at;
        state.resolvedSession = ev.session;
        break;
      case "session.input_transcript.delta":
        state.inputTranscript.push({ delta: ev.delta, start_ms: ev.start_ms, end_ms: ev.end_ms, at });
        break;
      case "session.output_transcript.delta":
        state.outputTranscript.push({ delta: ev.delta, start_ms: ev.start_ms, end_ms: ev.end_ms, at });
        break;
      case "session.delegation.created":
        state.delegations.push({
          id: ev.delegation?.id, target: ev.delegation?.target,
          response_id: ev.delegation?.response_id, offset_ms: ev.offset_ms, at,
        });
        break;
      case "response.event": {
        // The nested Responses stream. Dispatch on the INNER type; the outer
        // delegation_id is what correlates it back to the Live delegation.
        const inner = ev.event || {};
        state.responseEvents.push({ at, delegation_id: ev.delegation_id, innerType: inner.type, inner });
        if (inner.type === "response.output_item.done" && inner.item?.type === "function_call") {
          state.toolCalls.push({
            call_id: inner.item.call_id, name: inner.item.name,
            arguments: inner.item.arguments, delegation_id: ev.delegation_id, at,
          });
        }
        break;
      }
      case "session.usage.updated":
        // Docstring: "Values are totals for the session, not increments to sum".
        state.usageSeconds = ev.usage?.seconds ?? state.usageSeconds;
        state.contextRatio = ev.context_window?.usage_ratio ?? state.contextRatio;
        break;
      case "session.closed":
        state.closeReason = ev.reason ?? ev.close_reason ?? "closed";
        break;
      case "error":
        state.errors.push({ at, error: ev.error });
        break;
      case "info":
        state.info.push({ at, info: ev.info ?? ev });
        break;
    }

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(rec)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(rec);
        waiters.splice(i, 1);
      }
    }
  });

  ws.on("error", (err) => { state.errors.push({ at: Date.now(), error: { message: String(err) } }); });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket open timeout (15s)")), 15_000);
    ws.on("open", () => { clearTimeout(t); resolve(); });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(t);
      reject(new Error(`handshake rejected: HTTP ${res.statusCode} ${res.statusMessage}`));
    });
    ws.on("close", (code, reason) => {
      clearTimeout(t);
      reject(new Error(`socket closed during open: ${code} ${reason}`));
    });
  });

  const sessionConfig = {
    model: MODEL,
    audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice } },
  };
  if (instructions) sessionConfig.instructions = instructions;
  if (delegation) sessionConfig.delegation = delegation;
  if (input) sessionConfig.input = input;

  send({ type: "session.start", event_id: "start_1", session: sessionConfig });
  await waitFor((e) => e.type === "session.started", 30_000, "session.started");

  return {
    state,
    ws,
    raw: send,

    /** One 20 ms mu-law frame. No acknowledgement exists for these. */
    sendAudio(ulawFrame) {
      state.lastCallerFrameAt = Date.now();
      send({ type: "session.input_audio.append", audio: Buffer.from(ulawFrame).toString("base64") });
    },

    /** Speakable context. Spoken IN THE MODEL'S OWN WORDS -- that is what G5 measures. */
    commentary(content, delegationId = null, eventId) {
      send({ type: "session.commentary.append", event_id: eventId, content, delegation_id: delegationId });
    },

    /** Silent context; never spoken. */
    thinking(content, delegationId = null, eventId) {
      send({ type: "session.thinking.append", event_id: eventId, content, delegation_id: delegationId });
    },

    /** Arm R only: hand a tool result to the Responses backend, then let it continue. */
    toolResult(callId, output) {
      send({
        type: "response.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
      });
      send({ type: "response.create" });
    },

    waitFor,

    /**
     * Close. Called from a `finally` by every caller, because an un-closed
     * socket bills per second until something else notices.
     */
    async close() {
      clearTimeout(hardTimer);
      try {
        send({ type: "session.close" });
        await Promise.race([
          waitFor((e) => e.type === "session.closed", 3_000, "session.closed"),
          new Promise((r) => setTimeout(r, 3_000)),
        ]);
      } catch {}
      try { ws.close(); } catch {}
      setTimeout(() => { try { ws.terminate(); } catch {} }, 500).unref?.();
      state.wallClockSeconds = (Date.now() - state.t0) / 1000;
      return state;
    },
  };
}

/**
 * Reconstruct WHEN THE MODEL WAS ACTUALLY SPEAKING, from output audio energy.
 *
 * THIS IS THE THIRD INSTRUMENT DEFECT THIS ROUND AND THE MOST DANGEROUS ONE.
 * Detection was originally "did output audio deltas arrive while the caller was
 * speaking", which scored 10 of 10 takes as cut-ins and would have published
 * the headline "GPT-Live interrupts worse than Gemini".
 *
 * It is wrong because full duplex means the output channel is ALWAYS ON. The
 * model streams audio continuously and sends silence when it has nothing to
 * say, exactly as Twilio does inbound -- measured here as 218 deltas with no
 * gap over 400 ms, 21.8 seconds of audio carrying 2 seconds of speech. Counting
 * deltas counts silence.
 *
 * So speech is detected by ENERGY, the same way inboundVad already does it for
 * the caller leg. The stream is contiguous from the first delta, so a byte's
 * position gives its time directly: mu-law 8 kHz is 8 bytes per millisecond.
 *
 * @returns {{runs: Array<{startAt:number,endAt:number,ms:number,peakRms:number}>, floor:number, frames:number}}
 */
export function outputSpeechRuns(state, { rmsFloor = 500, frameMs = 20, hangoverMs = 240 } = {}) {
  if (!state.audioOutBuf?.length || !state.audioOut?.length) return { runs: [], floor: rmsFloor, frames: 0 };
  const buf = Buffer.concat(state.audioOutBuf);
  const originMs = state.audioOut[0].at;
  const bytesPerFrame = 8 * frameMs; // 8 bytes/ms at 8 kHz mu-law
  const frames = Math.floor(buf.length / bytesPerFrame);

  const loud = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * bytesPerFrame;
    for (let i = 0; i < bytesPerFrame; i++) {
      const s = mulawDecodeByte(buf[off + i]);
      sum += s * s;
    }
    loud.push(Math.sqrt(sum / bytesPerFrame));
  }

  const runs = [];
  let cur = null;
  let quietFrames = 0;
  const hangoverFrames = Math.ceil(hangoverMs / frameMs);
  for (let f = 0; f < frames; f++) {
    if (loud[f] > rmsFloor) {
      if (!cur) cur = { startFrame: f, endFrame: f, peakRms: loud[f] };
      cur.endFrame = f;
      cur.peakRms = Math.max(cur.peakRms, loud[f]);
      quietFrames = 0;
    } else if (cur) {
      quietFrames++;
      if (quietFrames >= hangoverFrames) { runs.push(cur); cur = null; }
    }
  }
  if (cur) runs.push(cur);

  return {
    floor: rmsFloor,
    frames,
    rmsPercentiles: percentiles(loud),
    runs: runs.map((r) => ({
      startAt: originMs + r.startFrame * frameMs,
      endAt: originMs + (r.endFrame + 1) * frameMs,
      ms: (r.endFrame - r.startFrame + 1) * frameMs,
      peakRms: Math.round(r.peakRms),
    })),
  };
}

function percentiles(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0);
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: Math.round(s.at(-1) ?? 0) };
}

/**
 * Wait until the model has stopped SPEAKING for `quietMs`.
 *
 * Energy-based for the reason above: waiting for deltas to stop would wait
 * forever, because on a full-duplex stream they never do.
 */
export async function waitForSpeechQuiet(state, { quietMs = 900, timeoutMs = 20_000, rmsFloor = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let sawSpeech = false;
  while (Date.now() < deadline) {
    const { runs } = outputSpeechRuns(state, { rmsFloor });
    if (runs.length) {
      sawSpeech = true;
      const lastEnd = runs.at(-1).endAt;
      // endAt is derived from the audio timeline, which can run ahead of wall
      // clock because the server streams faster than real time. Compare against
      // the arrival time of the last delta instead.
      const lastArrival = state.audioOut.at(-1).at;
      if (Date.now() - lastArrival >= 400 || Date.now() - lastEnd >= quietMs) {
        return { quietAt: Date.now(), runs, sawSpeech, timedOut: false };
      }
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return { quietAt: Date.now(), runs: outputSpeechRuns(state, { rmsFloor }).runs, sawSpeech, timedOut: true };
}

/**
 * Wait until the model has stopped producing audio for `quietMs`.
 *
 * EXISTS BECAUSE OF A HARNESS DEFECT G3 FOUND. The first version of every gate
 * opened a session and immediately started playing caller audio, so the model's
 * GREETING collided with a caller who had not waited for it. The measurement
 * then said "spoke 1,470 ms before the caller finished" on all ten takes, at an
 * identical 0.61 s offset into two different fixtures -- the tell that it was
 * the greeting firing on a timer, not a response to anything said.
 *
 * A real call greets first and the caller waits. So do we now.
 *
 * Audio-based, deliberately: the output TRANSCRIPT lags the output AUDIO by
 * 2.6-3.0 s (measured, this round), so anything that waits on text would wait
 * through most of the reply it is trying to detect the end of.
 */
export async function waitForAudioQuiet(state, { quietMs = 900, timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // First wait for audio to START, otherwise "quiet" is trivially true.
  while (state.audioOut.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  while (Date.now() < deadline) {
    const last = state.audioOut[state.audioOut.length - 1];
    if (last && Date.now() - last.at >= quietMs) {
      return { quietAt: Date.now(), lastAudioAt: last.at, deltas: state.audioOut.length, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { quietAt: Date.now(), lastAudioAt: state.audioOut.at(-1)?.at ?? null, deltas: state.audioOut.length, timedOut: true };
}

// --- derived measures -------------------------------------------------------

/**
 * Group output audio into contiguous runs.
 *
 * A "run" is consecutive deltas arriving less than `gapMs` apart. Its DURATION
 * is computed from byte count (mu-law 8 kHz: 1 byte = 1 sample = 0.125 ms), not
 * from arrival span -- the server can stream a two-second reply in 300 ms of
 * wall clock, and scoring arrival span would call that a backchannel.
 */
export function audioRuns(state, gapMs = 500) {
  const runs = [];
  let cur = null;
  for (const d of state.audioOut) {
    if (!cur || d.at - cur.lastAt > gapMs) {
      cur = { startAt: d.at, lastAt: d.at, bytes: 0, deltas: 0 };
      runs.push(cur);
    }
    cur.lastAt = d.at;
    cur.bytes += d.bytes;
    cur.deltas += 1;
  }
  return runs.map((r) => ({ ...r, audioMs: (r.bytes / 8000) * 1000 }));
}

/** Concatenated model speech, as text. */
export function outputText(state) {
  return state.outputTranscript.map((t) => t.delta).join("");
}

/** Concatenated caller transcript, as text. */
export function inputText(state) {
  return state.inputTranscript.map((t) => t.delta).join("");
}

/**
 * Segment the caller transcript into turns using ONLY the timestamps, because
 * OpenAI states these events "do not define complete turns or include a
 * transcript-done event". This function IS the G2b instrument.
 */
export function segmentTurns(state, gapMs = 500) {
  const turns = [];
  let cur = null;
  for (const f of state.inputTranscript) {
    if (!cur || (f.start_ms - cur.end_ms) >= gapMs) {
      cur = { start_ms: f.start_ms, end_ms: f.end_ms, text: f.delta };
      turns.push(cur);
    } else {
      cur.end_ms = Math.max(cur.end_ms, f.end_ms);
      cur.text += f.delta;
    }
  }
  return turns;
}

export function saveRaw(state, dir = "scripts/probes/raw") {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `gptlive-${state.label}.json`);
  const { audioOutBuf, ...rest } = state;
  fs.writeFileSync(out, JSON.stringify(rest, null, 2) + "\n");
  return out;
}

export function saveAudio(state, dir = "scripts/probes/audio") {
  if (!state.audioOutBuf.length) return null;
  return writeUlawWav(Buffer.concat(state.audioOutBuf), path.join(dir, `${state.label}.wav`));
}
