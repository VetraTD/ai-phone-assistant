/**
 * THROWAWAY. Spike bridge: Twilio Media Streams <-> Gemini Live.
 *
 * docs/speech-to-speech-handoff.md section 7 step 1. This exists to answer one
 * question that $8.62 of probes could not reach, because no probe had a Twilio
 * leg and therefore no echo path existed at all:
 *
 *     does PSTN echo break speech-to-speech?
 *
 * plus two the owner answers by ear: does it sound acceptable through a
 * 300-3400 Hz channel, and does ~1.4 s per turn feel like anything.
 *
 * DELETE THIS FILE once the verdict is recorded. It has no database, no tenant
 * lookup, no tools, no reducer, no guards and no fallback path. It is not the
 * first commit of the real front-end and must not be grown into one -- the
 * point of a throwaway is that committing to session lifecycle and error
 * handling BEFORE knowing whether the approach survives a phone line is the
 * expensive mistake.
 *
 * lib/voice/resample.js and its tests are the exception: they are real, they
 * are tested, and they survive either verdict.
 *
 * ---------------------------------------------------------------------------
 * Why it reuses inboundVad and audioOut instead of throwaway equivalents
 * ---------------------------------------------------------------------------
 * Section 6 of the handoff says those modules SURVIVE the migration and stay in
 * control under manual activity detection. A spike that stubbed them would be
 * testing code that will never ship, and would answer a question nobody asked.
 *
 * ---------------------------------------------------------------------------
 * Security posture, stated rather than glossed
 * ---------------------------------------------------------------------------
 * The number used for the spike is on Twilio account B, whose auth token GCP
 * does not hold (only account A's `twilio-auth-token` exists in the UK
 * project). Rather than push a second Twilio credential into that project for
 * a service that lives one day, this does NOT validate Twilio signatures. The
 * webhook is gated by a secret path segment instead -- the same shape as
 * `probeUpgradeAllowed` in server.js -- so the URL is the credential.
 *
 * The WebSocket leg keeps the real per-call token from lib/mediaStreamToken.js,
 * which derives its key from MEDIA_STREAM_SECRET when that is set, so it needs
 * no Twilio credential either.
 *
 * What that exposes if the URL leaks: Gemini spend on a service with no data
 * behind it. Bounded by the spend cap and by deleting the service. Recorded in
 * docs/receptionist-backlog.md.
 */
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import express from "express";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

import { createVad } from "../../lib/voice/inboundVad.js";
import { createAudioOut } from "../../lib/voice/audioOut.js";
import { decodeMulaw } from "../../lib/voice/mulaw.js";
import { createDownsampler, mulaw8kToPcm16k, createFramer } from "../../lib/voice/resample.js";
import {
  mintMediaStreamToken,
  verifyMediaStreamToken,
  tokenFromPath,
} from "../../lib/mediaStreamToken.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8080;
const PATH_SECRET = process.env.SPIKE_PATH_SECRET || "";
const VOICE_PATH = "/spike/voice";
const STREAM_PATH = "/spike/stream";

/**
 * "manual" is the section 6 design: the vendor's own voice activity detection
 * is disabled and we decide turn ends ourselves. "auto" hands endpointing back
 * to Gemini and is the COMPARISON arm -- it is expected to be worse on a
 * speakerphone, and measuring how much worse is what makes "manual activity
 * detection is load-bearing" an observation rather than an assumption.
 */
const ARM = process.env.SPIKE_VAD === "auto" ? "auto" : "manual";

const MODEL = process.env.SPIKE_MODEL || "gemini-3.1-flash-live-preview";
const SURFACE = process.env.SPIKE_SURFACE || "aistudio";

/**
 * Silence after the last voiced frame before the caller's turn is called over.
 *
 * A flat number on purpose. lib/transcriptUtils.js classifyHold has tuned
 * 1500/2000 ms rules, but they need TEXT, and the only text available here is
 * Gemini's own inputAudioTranscription -- whose arrival time relative to speech
 * end is exactly what this spike is measuring. Gating turn end on a transcript
 * of unknown lateness would fold that unknown into the "how does it feel"
 * verdict and confound it. So: measure the lag, do not yet depend on it.
 */
const HANGOVER_MS = Number(process.env.SPIKE_HANGOVER_MS) || 1200;

/**
 * Sustained voiced speech required, during our own playback, before it counts
 * as a real interruption rather than echo or a cough. `voicedRunMs` exists
 * because `isActive` alone cannot tell a 200 ms cough from a sentence -- the
 * defect that let a stray transcript cut the assistant off on live calls.
 */
const BARGE_MS = Number(process.env.SPIKE_BARGE_MS) || 300;

/** How much inbound audio to hold back during playback, for the barge flush. */
const LOOKBACK_MS = Number(process.env.SPIKE_LOOKBACK_MS) || 500;

/**
 * Preset voice. The prebuilt Live voices (Puck, Charon, Kore, Fenrir, Aoede,
 * Leda, Orus, Zephyr, ...) are documented by NAME and not by accent, so which
 * of them reads as British is not something this file can assert -- it is
 * something an ear decides. Env-swappable so two can be compared on successive
 * calls for the price of a redeploy.
 */
const VOICE = process.env.SPIKE_VOICE || "Kore";

/**
 * BCP-47 code for synthesis.
 *
 * docs/speech-to-speech-handoff.md section 4 says Gemini Live native audio
 * "does not accept an explicit language code -- it auto-detects". That came
 * from vendor documentation, NOT from measurement, and section 3 is a list of
 * nine confident claims that measurement disproved. So this is set, and whether
 * the model accepts it is RECORDED rather than assumed: if connect fails
 * complaining about it, the session is retried without it and the fact is
 * logged. Either outcome turns a doc claim into a measured one, for free.
 */
const LANGUAGE_CODE = process.env.SPIKE_LANGUAGE_CODE || "en-GB";

const SYSTEM_PROMPT = [
  "You are the receptionist for Brightwork Family Dental, a dental practice in England.",
  "Speak British English in a natural British accent, the way a receptionist in an",
  "English dental practice would: British vocabulary and idiom throughout —",
  "'mobile' not 'cell', 'surgery' or 'practice' not 'office', 'post code' not 'zip',",
  "'appointment' times as 'half past two' or 'ten past three', dates as",
  "'the third of October'. Never use American spellings or Americanisms.",
  "Answer the phone warmly and briefly. Keep replies to one or two sentences.",
  "You have NO tools and NO calendar access in this configuration: if the caller",
  "asks to book, take the details conversationally and say someone will confirm.",
  "Never read out anything that looks like code, JSON or a function name.",
].join(" ");

// ---------------------------------------------------------------------------
// Structured logging. Plain JSON on stdout, which Cloud Run parses into
// structured entries -- so the numbers this spike exists to produce can be read
// back with `gcloud logging read` rather than eyeballed out of a text blob.
// ---------------------------------------------------------------------------

function emit(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ severity: "INFO", event, ...fields })}\n`);
}

function emitError(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ severity: "ERROR", event, ...fields })}\n`);
}

/** Constant-time compare of a supplied path secret against the configured one. */
function pathSecretOk(supplied) {
  if (!PATH_SECRET || !supplied) return false;
  const a = createHash("sha256").update(String(supplied)).digest();
  const b = createHash("sha256").update(String(PATH_SECRET)).digest();
  return timingSafeEqual(a, b);
}

/** RMS of a mu-law frame, in PCM16 units. */
function frameRms(mulawBuf) {
  const s = decodeMulaw(mulawBuf);
  if (!s.length) return 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / s.length);
}

// ---------------------------------------------------------------------------
// Usage accumulation.
//
// Gemini emits one `usageMetadata` message PER TURN, not a running session
// total. This file originally stored `m.usage = msg.usageMetadata`, keeping
// only the last turn -- which is harness defect #1 in the handoff's own section
// 11 list, already found and fixed once in scripts/probes/lib/geminiUsage.js,
// and re-committed here anyway. It under-reports a multi-turn call by roughly
// 3-4x, and a spend cap enforced against the last turn only is not a cap.
//
// Logic copied from scripts/probes/lib/geminiUsage.js rather than imported:
// scripts/probes is not in the Dockerfile COPY list, and adding it would put
// the whole probe suite in the image to reuse thirty lines.
// ---------------------------------------------------------------------------

function emptyUsage() {
  return { text_in: 0, audio_in: 0, text_out: 0, audio_out: 0, cached_in: 0, turns_billed: 0 };
}

function addUsage(acc, u) {
  if (!u) return acc;
  let sawDetail = false;
  for (const d of u.promptTokensDetails || []) {
    sawDetail = true;
    if (d.modality === "AUDIO") acc.audio_in += d.tokenCount || 0;
    else acc.text_in += d.tokenCount || 0;
  }
  for (const d of u.responseTokensDetails || []) {
    sawDetail = true;
    if (d.modality === "AUDIO") acc.audio_out += d.tokenCount || 0;
    else acc.text_out += d.tokenCount || 0;
  }
  for (const d of u.cacheTokensDetails || []) acc.cached_in += d.tokenCount || 0;
  // Fall back to the flat counters when the detail arrays are absent, so a turn
  // is never silently billed as zero.
  if (!sawDetail) {
    acc.text_in += u.promptTokenCount || 0;
    acc.audio_out += u.responseTokenCount || 0;
  }
  acc.turns_billed += 1;
  return acc;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function p50(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

const ratioDb = (a, b) => (a > 0 && b > 0 ? Math.round(20 * Math.log10(a / b) * 10) / 10 : null);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, arm: ARM, model: MODEL, surface: SURFACE });
});

app.post(`${VOICE_PATH}/:secret`, (req, res) => {
  if (!pathSecretOk(req.params.secret)) {
    emitError("spike_voice_refused", { ip: req.ip });
    res.status(403).type("text/plain").send("forbidden");
    return;
  }
  const callSid = req.body?.CallSid || `spike-${randomUUID()}`;
  const token = mintMediaStreamToken(callSid);
  const wsUrl = `wss://${req.get("host")}${STREAM_PATH}/${encodeURIComponent(token)}`;

  emit("spike_call_answered", { callSid, arm: ARM, from: req.body?.From || null });

  res
    .type("text/xml")
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Response><Connect><Stream url="${wsUrl}"/></Connect></Response>`
    );
});

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

function geminiClient() {
  // One branch, verbatim from scripts/probes/lib/geminiSession.js: 3.1 is a
  // preview model that exists only on AI Studio, and section 6 requires that
  // moving it later is a config change rather than a rewrite.
  return SURFACE === "vertex"
    ? new GoogleGenAI({
        vertexai: true,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.VERTEX_LOCATION || "europe-west1",
      })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

async function handleConnection(ws, callSid) {
  const t0 = performance.now();
  const now = () => performance.now();

  let session = null;
  let closed = false;

  // Built on the `start` event, not here: createAudioOut captures streamSid at
  // construction and stamps it into every message it sends, and Twilio only
  // tells us the streamSid when the stream starts. Constructing it early with
  // null would send every media frame with a null streamSid, which Twilio
  // silently ignores -- a call that connects, bills, and is inaudible.
  let audioOut = null;

  const vad = createVad();
  const downsampler = createDownsampler();
  const framer = createFramer(160);

  // ------------------------------------------------------------------
  // Measurement state. These fields ARE the deliverable -- the verdict on echo
  // is the owner's ear, but everything else here is a number.
  // ------------------------------------------------------------------
  const m = {
    turns: 0,
    inRmsPlaying: [],
    inRmsIdle: [],
    outRms: [],
    interrupts: 0,
    // An `interrupted` that OUR vad never corroborated. In the auto arm this is
    // the smoking gun for echo: the vendor heard speech, decided the caller was
    // talking, and cut itself off, while the only thing speaking was us.
    interruptsWithoutLocalBarge: 0,
    activityStartsDuringPlayback: 0,
    firstAudioMs: [],
    replyAfterLastVoiceMs: [],
    transcriptLagMs: [],
    barges: 0,
    usage: emptyUsage(),
    closeReason: null,
    languagePinned: null,
  };

  // ------------------------------------------------------------------
  // Turn state
  // ------------------------------------------------------------------
  let turnOpen = false; // activityStart sent, activityEnd not yet
  let lastVoicedMs = 0;
  let speechEndAt = null; // when we decided the caller stopped
  let awaitingFirstAudio = false;
  let awaitingTranscript = false;
  /** True while a model utterance is in flight, so bursts can be counted once. */
  let modelSpeaking = false;
  /** When our own VAD last corroborated speech during playback. */
  let lastBargeAt = -Infinity;
  /** Frames withheld during our own playback, flushed on a confirmed barge. */
  const lookback = [];
  const LOOKBACK_FRAMES = Math.ceil(LOOKBACK_MS / 20);

  const isPlaying = () => Boolean(audioOut?.isPlaying(150));

  function sendToGemini(mulawFrame) {
    if (!session || closed) return;
    try {
      session.sendRealtimeInput({
        audio: {
          data: mulaw8kToPcm16k(mulawFrame).toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      });
    } catch (err) {
      emitError("spike_send_audio_failed", { callSid, reason: err?.message });
    }
  }

  function signal(name) {
    if (!session || closed || ARM !== "manual") return;
    try {
      session.sendRealtimeInput(name === "start" ? { activityStart: {} } : { activityEnd: {} });
    } catch (err) {
      emitError("spike_activity_signal_failed", { callSid, name, reason: err?.message });
    }
  }

  function openTurn({ duringPlayback = false } = {}) {
    if (turnOpen) return;
    turnOpen = true;
    speechEndAt = null;
    signal("start");
    if (duringPlayback) m.activityStartsDuringPlayback++;
  }

  function closeTurn(atMs) {
    if (!turnOpen) return;
    turnOpen = false;
    speechEndAt = atMs;
    awaitingFirstAudio = true;
    awaitingTranscript = true;
    m.turns++;
    signal("end");
  }

  // ------------------------------------------------------------------
  // Inbound: Twilio -> us -> Gemini
  // ------------------------------------------------------------------
  function onMediaFrame(mulawFrame, atMs) {
    const v = vad.processFrame(mulawFrame, atMs);
    if (v.voiced) lastVoicedMs = atMs;

    const playing = isPlaying();
    (playing ? m.inRmsPlaying : m.inRmsIdle).push(v.rms);

    // Corroboration, recorded in BOTH arms: our own VAD saw sustained voiced
    // speech while we were talking. In the manual arm this triggers the barge
    // below; in the auto arm nothing acts on it, but it is what tells a genuine
    // interruption apart from the vendor cutting itself off on our own echo.
    if (playing && vad.isActive(atMs) && vad.voicedRunMs(atMs) >= BARGE_MS) lastBargeAt = atMs;

    if (ARM === "auto") {
      // Vendor VAD owns endpointing. Forward unconditionally, echo included --
      // which is the point of this arm.
      sendToGemini(mulawFrame);
      // The same turn bookkeeping still runs, with `signal()` a no-op in this
      // arm. Without it the auto arm would produce one latency sample per call
      // and the two arms could not be compared at all -- which is the single
      // thing this arm exists for.
      if (v.voiced && !turnOpen) openTurn();
      if (turnOpen && !vad.isActive(atMs) && atMs - lastVoicedMs >= HANGOVER_MS) closeTurn(atMs);
      return;
    }

    if (playing) {
      // Half-duplex. Our own audio is coming back off the caller's handset and
      // the far-end VAD cannot tell it from the caller, because it sits at the
      // other end of a WebSocket and has never heard our output. So it is not
      // forwarded. Frames are held rather than dropped, so a genuine
      // interruption does not lose its own first syllable.
      lookback.push(mulawFrame);
      while (lookback.length > LOOKBACK_FRAMES) lookback.shift();

      // `!turnOpen` is the latch. The VAD stays active for the whole
      // interrupting utterance, so without it this fires on every frame and
      // re-flushes the lookback dozens of times into one barge.
      if (lastBargeAt === atMs && !turnOpen) {
        m.barges++;
        emit("spike_barge", { callSid, atMs: Math.round(atMs - t0), rms: Math.round(v.rms) });
        audioOut?.clear({ fadeMs: 120 });
        openTurn({ duringPlayback: true });
        for (const held of lookback) sendToGemini(held);
        lookback.length = 0;
      }
      return;
    }

    if (lookback.length) lookback.length = 0;
    sendToGemini(mulawFrame);

    if (v.voiced && !turnOpen) openTurn();
    if (turnOpen && !vad.isActive(atMs) && atMs - lastVoicedMs >= HANGOVER_MS) closeTurn(atMs);
  }

  // ------------------------------------------------------------------
  // Outbound: Gemini -> us -> Twilio
  // ------------------------------------------------------------------
  function onModelAudio(pcm24kBase64) {
    if (!audioOut) return;
    const mulaw = downsampler.process(Buffer.from(pcm24kBase64, "base64"));
    // Only whole 160-byte frames reach audioOut. It pads a short final frame
    // with silence, which is right at the end of an utterance and wrong in the
    // middle of one -- padding every chunk would insert a silence gap per
    // chunk, and Gemini's chunk sizes have no relationship to 160 bytes.
    for (const frame of framer.push(mulaw)) {
      m.outRms.push(frameRms(frame));
      audioOut.enqueue(frame);
    }

    if (!modelSpeaking) {
      modelSpeaking = true;
      // Time from the caller actually falling silent to hearing a reply. This
      // is the number that is comparable ACROSS ARMS and the one that
      // corresponds to what the caller feels, because in the auto arm the
      // vendor's own endpointing delay is inside it and in the manual arm our
      // hangover is.
      if (lastVoicedMs > 0) m.replyAfterLastVoiceMs.push(Math.round(now() - lastVoicedMs));
    }

    if (awaitingFirstAudio && speechEndAt !== null) {
      // Manual arm only in practice: the vendor's response time to our explicit
      // activityEnd, with our own hangover excluded.
      m.firstAudioMs.push(Math.round(now() - speechEndAt));
      awaitingFirstAudio = false;
    }
  }

  // ------------------------------------------------------------------
  // Gemini session
  // ------------------------------------------------------------------
  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
      languageCode: LANGUAGE_CODE,
    },
  };
  if (ARM === "manual") {
    config.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };
  }

  /**
   * Connect, and if the model refuses the language code, connect again without
   * it rather than dropping the call. The retry is the measurement: it records
   * whether native audio accepts a pinned language, which the handoff asserts
   * from vendor docs and nobody has ever checked.
   */
  async function connect(cfg, callbacks) {
    try {
      return { session: await geminiClient().live.connect({ model: MODEL, config: cfg, callbacks }), languagePinned: true };
    } catch (err) {
      const msg = err?.message || String(err);
      if (!/languageCode|language_code|speech_config|speechConfig/i.test(msg)) throw err;
      emit("spike_language_code_rejected", { callSid, languageCode: LANGUAGE_CODE, reason: msg.slice(0, 200) });
      const { speechConfig, ...rest } = cfg;
      const fallback = { ...rest, speechConfig: { voiceConfig: speechConfig.voiceConfig } };
      return { session: await geminiClient().live.connect({ model: MODEL, config: fallback, callbacks }), languagePinned: false };
    }
  }

  try {
    const connected = await connect(config, {
        onmessage: (msg) => {
          if (msg.usageMetadata) addUsage(m.usage, msg.usageMetadata);
          const sc = msg.serverContent;
          if (!sc) return;

          const audioPart = sc.modelTurn?.parts?.find((p) => p.inlineData?.data);
          if (audioPart) onModelAudio(audioPart.inlineData.data);

          if (sc.inputTranscription?.text && awaitingTranscript && speechEndAt !== null) {
            // THE number that decides whether echoGuard and classifyHold can
            // survive into the real front-end. Both need text; if it lands
            // after the moment we must decide, neither can gate anything.
            m.transcriptLagMs.push(Math.round(now() - speechEndAt));
            awaitingTranscript = false;
          }
          // A model utterance has ended, so the next audio chunk starts a new
          // burst. `turnComplete` alone is not the same event -- round 1 proved
          // audio keeps arriving after it -- but for counting bursts either is
          // a sufficient boundary.
          if (sc.generationComplete || sc.turnComplete) modelSpeaking = false;

          if (sc.interrupted) {
            m.interrupts++;
            modelSpeaking = false;
            const corroborated = now() - lastBargeAt < 1500;
            if (!corroborated) m.interruptsWithoutLocalBarge++;
            emit("spike_interrupted", {
              callSid,
              atMs: Math.round(now() - t0),
              // false means the vendor cut itself off while our own VAD saw no
              // sustained caller speech. On a speakerphone that is echo, and it
              // is the defect this whole spike exists to find.
              corroborated_by_local_vad: corroborated,
            });
          }
        },
      onerror: (e) => emitError("spike_gemini_error", { callSid, reason: e?.message || String(e) }),
      onclose: (e) => {
        m.closeReason = e?.reason || null;
      },
    });
    session = connected.session;
    m.languagePinned = connected.languagePinned;
    emit("spike_session_open", {
      callSid,
      arm: ARM,
      voice: VOICE,
      languageCode: LANGUAGE_CODE,
      language_pinned: connected.languagePinned,
    });
  } catch (err) {
    emitError("spike_gemini_connect_failed", { callSid, reason: err?.message });
    try {
      ws.close();
    } catch {
      /* socket already gone */
    }
    return;
  }

  // ------------------------------------------------------------------
  // Twilio socket
  // ------------------------------------------------------------------
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      const streamSid = msg.start?.streamSid || null;
      audioOut = createAudioOut({
        streamSid,
        now,
        sendFrame: (out) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(out));
        },
      });
      emit("spike_stream_start", { callSid, streamSid, arm: ARM });

      // Under manual activity detection the model says nothing until it is told
      // a turn happened, so the greeting has to be kicked off explicitly. Sent
      // here rather than at connect time because there is nowhere to play it
      // until audioOut exists.
      try {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text: "(The caller has just connected. Greet them.)" }] }],
          turnComplete: true,
        });
        speechEndAt = now();
        awaitingFirstAudio = true;
      } catch (err) {
        emitError("spike_greeting_kick_failed", { callSid, reason: err?.message });
      }
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      onMediaFrame(Buffer.from(msg.media.payload, "base64"), now());
      return;
    }

    if (msg.event === "mark" && msg.mark?.name) {
      audioOut?.notifyMarkPlayed(msg.mark.name);
      return;
    }

    if (msg.event === "stop") {
      try {
        ws.close();
      } catch {
        /* socket already gone */
      }
    }
  });

  const finish = () => {
    if (closed) return;
    closed = true;
    audioOut?.stop();
    try {
      session?.close();
    } catch {
      /* session already gone */
    }

    const outMean = mean(m.outRms);
    const inPlaying = mean(m.inRmsPlaying);
    const inIdle = mean(m.inRmsIdle);

    emit("spike_call_summary", {
      callSid,
      arm: ARM,
      model: MODEL,
      voice: VOICE,
      language_code: LANGUAGE_CODE,
      // Whether native audio ACCEPTED a pinned language. The handoff asserts
      // from vendor docs that it does not; this is the first time anything has
      // checked.
      language_pinned: m.languagePinned,
      durationMs: Math.round(now() - t0),
      turns: m.turns,
      // Echo return loss: how far below our own output level the inbound stream
      // sits while we are talking. Large is good. Near 0 dB means our own voice
      // is arriving back at full strength.
      echo_return_loss_db: ratioDb(outMean, inPlaying),
      // MISNAMED, and the first calls proved it: `inIdle` is the inbound level
      // while we are NOT playing, which on a real call is dominated by the
      // CALLER SPEAKING, not by room noise. Measured 2026-09-02: idle RMS 928
      // to 1662 against a playing RMS of 37 to 236. So this is not a noise
      // floor and cannot be used as the "is it echo or is it the room"
      // control it was added to be. Kept under an honest name; the control it
      // was meant to provide does not exist yet.
      inbound_while_idle_db: ratioDb(outMean, inIdle),
      out_rms_mean: Math.round(outMean),
      in_rms_playing_mean: Math.round(inPlaying),
      in_rms_idle_mean: Math.round(inIdle),
      // Comparable across arms: caller falls silent -> caller hears a reply.
      reply_after_last_voice_ms_p50: p50(m.replyAfterLastVoiceMs),
      reply_after_last_voice_ms: m.replyAfterLastVoiceMs,
      // Manual arm: the vendor's response to our explicit activityEnd, with our
      // own hangover excluded.
      first_audio_ms_p50: p50(m.firstAudioMs),
      first_audio_ms: m.firstAudioMs,
      input_transcript_lag_ms_p50: p50(m.transcriptLagMs),
      input_transcript_lag_ms: m.transcriptLagMs,
      interrupted_count: m.interrupts,
      // The echo signature. A non-zero count here means the model cut itself
      // off while nothing our VAD believed was the caller was speaking.
      interrupted_without_local_barge: m.interruptsWithoutLocalBarge,
      activity_starts_during_playback: m.activityStartsDuringPlayback,
      barges: m.barges,
      close_reason: m.closeReason,
      usage: m.usage,
    });
  };

  ws.on("close", finish);
  ws.on("error", (err) => {
    emitError("spike_ws_error", { callSid, reason: err?.message });
    finish();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function boot() {
  if (!PATH_SECRET) {
    throw new Error(
      "SPIKE_PATH_SECRET is not set. It is the only gate on the voice webhook; refusing to start without it."
    );
  }
  if (SURFACE === "aistudio" && !process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set and SPIKE_SURFACE is aistudio.");
  }

  const wss = new WebSocketServer({ noServer: true });
  const server = app.listen(PORT, () => {
    emit("spike_boot", { port: PORT, arm: ARM, model: MODEL, surface: SURFACE, hangoverMs: HANGOVER_MS });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith(`${STREAM_PATH}/`)) {
      socket.destroy();
      return;
    }
    // Refuse before the handshake completes, so a bad token allocates no Gemini
    // session and spends nothing.
    const verdict = verifyMediaStreamToken(tokenFromPath(url.pathname, STREAM_PATH));
    if (!verdict.ok) {
      emitError("spike_upgrade_refused", { reason: verdict.reason });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, verdict.callSid).catch((err) => {
        emitError("spike_connection_failed", { reason: err?.message });
        try {
          ws.close();
        } catch {
          /* socket already gone */
        }
      });
    });
  });

  return server;
}

boot();
