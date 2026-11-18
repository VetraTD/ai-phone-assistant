// ---------------------------------------------------------------------------
// OpenAI Realtime session wrapper, shared by L2 and L3.
//
// Raw `ws` rather than an SDK, so every event is timestamped on arrival and
// nothing is buffered or reordered by a convenience layer. The latency numbers
// are the whole point of the run.
//
// NOTE the format: `audio/pcmu` in AND out — G.711 mu-law, 8 kHz, exactly what
// Twilio speaks. This is itself evidence for the analysis doc's integration-tax
// claim: the Gemini path in lib/audio.js has to decode and upsample every frame
// to PCM16/16k, and this path sends the fixture bytes untouched.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import WebSocket from "ws";
import { openaiToolResponseItem } from "./tools.js";

export function apiKey() {
  const line = fs.readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY missing from .env");
  return line.slice("OPENAI_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

/**
 * Open a Realtime session and install an event recorder.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.instructions - the REAL system prompt
 * @param {Array} opts.tools - the REAL tool declarations, Realtime shape
 * @param {object} opts.turnDetection - server_vad or semantic_vad config
 * @param {boolean} [opts.answerTools=true] - auto-answer function calls
 */
export async function openSession(opts) {
  const { model, instructions, tools, turnDetection, answerTools = true } = opts;
  const state = {
    events: [],
    firstAudioAt: null, lastAudioAt: null,
    speechStartedAt: null, speechStoppedAt: null,
    responseCreatedAt: null, responseDoneAt: null,
    audioChunks: 0, audioBytes: 0,
    inputTranscript: "", outputTranscript: "",
    turnToolCalls: [], usage: null,
    cancelled: 0, error: null, closed: false, sessionUpdated: false,
  };

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });

  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("realtime open timeout")), 20000);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
    ws.once("unexpected-response", (_r, res) => {
      clearTimeout(t);
      let body = ""; res.on("data", (d) => (body += d));
      res.on("end", () => reject(new Error(`HTTP ${res.statusCode} — ${body.slice(0, 300)}`)));
    });
  });

  ws.on("message", (raw) => {
    const at = Date.now();
    let e;
    try { e = JSON.parse(raw.toString()); } catch { return; }
    state.events.push({ at, t: e.type });

    switch (e.type) {
      case "session.updated": state.sessionUpdated = true; break;
      case "input_audio_buffer.speech_started": state.speechStartedAt = at; break;
      case "input_audio_buffer.speech_stopped": state.speechStoppedAt = at; break;
      case "response.created": if (state.responseCreatedAt === null) state.responseCreatedAt = at; break;
      case "response.output_audio.delta":
      case "response.audio.delta": {
        state.audioChunks++;
        state.audioBytes += Buffer.from(e.delta || "", "base64").length;
        if (state.firstAudioAt === null) state.firstAudioAt = at;
        state.lastAudioAt = at;
        break;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        state.outputTranscript += e.delta || "";
        break;
      case "conversation.item.input_audio_transcription.completed":
        state.inputTranscript += (e.transcript || "") + " ";
        break;
      case "response.function_call_arguments.done": {
        state.turnToolCalls.push(e.name);
        if (answerTools) {
          // Answer immediately and ask the model to continue. Until we do, it
          // is blocked and every millisecond lands inside model_leg_ms.
          send(openaiToolResponseItem({ call_id: e.call_id, name: e.name }));
          send({ type: "response.create" });
        }
        break;
      }
      case "response.done": {
        state.responseDoneAt = at;
        const u = e.response?.usage;
        if (u) state.usage = mergeUsage(state.usage, u);
        if (e.response?.status === "cancelled") state.cancelled++;
        break;
      }
      case "error":
        state.error = `${e.error?.code}: ${e.error?.message}`;
        state.events.push({ at, t: "error", msg: state.error });
        break;
    }
  });
  ws.on("error", (e) => { state.error = e?.message || String(e); });
  ws.on("close", () => { state.closed = true; });

  send({
    type: "session.update",
    session: {
      type: "realtime",
      instructions,
      tools,
      tool_choice: "auto",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: "whisper-1" },
          turn_detection: turnDetection,
        },
        output: { format: { type: "audio/pcmu" }, voice: "marin" },
      },
    },
  });

  return { ws, state, send, close: () => { try { ws.close(); } catch {} } };
}

/**
 * Realtime reports usage per response, so a multi-turn session emits several.
 * Summed, not overwritten — taking only the last would bill a 5-turn call as
 * if it were 1 turn and would make every cost figure in the report wrong.
 */
function mergeUsage(prev, u) {
  const add = (a, b) => (a || 0) + (b || 0);
  const cur = prev || {};
  const inDet = u.input_token_details || {};
  const outDet = u.output_token_details || {};
  const cached = inDet.cached_tokens_details || {};
  return {
    text_in: add(cur.text_in, inDet.text_tokens),
    audio_in: add(cur.audio_in, inDet.audio_tokens),
    cached_text_in: add(cur.cached_text_in, cached.text_tokens),
    cached_audio_in: add(cur.cached_audio_in, cached.audio_tokens),
    text_out: add(cur.text_out, outDet.text_tokens),
    audio_out: add(cur.audio_out, outDet.audio_tokens),
    responses: add(cur.responses, 1),
  };
}

/**
 * Cached tokens are reported INSIDE the input totals, so charging both would
 * double-bill. Subtract them out and price the two buckets at their own rates.
 */
export function billableUsage(u) {
  if (!u) return { text_in: 0, audio_in: 0, text_out: 0, audio_out: 0 };
  return {
    text_in: Math.max(0, (u.text_in || 0) - (u.cached_text_in || 0)),
    audio_in: Math.max(0, (u.audio_in || 0) - (u.cached_audio_in || 0)),
    cached_text_in: u.cached_text_in || 0,
    cached_audio_in: u.cached_audio_in || 0,
    text_out: u.text_out || 0,
    audio_out: u.audio_out || 0,
  };
}

export const appendAudio = (send, frame) =>
  send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
