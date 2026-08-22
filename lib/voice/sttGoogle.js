import { performance } from "node:perf_hooks";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Google Cloud Speech-to-Text v2 — the BAA-covered half of the STT seam.
//
// Built because `DEPLOYMENT_MODE=hipaa` could not hear at all: A6 refuses a
// Deepgram client at construction (no BAA covers it), `server.js` exited
// WITHOUT a Deepgram key, and `lib/bootChecks.js` exited WITH one in hipaa
// mode. No configuration resolved that; only a second provider does.
//
// This is NOT a replacement for Deepgram. The UK lane keeps Deepgram (GDPR has
// no covered-products restriction, an Art. 28 DPA suffices). Provider choice
// lives in sttStream.js and follows the compliance tier, never an env flag.
//
// ---------------------------------------------------------------------------
// What was learned by running it, not by reading about it
// ---------------------------------------------------------------------------
//
// 1. GOOGLE ENDPOINTS ON RECEIVED SILENCE, NOT ON WALL-CLOCK IDLE. A probe that
//    streamed 4.4s of speech and then simply stopped writing got NO final for
//    six seconds; the final only landed when the stream was closed. The same
//    audio followed by mu-law silence frames — which is what Twilio actually
//    sends — endpointed in ~700ms. session.js forwards every media frame
//    ungated (session.js:2999), so production behaves like the second probe.
//    If audio delivery is ever gated on VAD, this provider goes deaf.
//
// 2. THERE IS NO ENDPOINTING MILLISECOND KNOB. Deepgram takes `endpointing` in
//    ms; Google takes a three-value `endpointing_sensitivity` enum, and
//    measured across STANDARD/SHORT/SUPERSHORT the difference was 881 / 895 /
//    911 ms — inside the noise. Endpointing here is a fixed property of the
//    model, so the value that used to be tuned (STT_ENDPOINTING_MS) has no
//    counterpart and is deliberately not faked with a local timer.
//
// 3. `voice_activity_timeout.speech_end_timeout` LOOKS like Deepgram's
//    `utterance_end_ms` and is not. It CLOSES THE STREAM after speech ends.
//    Setting it to a turn-taking value would end the call's STT after the
//    first utterance. It is deliberately never set.
//
// 4. A STREAM DIES AT 5 MINUTES OF WALL CLOCK — measured: `10 ABORTED: Max
//    duration of 5 minutes reached for stream.` at 295.3s, with only ~188s of
//    audio delivered. The cap is on stream AGE, not audio duration, so the
//    rotation below is on a wall-clock timer. Calls run to
//    CALL_MAX_DURATION_MINUTES (default 30), so a call crosses this six times.
//
// 5. THE PUBLIC `streamingRecognize()` IS UNUSABLE. It derives its routing
//    header from a request that does not exist yet when the duplex is created,
//    and every attempt returned `INVALID_ARGUMENT: Invalid resource field
//    value in the request`. `_streamingRecognize()` is what Google's own v2
//    samples use.
//
// 6. ONE RESPONSE CARRIES SEVERAL RESULTS — a settled prefix and an unstable
//    tail. Reading `results[0]` alone silently truncates every interim.
//
// 7. THE FINAL ARRIVES AFTER THE END-OF-SPEECH EVENT, NOT BEFORE IT. Measured
//    order for one utterance is:
//
//        interim ... interim -> SPEECH_ACTIVITY_END -> is_final
//
//    with roughly 190ms between the last two. This is the opposite of
//    Deepgram, where `speech_final` rides ON the final that ends the turn.
//    Flushing on the event alone flushes an EMPTY buffer and the real
//    transcript then waits for the NEXT utterance's event to push it out — so
//    every turn is delivered one turn late and the assistant answers the
//    previous question forever. It cost a full C5b run to find: 17 of 18
//    utterances returned no final while interims and SPEECH_ACTIVITY_END both
//    arrived normally. See `endPending` below.
// ---------------------------------------------------------------------------

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 250;
const MAX_BUFFERED_BYTES = 16000; // ~2s of 8kHz mulaw
const MULAW_BYTES_PER_MS = 8; // 8kHz, 1 byte per sample

/**
 * When to swap streams ahead of the server's 5-minute cap.
 *
 * 4 minutes leaves a full minute of headroom for the swap itself plus the
 * deferral below. Measured cap: 295.3s. This is wall clock, deliberately —
 * see note 4.
 */
const ROTATE_AFTER_MS = 240_000;

/**
 * How long a rotation may wait for an utterance boundary before forcing it.
 *
 * A rotation in the middle of someone speaking splits their sentence across
 * two streams. Waiting for SPEECH_ACTIVITY_END avoids that, but waiting
 * forever walks into the very cap this exists to dodge.
 */
const ROTATE_DEADLINE_MS = 30_000;

/** Phrase-set boost for business terms. Google's documented usable range is 0-20. */
const KEYTERM_BOOST = 15;

/**
 * How long to wait after SPEECH_ACTIVITY_END for the final that follows it.
 *
 * Measured gap is ~190ms. This is the backstop for the case where no final
 * ever comes — a burst of noise that endpoints but transcribes to nothing.
 * Without it `onUtteranceEnd` would never fire for that utterance, nothing
 * downstream would re-arm the silence ladder, and the call would go
 * permanently quiet: the exact failure mode session.js's echo branches already
 * guard against on the Deepgram side.
 *
 * Generous against the measurement because the cost of waiting is one extra
 * beat of silence, and the cost of giving up early is a truncated turn.
 */
const FINAL_AFTER_END_GRACE_MS = 700;

/** Locations this stack is allowed to send caller audio to. */
const DEFAULT_LOCATION = "us-central1";

/** Cached per project+location: a gRPC channel per call would cost pickup latency. */
const clients = new Map();

/**
 * The Speech SDK, loaded on first use rather than at import.
 *
 * `@google-cloud/speech` drags in gRPC and costs a MEASURED 694ms to import —
 * against 452ms for the whole Deepgram module. Imported at the top of this
 * file, every deployment paid it at boot, including the UK lane that never
 * calls Google at all. With staging and the UK at `min-instances = 0` (C-2)
 * that is 694ms added to a cold start, and a cold start lands on a caller.
 *
 * Covered deployments still pay it at BOOT, not on the first call: server.js
 * runs assertSttEncryption() before the port opens whenever the provider is
 * google, and that warms this cache. So the covered lane is unchanged and the
 * uncovered lane stops paying for something it does not use.
 *
 * The one case that pays it on a live call is a `hipaa` TENANT on a `standard`
 * deployment — the ratchet in lib/compliance.js. Boot cannot know that tenant
 * exists without a database query it does not make, so the first such call
 * wears it.
 */
let speechModulePromise = null;

function loadSpeechV2() {
  if (!speechModulePromise) {
    speechModulePromise = import("@google-cloud/speech").then((m) => m.v2 ?? m.default?.v2);
  }
  return speechModulePromise;
}

/**
 * Where Speech-to-Text runs for this process.
 *
 * `global` is REFUSED rather than defaulted away from. Vertex taught this
 * exact lesson at B1: a `global` endpoint routes anywhere on earth, which
 * voids a residency claim outright, and it is spelled almost identically to a
 * correct value. A HIPAA lane may not use it and neither may the UK.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ project: string, location: string, apiEndpoint: string }}
 */
export function googleSttEnvironment(env = process.env) {
  const location = (env.STT_LOCATION || DEFAULT_LOCATION).trim().toLowerCase();
  if (location === "global") {
    throw new Error(
      "STT_LOCATION=global is refused: a global Speech-to-Text endpoint may process audio in " +
        "any region, which voids both the HIPAA data-location control and the UK residency claim. " +
        `Set a single region (e.g. ${DEFAULT_LOCATION}).`
    );
  }
  const project = (env.GOOGLE_CLOUD_PROJECT || "").trim();
  if (!project) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT is not set. Google Speech-to-Text v2 addresses its recognizer by " +
        "project and location; there is no account-wide endpoint to fall back to."
    );
  }
  return { project, location, apiEndpoint: `${location}-speech.googleapis.com` };
}

async function getClient(env = process.env) {
  const { project, location, apiEndpoint } = googleSttEnvironment(env);
  const key = `${project}|${location}`;
  if (!clients.has(key)) {
    const v2 = await loadSpeechV2();
    clients.set(key, new v2.SpeechClient({ apiEndpoint, projectId: project }));
  }
  return clients.get(key);
}

/**
 * Refuse to run Google STT on a location whose Config carries no CMEK key.
 *
 * ---------------------------------------------------------------------------
 * Why this is the assertion, when the obvious one does not exist
 * ---------------------------------------------------------------------------
 *
 * The requirement was to assert the UNLOGGED pricing tier in code rather than
 * in a comment, because the "Logged" tier ($0.012/min against $0.016) means
 * Google may retain the audio — for PHI, the one thing that must never be
 * opted into.
 *
 * There is no such field. Verified against the shipped protos: the string
 * "logging" does not occur ANYWHERE in the v1 or v2 Speech protos — not in
 * RecognitionConfig, not in RecognitionFeatures, not on the Recognizer, not on
 * the Config resource. Both SKUs are real (confirmed against the live Cloud
 * Billing catalog: `Cloud Speech-to-Text Recognition` at $0.016/min and
 * `Cloud Speech-to-Text Recognition (Logged)` at $0.012/min), but the tier is
 * a project-level program opt-in with no API surface. Code cannot select it,
 * and an `if` statement pretending otherwise would be a comment with extra
 * steps.
 *
 * What IS assertable is CMEK. The v2 `Config` resource per location carries
 * `kms_key_name`, it is readable, and with a customer-managed key the audio at
 * rest is encrypted under a key this org controls and can destroy. So the
 * check that runs is the one that can actually fail.
 *
 * Called at BOOT, never per call: this is a network round trip and the pickup
 * path is measured in milliseconds.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Promise<{ name: string, kmsKeyName: string }>}
 */
export async function assertSttEncryption(env = process.env) {
  const { project, location } = googleSttEnvironment(env);
  const client = await getClient(env);
  const [config] = await client.getConfig({
    name: `projects/${project}/locations/${location}/config`,
  });
  const kmsKeyName = (config?.kmsKeyName || "").trim();
  if (!kmsKeyName) {
    throw new Error(
      `Speech-to-Text v2 has NO CMEK key on projects/${project}/locations/${location}/config. ` +
        "Refusing to send caller audio: Google exposes no API field for the data-logging tier, so " +
        "a customer-managed key is the only encryption control this code can verify at runtime. " +
        "Set `kms_key_name` on the Speech config in Terraform."
    );
  }
  return { name: config.name, kmsKeyName };
}

/**
 * Language codes for one call.
 *
 * "multi" is a Deepgram concept — a single model that code-switches. Google
 * wants explicit codes, and forwarding the literal string "multi" would be
 * accepted as a language nobody speaks. STT_MULTI_LANGUAGES makes the set a
 * deployment decision rather than a silent guess.
 */
function languageCodesFor(language, env = process.env) {
  if (language !== "multi") return [language || "en-US"];
  const configured = (env.STT_MULTI_LANGUAGES || "en-US,es-US")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length ? configured : ["en-US"];
}

/**
 * Build the one config message that opens a v2 stream.
 *
 * @param {object} opts
 * @param {string} opts.recognizer
 * @param {string} opts.language
 * @param {string[]} opts.keyterms
 */
function buildStreamingConfig({ recognizer, language, keyterms }) {
  const config = {
    explicitDecodingConfig: {
      encoding: "MULAW",
      sampleRateHertz: 8000,
      audioChannelCount: 1,
    },
    languageCodes: languageCodesFor(language),
    // The telephony model is trained on 8kHz narrowband call audio. `latest_long`
    // scores better on clean wideband speech and worse on exactly what arrives
    // down a phone line.
    model: "telephony",
    features: {
      enableAutomaticPunctuation: true,
      // Load-bearing: getLastSpeechEndAt reconstructs when the caller went
      // quiet from the last word's offset. Without it there is no tail to
      // subtract and every turn's latency attribution is wrong.
      enableWordTimeOffsets: true,
    },
  };

  // Google's analogue of Deepgram keyterm prompting. Inline, so no PhraseSet
  // resource has to be created, owned, or cleaned up per business.
  if (Array.isArray(keyterms) && keyterms.length > 0) {
    config.adaptation = {
      phraseSets: [
        {
          inlinePhraseSet: {
            phrases: keyterms.map((value) => ({ value, boost: KEYTERM_BOOST })),
          },
        },
      ],
    };
  }

  return {
    recognizer,
    streamingConfig: {
      config,
      streamingFeatures: {
        interimResults: true,
        // The ONLY endpointing signal available. Without it no final arrives
        // until the stream closes — see note 1.
        enableVoiceActivityEvents: true,
        // NOTE: voiceActivityTimeout is deliberately absent. It closes the
        // stream rather than ending an utterance — see note 3.
      },
    },
  };
}

/** Protobuf Durations arrive as {seconds, nanos}, and seconds may be a Long. */
function durationToSeconds(d) {
  if (!d) return null;
  const seconds = typeof d.seconds === "object" && d.seconds !== null
    ? Number(d.seconds.toString())
    : Number(d.seconds || 0);
  const nanos = Number(d.nanos || 0);
  const total = seconds + nanos / 1e9;
  return Number.isFinite(total) ? total : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a reconnecting Google STT v2 streaming connection for one call.
 *
 * Callback contract is IDENTICAL to sttStream.js's Deepgram implementation —
 * that is what makes the seam a seam. Six callbacks, none provider-shaped.
 *
 * @param {object} opts
 * @param {string}   [opts.language="en-US"]
 * @param {string[]} [opts.keyterms=[]]
 * @param {string}   [opts.callSid]
 * @param {function} [opts.onFinal]         - (text, {confidence}) => void
 * @param {function} [opts.onInterim]       - (text, {confidence}) => void
 * @param {function} [opts.onUtteranceEnd]  - () => void
 * @param {function} [opts.onSpeechStarted] - () => void
 * @param {function} [opts.onError]         - (err) => void, reconnect exhausted
 * @param {function} [opts.onReconnect]     - (attempt) => void
 * @param {function} [opts.now]             - injectable clock
 * @returns {Promise<{sendAudio: function(Buffer): void, close: function(): void, isAlive: function(): boolean, getLastSpeechEndAt: function(): number|null}>}
 */
export async function createGoogleSttStream({
  language = "en-US",
  keyterms = [],
  callSid,
  onFinal,
  onInterim,
  onUtteranceEnd,
  onSpeechStarted,
  onError,
  onReconnect,
  now = () => performance.now(),
} = {}) {
  const { project, location } = googleSttEnvironment();
  const recognizer = `projects/${project}/locations/${location}/recognizers/_`;
  const client = await getClient();
  const configMessage = buildStreamingConfig({ recognizer, language, keyterms });

  let stream = null;
  let connected = false;
  let closed = false;
  let reconnecting = false;
  let utteranceBuffer = "";
  let utteranceMinConfidence;
  let audioQueue = [];
  let queuedBytes = 0;
  // ms of audio the CURRENT stream has received — the shared clock that makes
  // Google's word offsets comparable to ours. Resets on every new stream.
  let deliveredAudioMs = 0;
  let lastSpeechEndAt = null;
  let bufferingWarned = false;
  let rotateTimer = null;
  let rotateDeadlineTimer = null;
  let rotateDue = false;
  /** SPEECH_ACTIVITY_END seen; the utterance ends on the final that follows. */
  let endPending = false;
  let endGraceTimer = null;

  function clearRotationTimers() {
    if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null; }
    if (rotateDeadlineTimer) { clearTimeout(rotateDeadlineTimer); rotateDeadlineTimer = null; }
  }

  /**
   * Arm the rotation that keeps this connection ahead of the server's cap.
   *
   * Two timers, and the second is the one that matters: rotating exactly on
   * schedule would routinely cut someone off mid-sentence, so the swap waits
   * for an utterance boundary — but only for as long as the headroom allows.
   */
  function armRotation() {
    clearRotationTimers();
    rotateTimer = setTimeout(() => {
      rotateDue = true;
      log.info("stt_rotation_due", { callSid, afterMs: ROTATE_AFTER_MS });
      // Nothing being said right now: swap immediately and cost the caller
      // nothing.
      if (!utteranceBuffer) rotateNow("idle");
      else {
        rotateDeadlineTimer = setTimeout(() => rotateNow("deadline"), ROTATE_DEADLINE_MS);
        rotateDeadlineTimer.unref?.();
      }
    }, ROTATE_AFTER_MS);
    rotateTimer.unref?.();
  }

  function rotateNow(reason) {
    if (closed || reconnecting || !rotateDue) return;
    rotateDue = false;
    clearRotationTimers();
    // Anything already transcribed is flushed BEFORE the socket goes away.
    // The alternative is a caller's half-sentence dying with the stream.
    //
    // If end-of-speech was already announced, complete the utterance properly
    // rather than only flushing: the pending state belongs to the old stream
    // and must not survive into the new one, or the next stream's first final
    // would be treated as the settling final of an utterance that ended before
    // the swap. (rotateDue is already false, so this cannot recurse.)
    if (endPending) completeUtterance();
    else flushFinal();
    log.info("stt_rotating", { callSid, reason });
    triggerReconnect();
  }

  function bufferAudio(chunk) {
    audioQueue.push(chunk);
    queuedBytes += chunk.length;
    while (queuedBytes > MAX_BUFFERED_BYTES && audioQueue.length > 0) {
      const dropped = audioQueue.shift();
      queuedBytes -= dropped.length;
    }
  }

  /** Hand one chunk over and advance the shared clock by exactly what landed. */
  function deliver(chunk) {
    stream.write({ audio: chunk });
    deliveredAudioMs += chunk.length / MULAW_BYTES_PER_MS;
  }

  function flushAudioQueue() {
    const pending = audioQueue;
    audioQueue = [];
    queuedBytes = 0;
    for (const chunk of pending) {
      try {
        deliver(chunk);
      } catch (err) {
        log.error("stt_audio_flush_failed", { callSid, reason: err?.message });
      }
    }
  }

  function flushFinal() {
    if (!utteranceBuffer) return;
    const text = utteranceBuffer.trim();
    utteranceBuffer = "";
    const confidence = utteranceMinConfidence;
    utteranceMinConfidence = undefined;
    if (text) onFinal?.(text, { confidence });
  }

  function clearEndGrace() {
    if (endGraceTimer) { clearTimeout(endGraceTimer); endGraceTimer = null; }
  }

  /**
   * Close out the utterance whose end-of-speech has already been announced.
   *
   * Ordering is load-bearing: the words FIRST, then the boundary. session.js
   * documents onUtteranceEnd as "fired after any onFinal flush" and
   * turnManager re-arms the silence ladder on it, so the reverse order would
   * close a turn before its own transcript arrived.
   */
  function completeUtterance() {
    if (!endPending) return;
    endPending = false;
    clearEndGrace();
    flushFinal();
    onUtteranceEnd?.();
    // A boundary is the cheapest possible moment to swap streams.
    if (rotateDue) rotateNow("utterance_end");
  }

  /**
   * Google reports confidence 0 on interims and on some finals.
   *
   * Forwarded literally that would be catastrophic rather than merely wrong:
   * turnManager reads a number below BARGE_MIN_CONFIDENCE as "this may be
   * noise, do not let it interrupt", so a constant 0 would make the caller
   * unable to interrupt the assistant at all. Unknown is the honest value, and
   * turnManager already lets unknown pass.
   */
  function usableConfidence(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /**
   * Convert a final's audio-relative word offset into a wall-clock instant.
   * Identical arithmetic to the Deepgram implementation, on Google's clock.
   */
  function recordSpeechEnd(result, alt) {
    try {
      const words = alt?.words;
      const lastWordEnd = Array.isArray(words) && words.length
        ? durationToSeconds(words[words.length - 1]?.endOffset)
        : null;
      const endSec = lastWordEnd != null ? lastWordEnd : durationToSeconds(result?.resultEndOffset);
      if (endSec == null) return;
      // A negative tail would describe audio we never sent. Treat it as a
      // desynced clock and do not back-date at all.
      const tailMs = Math.max(0, deliveredAudioMs - endSec * 1000);
      lastSpeechEndAt = now() - tailMs;
    } catch {
      // Instrumentation must never break a call.
    }
  }

  function handleResponse(res) {
    if (!res) return;

    const eventType = res.speechEventType;
    if (eventType === "SPEECH_ACTIVITY_BEGIN") {
      log.debug("stt_speech_started", { callSid });
      onSpeechStarted?.();
    }

    // One response carries a settled prefix and an unstable tail. Interims are
    // the concatenation of the non-final results; reading results[0] alone
    // truncates them.
    let interimText = "";
    let interimConfidence;
    let sawFinalThisResponse = false;

    for (const result of res.results || []) {
      const alt = result.alternatives?.[0];
      if (!alt) continue;
      const transcript = alt.transcript || "";

      if (result.isFinal) {
        recordSpeechEnd(result, alt);
        if (transcript) {
          utteranceBuffer += (utteranceBuffer ? " " : "") + transcript;
          const c = usableConfidence(alt.confidence);
          if (c !== undefined) {
            utteranceMinConfidence =
              utteranceMinConfidence === undefined ? c : Math.min(utteranceMinConfidence, c);
          }
        }
        sawFinalThisResponse = true;
      } else if (transcript) {
        interimText += transcript;
        const c = usableConfidence(alt.confidence);
        if (c !== undefined) {
          interimConfidence = interimConfidence === undefined ? c : Math.min(interimConfidence, c);
        }
      }
    }

    if (interimText) onInterim?.(interimText, { confidence: interimConfidence });

    // End of speech ARMS the utterance; it does not complete it. The settled
    // transcript is still in flight — see note 7.
    if (eventType === "SPEECH_ACTIVITY_END") {
      endPending = true;
      clearEndGrace();
      endGraceTimer = setTimeout(() => {
        // No final came. Complete anyway so the ladder re-arms; a silent
        // utterance is still an utterance that ended.
        log.debug("stt_final_after_end_timeout", { callSid });
        completeUtterance();
      }, FINAL_AFTER_END_GRACE_MS);
      endGraceTimer.unref?.();
    }

    // The final that settles an already-ended utterance is what actually ends
    // the turn. A final with no end pending is a mid-utterance fragment and
    // accumulates, exactly as Deepgram's is_final does.
    if (sawFinalThisResponse && endPending) completeUtterance();
  }

  /**
   * Detach handlers from a stream being abandoned before ending it, so a late
   * error or end event from the old socket cannot re-enter reconnect logic
   * after we have already recovered.
   */
  function teardownStream(s) {
    if (!s) return;
    try {
      s.removeAllListeners?.();
    } catch (err) {
      log.error("stt_teardown_detach_failed", { callSid, reason: err?.message });
    }
    try {
      s.end();
    } catch (err) {
      log.error("stt_teardown_close_failed", { callSid, reason: err?.message });
    }
  }

  function triggerReconnect() {
    if (closed || reconnecting) return;
    reconnecting = true;
    connected = false;
    const stale = stream;
    stream = null;
    teardownStream(stale);
    attemptReconnect();
  }

  function handleStreamError(err) {
    // The 5-minute cap arrives here as `10 ABORTED` if rotation ever loses the
    // race. Reconnecting is the same remedy either way.
    log.error("stt_stream_error", { callSid, code: err?.code, message: err?.message });
    triggerReconnect();
  }

  function handleStreamEnd() {
    if (closed) return;
    triggerReconnect();
  }

  function openStream() {
    const s = client._streamingRecognize();
    s.on("data", handleResponse);
    s.on("error", handleStreamError);
    s.on("end", handleStreamEnd);
    s.write(configMessage);
    return s;
  }

  async function attemptReconnect() {
    let attempt = 0;
    let next = null;

    while (attempt < MAX_RECONNECT_ATTEMPTS && !closed) {
      attempt++;
      await delay(RECONNECT_DELAY_MS);
      if (closed) break;
      try {
        next = openStream();
        break;
      } catch (err) {
        log.error("stt_reconnect_attempt_failed", { callSid, attempt, reason: err?.message });
        next = null;
      }
    }

    reconnecting = false;

    if (closed) {
      if (next) teardownStream(next);
      return;
    }

    if (next) {
      stream = next;
      connected = true;
      bufferingWarned = false;
      // A new stream restarts Google's offsets at zero, so the matching audio
      // clock restarts with it — BEFORE the replay, so buffered audio counts
      // against the new stream.
      deliveredAudioMs = 0;
      flushAudioQueue();
      armRotation();
      log.info("stt_reconnected", { callSid, attempt });
      onReconnect?.(attempt);
    } else {
      flushFinal();
      const err = new Error(`STT reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      err.code = "STT_RECONNECT_FAILED";
      log.error("stt_reconnect_exhausted", { callSid, attempts: MAX_RECONNECT_ATTEMPTS });
      onError?.(err);
    }
  }

  function sendAudio(chunk) {
    if (!chunk || closed) return;
    if (!connected || !stream) {
      if (!bufferingWarned) {
        log.error("stt_audio_buffering", { callSid, reason: "stream_not_connected" });
        bufferingWarned = true;
      }
      bufferAudio(chunk);
      return;
    }
    try {
      deliver(chunk);
    } catch (err) {
      // ERR_STREAM_DESTROYED arrives here once per 20ms frame if it is not
      // caught — the live probe produced 200+ of them in seven seconds.
      log.error("stt_audio_send_failed", { callSid, reason: err?.message });
      connected = false;
      bufferAudio(chunk);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    connected = false;
    clearRotationTimers();
    clearEndGrace();
    audioQueue = [];
    queuedBytes = 0;
    if (stream) {
      try {
        stream.end();
      } catch (err) {
        log.error("stt_close_failed", { callSid, reason: err?.message });
      }
    }
    log.info("stt_closed", { callSid });
  }

  function isAlive() {
    return !closed && connected;
  }

  function getLastSpeechEndAt() {
    return lastSpeechEndAt;
  }

  stream = openStream();
  connected = true;
  armRotation();
  log.info("stt_open", { callSid, provider: "google", language, location });

  return { sendAudio, close, isAlive, getLastSpeechEndAt };
}
