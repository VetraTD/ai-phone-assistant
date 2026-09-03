import { performance } from "node:perf_hooks";

import * as db from "../../../services/db.js";
import {
  buildSystemInstruction,
  callToolNames,
  callToolParamNames,
} from "../../../services/gemini.js";
import { STEPS } from "../../callState.js";
import { resolveTransferAllowed } from "../session.js";
import { applyReplyState, spellingSettled, applyCallerSpellingSignal } from "../replyState.js";
import {
  dispatchCapabilityEffects,
  mergeCapabilityState as mergeCapabilityStateInto,
} from "../../capabilities/effects.js";
import { getStrings } from "../strings.js";
import { resolveRingTone } from "../voiceLocale.js";
import * as notifications from "../../../services/notifications.js";
import { captureException } from "../../sentry.js";
import { escapeXml } from "../../twiml.js";
import { log } from "../../logger.js";
import { bumpCounter } from "../metrics.js";
import { createVad } from "../inboundVad.js";
import { createAudioOut } from "../audioOut.js";
import { createEchoGuard } from "../echoGuard.js";
import { createDownsampler, mulaw8kToPcm16k, createFramer } from "../resample.js";
import { connectLive, createLiveClient, liveSurface, LIVE_MODEL_DEFAULT } from "./client.js";
import { buildLiveTools, createToolRunner } from "./tools.js";
import { createHalfDuplexGate } from "./halfDuplex.js";
import { createLeakGuard, LEAK_RECOVERY_NOTE } from "./leakGuard.js";
import { selectStrategy } from "./turnEnd/index.js";
import { createCallSummary } from "./summary.js";

// ---------------------------------------------------------------------------
// The speech-to-speech front-end. Tier 1: Gemini Live, on its own routes.
//
// docs/speech-to-speech-handoff.md section 7 step 2. Step 1 was a throwaway
// bridge -- no tools, no database, no tenant, no reducer, no guards -- which
// answered the one question that mattered before any of this was worth
// building: does PSTN echo break the approach. It does not.
//
// ---------------------------------------------------------------------------
// Why this does not share a path with the cascade
// ---------------------------------------------------------------------------
//
// The cascade serves a paying clinic and it is tier 3, the last thing standing
// when both speech-to-speech vendors are down. It is reached on /twilio/voice
// and /twilio/media-stream; this is reached on /twilio/live-voice and
// /twilio/live-stream. `handleVoiceSessionConnection` and
// `selectPipelineHandler` are not edited at all, so a defect here cannot
// reach a call that is answering there.
//
// The cost of that choice, stated rather than hidden: the tenant-load sequence
// below duplicates the one in lib/voice/session.js. It could be shared only by
// extracting it out of a 209 KB handler, which is a change to the cascade, and
// the whole point is not to make one. Kept deliberately small.
//
// ---------------------------------------------------------------------------
// What is NOT here
// ---------------------------------------------------------------------------
//
// Tiers 2a, 2b and 3. Section 5's rule is that no two adjacent tiers fail for
// the same reason, and tier 1 has not survived a real call yet -- building a
// fallback for something unproven is building on an assumption about how it
// fails.
//
// The full reply-state reducer. `applyReplyState` drives the step machine from
// the assistant's own text and needs several of session.js's internals; the
// step here advances on the intent tool and on a completed action, which is
// enough to unlock `end_call` through the paths services/tools.js already
// allows. Recorded in the backlog rather than half-built.
// ---------------------------------------------------------------------------

/** Preset Live voice. Documented by name, not by accent; an ear decides. */
const VOICE = process.env.LIVE_VOICE || "Kore";

/** BCP-47 for synthesis. Accepted on 9/9 spike calls; honoured is unproven. */
const LANGUAGE_CODE = process.env.LIVE_LANGUAGE_CODE || "en-GB";

/** Twilio media frames are 160 bytes of mu-law, 20 ms. */
const FRAME_BYTES = 160;

/**
 * Pay the Live front-end's cold-start cost at boot, not on a caller's first call.
 *
 * ---------------------------------------------------------------------------
 * Measured, on a real pair of calls
 * ---------------------------------------------------------------------------
 *
 *   live_stream_start -> live_session_open    cold 2,302 ms    warm 53 ms
 *
 * plus ~680 ms to first audio. The caller heard nothing for three seconds and
 * hung up, which is what a person should do with a line that appears dead. The
 * owner had been seeing this for a while: "after we make a change it does not
 * speak for the first call and then starts speaking from the second call
 * onwards."
 *
 * The cascade never does this, because TTS speaks a greeting the instant the
 * socket opens while everything else warms behind it. Here the model IS the
 * voice, so every cold-start millisecond is dead air: module graph, the
 * @google/genai client, the database pool, the websocket handshake.
 *
 * Cloud Run makes it recurrent rather than one-off -- scale-to-zero runs the
 * cold path again after every idle period, so deploy with `--min-instances=1`
 * as well as calling this.
 *
 * ---------------------------------------------------------------------------
 * Best-effort, always
 * ---------------------------------------------------------------------------
 *
 * This runs in a process whose main job is the CASCADE. A missing or
 * misconfigured Live credential must never stop that process booting: a slow
 * first Live call is a far better outcome than a service that will not start.
 * So every failure is logged and swallowed, and the return value is the only
 * signal.
 *
 * @returns {Promise<boolean>} whether the client could actually be built
 */
export async function warmLiveFrontEnd(env = process.env) {
  try {
    // Constructing the client is what pulls the SDK's own module graph and
    // sets up its connection pool. It also surfaces a bad configuration at
    // boot, in a log line, rather than on the first caller.
    createLiveClient(env);
    log.info("live_frontend_warm", { surface: liveSurface(env) });
    return true;
  } catch (err) {
    log.error("live_frontend_warm_failed", {
      reason: err?.message,
      severity: "warn",
      note: "The Live front-end will be slow on its first call and may refuse it. The cascade is unaffected.",
    });
    return false;
  }
}

/**
 * One Twilio Media Streams connection, served by Gemini Live.
 *
 * @param {import("ws").WebSocket} ws
 * @param {import("http").IncomingMessage} _req
 * @param {object} [deps] - test seam
 */
export async function handleLiveSessionConnection(ws, _req, deps = {}) {
  const {
    now = () => performance.now(),
    connect = connectLive,
    database = db,
    env = process.env,
    execute,
    effectsDeps,
    twilioClient,
    exitFallbackMs,
  } = deps;

  const t0 = now();
  const strategy = selectStrategy(env);
  const summary = createCallSummary({
    arm: strategy.name,
    model: env.LIVE_MODEL || LIVE_MODEL_DEFAULT,
    surface: liveSurface(env),
  });

  let callSid = null;
  let session = null;
  let audioOut = null;
  let runner = null;
  let closed = false;

  const vad = createVad();
  const gate = createHalfDuplexGate();
  const downsampler = createDownsampler();
  const framer = createFramer(FRAME_BYTES);
  const echoGuard = createEchoGuard({ aiAudibleUntil: () => audioOut?.aiAudioPlayingUntil() ?? 0 });

  // ---- call state -------------------------------------------------------
  //
  // The SAME shape lib/callState.js defines and lib/harness/textSession.js
  // mirrors, because it is fed to the same reducer. Only the fields
  // applyReplyState and dispatchCapabilityEffects actually touch.
  //
  // Not a private approximation. replyState.js's own comment records what a
  // private one costs: anything implemented in one driver and not the other
  // "goes inert" for the drivers that miss it, "which is how the nine-turn
  // spelling livelock survived with every hard assert green".
  const state = {
    // IDENTIFY_INTENT, not GREETING, and lib/harness/textSession.js seeds the
    // same. applyReplyState only promotes the step from IDENTIFY_INTENT or
    // CONFIRM, so a call seeded at GREETING stays at "greeting" for its whole
    // life -- set_call_intent never advances it and every tool sees the wrong
    // step. The cascade reaches IDENTIFY_INTENT at pickup; this path had no
    // equivalent once the hand-rolled transition was removed.
    step: STEPS.IDENTIFY_INTENT,
    intent: null,
    history: [],
    capabilityState: {},
    consecutiveFailures: 0,
    config: null,
    callerContext: null,
    businessId: null,
    callerNumber: null,
    twilioNumber: null,
    dbCallId: null,
  };
  // Test seam. The reducer's effects are otherwise only observable through a
  // database, and a defect that drops them looks exactly like one that stores
  // them (which is how they were dropped in the first place).
  ws.liveState = state;

  /** Accumulated across one model turn, for the reducer. */
  let turnReplyText = "";
  let turnUserText = "";
  /** Has the current spoken turn already been folded into the reducer? */
  let turnApplied = false;
  let pendingIntentArgs = null;
  let pendingEndCallArgs = null;
  let pendingCapabilityEffects = [];
  let pendingTransfer = null;
  /** The extras bag the tool runner closes over, so effects can refresh it. */
  let liveExtras = null;
  /** LVX21. Built once the tenant's own tool vocabulary is known. */
  let leakGuard = null;
  /**
   * Has this model turn already been caught leaking?
   *
   * One-shot, because the detector re-scans a sliding window of the turn's
   * transcript -- so without this every later fragment re-reports the same
   * leak, and every one of them sends the model another note.
   */
  let leakHandledThisTurn = false;
  let callerTurnCount = 0;
  let lastVoicedMs = 0;
  let speechEndAt = null;
  let awaitingFirstAudio = false;
  let awaitingTranscript = false;
  let modelSpeaking = false;
  let lastBargeAt = -Infinity;
  let endCallArmed = false;
  /**
   * What to do once the audio already queued has actually reached the caller.
   *
   * Both exits from a call need this and neither had it: end_call closed the
   * socket the instant the model stopped GENERATING, which is long before the
   * caller has HEARD anything -- audioOut paces to Twilio and holds the rest
   * locally, so stop() threw away most of the goodbye. Transfer never happened
   * at all.
   *
   * `{ kind: "end_call" | "transfer", mark, number? }`.
   */
  let pendingExit = null;
  let exitTimer = null;

  /**
   * Has any model audio been enqueued yet this call?
   *
   * Load-bearing, and not obviously so. `audioOut.isPlaying(grace)` is
   * `now() < playingUntil + grace`, and `playingUntil` starts at 0 -- so on any
   * clock whose readings are smaller than the grace window it answers TRUE
   * before a single byte has ever been played, and the half-duplex gate
   * swallows the caller's opening words.
   *
   * Production is saved from this only by performance.now() being process
   * uptime and therefore large. That is an accident of the clock, not a
   * property of the logic, and a test clock starting at zero reproduces it
   * immediately -- which is how it was found.
   */
  let hasEnqueuedAudio = false;
  const isPlaying = () => hasEnqueuedAudio && Boolean(audioOut?.isPlaying(150));
  const turnState = () => ({
    step: state.step,
    callerTurnCount,
    transferAllowed: transferAllowed(),
    spellingSettled: spellingSettled(state),
  });

  // -----------------------------------------------------------------------
  // Reducer hooks -- identical wiring to lib/voice/session.js and
  // lib/harness/textSession.js. Three drivers, one reducer.
  // -----------------------------------------------------------------------

  function mergeCapabilityState(patch) {
    mergeCapabilityStateInto(state, patch);
  }

  /**
   * Hand a capability's deferred effects to the pack that owns them.
   *
   * This is the half that was missing, and the caller could not tell.
   * capabilities/messages.js answers immediately and defers its database write
   * to `onEffect` on purpose -- message-taking is the safety net beneath every
   * other capability, so it must never be the thing that stalls a call. With no
   * dispatcher the caller hears "I'll make sure they get your message", the
   * tool reports success, and no row is written and nobody is notified. The
   * booking owner-alert and the SMS consent record fail the same way.
   */
  function dispatchEffects(effectsList) {
    if (effectsDeps?.dispatch) return effectsDeps.dispatch(effectsList);
    return dispatchCapabilityEffects(effectsList, {
      STEPS,
      setStep(nextStep, trigger) {
        state.step = nextStep;
        log.info("live_step_transition", { callSid, toStep: nextStep, trigger });
      },
      setCapabilityState: mergeCapabilityState,
      // A pack may not reach into session state, so it computes the next
      // caller snapshot and hands it back. Without this a caller who books at
      // 10:00 and asks about 11:00 later in the SAME call is not recognised as
      // already having one.
      setCallerContext(next) {
        state.callerContext = next || null;
        // The tools read `extras`, not `state`. Updating only state left this
        // inert: a caller who books at 10:00 and asks about 11:00 later in the
        // SAME call was still described by the call-start snapshot, which is
        // the exact scenario this hook exists for.
        if (liveExtras) liveExtras.callerContext = state.callerContext;
      },
      call: {
        callSid,
        businessId: state.businessId,
        callId: state.dbCallId || null,
        callerNumber: state.callerNumber,
        twilioNumber: state.twilioNumber || null,
        config: state.config,
        callerContext: state.callerContext || null,
      },
      deps: { notifications, db: database, log, captureException },
    });
  }

  /**
   * Drop queued outbound audio, and rescue an exit that was queued behind it.
   *
   * audioOut.clear() empties the pacing queue AND its outstanding marks, so an
   * exit mark armed behind a goodbye never reaches the wire and Twilio never
   * echoes it back. Without this the exit only fired from the 15 s backstop --
   * fifteen seconds of dead air after the caller had already been said goodbye
   * to, or before a transfer they had already been promised.
   */
  function clearAudio(atMs, { fadeMs = 120 } = {}) {
    // fadeMs 0 is a HARD clear, and the difference matters. A tapered clear
    // drops only what audioOut still holds locally and lets Twilio finish
    // playing what it already has; a hard clear also sends Twilio a `clear`
    // event, which discards its buffer too. A barge wants the taper -- it
    // sounds like ducking rather than a cut. A leak wants the hard stop,
    // because the audio Twilio is holding is exactly what must not be heard.
    audioOut?.clear(fadeMs > 0 ? { fadeMs } : {});
    echoGuard.noteAudioStopped(atMs);
    if (pendingExit) runExit("audio_cleared");
  }

  /** The number a transfer would dial, or null. */
  function transferNumber() {
    return state.config?.transferPhoneNumber || process.env.TRANSFER_NUMBER || null;
  }

  /**
   * Whether this business can be transferred to right now.
   *
   * BOTH halves, as the cascade has it (`canTransfer = !!transferNumber &&
   * resolveTransferAllowed`). Policy alone says only that a transfer is
   * permitted; without a number there is nothing to dial, and the model would
   * promise one, succeed, and disconnect the caller mid-promise.
   */
  function transferAllowed() {
    return Boolean(transferNumber()) && Boolean(state.config) && resolveTransferAllowed(state.config);
  }

  /**
   * Fold one completed model turn into shared state.
   *
   * Runs the SAME reducer the cascade and the eval harness run, which is what
   * gives this path the spelling caps (backlog LVX8: the assistant asked a
   * caller to spell their name on three consecutive turns), the step machine,
   * and the capability effects above.
   */
  function applyTurn() {
    const replyText = turnReplyText.trim();
    const userText = turnUserText.trim();
    turnReplyText = "";
    turnUserText = "";
    // Before the early return below, not after: a turn with nothing to fold
    // still ends, and a guard left armed from it would stay armed for the
    // next one.
    leakHandledThisTurn = false;
    if (!replyText && !userText) return;

    try {
      applyReplyState(
        state,
        {
          userText,
          reply: {
            text: replyText,
            intentArgs: pendingIntentArgs,
            endCallArgs: pendingEndCallArgs,
            capabilityEffects: pendingCapabilityEffects,
            capabilityState: null,
          },
        },
        {
          STEPS,
          mergeCapabilityState,
          dispatchEffects,
          spellRequestRe: getStrings(state.config).spellRequestRe,
        }
      );
      // Cleared only on the path that actually consumed them. This sat after
      // the catch, so a throw anywhere in applyReplyState BEFORE its
      // dispatchEffects call discarded effects the caller had already been told
      // succeeded -- reintroducing the exact data loss this reducer wiring
      // exists to close.
      pendingIntentArgs = null;
      pendingEndCallArgs = null;
      pendingCapabilityEffects = [];
    } catch (err) {
      log.error("live_reply_state_failed", { callSid, reason: err?.message, severity: "warn" });
    }
  }

  /**
   * LVX21. Catch our own internals before the caller hears them.
   *
   * The owner reported "hearing some backend stuff I was not supposed to
   * hear" on a real call that had get_caller_appointments_from_db,
   * cancel_appointment_db and three book_appointment calls in play -- exactly
   * the vocabulary that leaks. The cascade cannot do this: its text passes
   * through speakableText.js before it reaches TTS. Here the model IS the
   * voice, and nothing stood between it and the line.
   *
   * Runs BEFORE the fragment is appended to turnReplyText, so the window is
   * `what we had said` + `what just arrived` and a name split across two
   * fragments is still seen whole.
   */
  function inspectOutbound(fragment, atMs) {
    if (!leakGuard || leakHandledThisTurn) return;
    const verdict = leakGuard.inspect(turnReplyText, fragment);
    if (!verdict.leaked) return;
    leakHandledThisTurn = true;
    bumpCounter("live_outbound_leaks");

    // How much of what we are saying has NOT yet reached the caller.
    //
    // This is the whole question for a guard on this path, and it is the one
    // thing offline tests cannot answer: outputAudioTranscription lags the
    // audio it describes, audioOut paces that audio out over real time, and
    // whether the first lag is shorter than the second decides whether there
    // was ever anything to cut. Measured per leak rather than assumed, and
    // the two outcomes get separate counters so "we cut it" and "we were too
    // late" never collapse into one number.
    const cutWindowMs = Math.round((audioOut?.aiAudioPlayingUntil() ?? 0) - atMs);
    const cut = cutWindowMs > 0;
    bumpCounter(cut ? "live_outbound_cuts" : "live_outbound_cut_missed");
    // The matched NAME only, never the transcript. What the assistant says
    // carries the caller's own details back to them -- their number, their
    // name, their appointment -- so the text of a leak is PHI even though the
    // thing that leaked is ours.
    log.error("live_outbound_leak", {
      callSid,
      matched: verdict.matched,
      cut_window_ms: cutWindowMs,
      cut,
      severity: "warn",
    });

    if (cut) clearAudio(atMs, { fadeMs: 0 });

    try {
      session?.sendClientContent({
        turns: [{ role: "user", parts: [{ text: LEAK_RECOVERY_NOTE }] }],
        turnComplete: true,
      });
      bumpCounter("live_outbound_reasks");
    } catch (err) {
      log.error("live_leak_recovery_failed", { callSid, reason: err?.message, severity: "warn" });
    }
  }

  // -----------------------------------------------------------------------
  // Inbound: Twilio -> gate -> Gemini
  // -----------------------------------------------------------------------

  function sendAudio(mulawFrame) {
    if (!session || closed) return;
    try {
      session.sendRealtimeInput({
        audio: {
          data: mulaw8kToPcm16k(mulawFrame).toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      });
    } catch (err) {
      log.error("live_send_audio_failed", { callSid, reason: err?.message, severity: "warn" });
    }
  }

  /**
   * activityStart / activityEnd, sent only by an arm that owns endpointing.
   *
   * LATCHED. Two callers can decide a turn has opened on the same frame -- a
   * confirmed barge and the strategy's own verdict -- and the Live API rejects
   * a second activityStart on an already-open activity. That surfaces as an
   * onerror or a session close in the middle of a call, which reads as a
   * vendor problem rather than as an ordering bug of ours.
   *
   * The latch lives here rather than at either call site so a third caller
   * cannot reintroduce it.
   */
  let activityOpen = false;
  function signal(kind) {
    if (!session || closed || !strategy.manual) return;
    const start = kind === "start";
    if (start === activityOpen) return;
    activityOpen = start;
    try {
      session.sendRealtimeInput(start ? { activityStart: {} } : { activityEnd: {} });
    } catch (err) {
      log.error("live_activity_signal_failed", { callSid, kind, reason: err?.message, severity: "warn" });
    }
  }

  function onMediaFrame(mulawFrame, atMs) {
    const v = vad.processFrame(mulawFrame, atMs);
    if (v.voiced) lastVoicedMs = atMs;

    const playing = isPlaying();
    summary.recordInbound({ rms: v.rms, playing });

    // Recorded in every arm, acted on only where the gate opens. It is what
    // tells a genuine interruption from the vendor cutting itself off on our
    // own output -- two things that look identical in an `interrupted` alone.
    const voicedRunMs = vad.voicedRunMs(atMs);
    if (playing && v.voiceActive && voicedRunMs >= 300) lastBargeAt = atMs;

    const { forward, barge } = gate.push({
      frame: mulawFrame,
      playing,
      isActive: v.voiceActive,
      voicedRunMs,
    });

    if (barge) {
      summary.recordBarge();
      clearAudio(atMs);
      // The caller is talking over us. Whichever arm is running, the turn is
      // open from here.
      signal("start");
    }

    for (const frame of forward) sendAudio(frame);

    // The strategy sees EVERY frame, but a withheld frame is not caller voice.
    //
    // Two failures sit either side of this line. Passing withheld frames
    // through as voiced lets a manual arm bracket activityStart/activityEnd
    // around audio Gemini never received. Skipping onFrame entirely -- the
    // previous fix -- starves the strategy of the clock: `lastVoicedMs` goes
    // stale across a four-second reply, and the first frame after playback
    // reads as a four-second caller pause and closes a turn nobody took,
    // inflating callerTurnCount (one of the four ways end_call unlocks) and
    // writing a fabricated latency sample into the one number the vendor arm
    // exists to produce.
    //
    // Reporting withheld frames as unvoiced gets both: time advances, the
    // caller's turn ends naturally while we speak, and nothing opens a turn on
    // audio the model cannot hear.
    const forwarded = forward.length > 0;
    const verdict =
      strategy.onFrame({
        voiced: forwarded && v.voiced,
        isActive: forwarded && v.voiceActive,
        atMs,
      }) || {};
    if (verdict.open) {
      // A new caller turn. Flush anything the previous model turn left
      // unapplied -- a turn that never received turnComplete would otherwise
      // strand its effects and its history entry forever.
      if (!turnApplied && (turnReplyText || turnUserText)) applyTurn();
      turnApplied = false;
      signal("start");
    }
    if (verdict.close) {
      speechEndAt = atMs;
      awaitingFirstAudio = true;
      awaitingTranscript = true;
      callerTurnCount += 1;
      summary.recordTurn();
      if (verdict.shape) summary.recordHoldShape(verdict.shape);
      signal("end");
    }
  }

  // -----------------------------------------------------------------------
  // Outbound: Gemini -> Twilio
  // -----------------------------------------------------------------------

  function onModelAudio(pcm24kBase64) {
    if (!audioOut) return;
    const mulaw = downsampler.process(Buffer.from(pcm24kBase64, "base64"));
    // Only whole frames reach audioOut. It pads a short final frame with
    // silence, which is right at the end of an utterance and wrong in the
    // middle of one: Gemini's chunk sizes have no relationship to 160 bytes,
    // so padding every chunk would insert a silence gap per chunk.
    for (const frame of framer.push(mulaw)) {
      audioOut.enqueue(frame);
      hasEnqueuedAudio = true;
    }

    if (!modelSpeaking) {
      modelSpeaking = true;
      if (lastVoicedMs > 0) summary.recordReplyAfterLastVoice(now() - lastVoicedMs);
    }
    if (awaitingFirstAudio && speechEndAt !== null) {
      summary.recordFirstAudio(now() - speechEndAt);
      awaitingFirstAudio = false;
    }
  }

  async function onToolCall(toolCall) {
    if (!runner || !session) return;
    const out = await runner.handleToolCall(toolCall);

    // Held for the reducer rather than applied here. applyReplyState orders
    // these deliberately -- intent first, then effects (so a completed action
    // wins the step over an intent change in the same turn), then end_call
    // last so it wins over everything -- and reimplementing that ordering is
    // how two drivers drift.
    if (out.intentArgs) pendingIntentArgs = out.intentArgs;
    if (out.endCallArgs) {
      pendingEndCallArgs = out.endCallArgs;
      endCallArmed = true;
    }
    if (out.capabilityEffects?.length) pendingCapabilityEffects.push(...out.capabilityEffects);
    if (out.transferRequested) pendingTransfer = out.transferRequested;

    try {
      session.sendToolResponse({ functionResponses: out.functionResponses });
    } catch (err) {
      log.error("live_tool_response_failed", { callSid, reason: err?.message, severity: "warn" });
    }
  }

  function onServerContent(sc, atMs) {
    // EVERY audio part, not just the first. `.find()` silently dropped the rest
    // of a multi-part turn, which is audio the caller simply never hears.
    //
    // Counted, because the owner has now reported the assistant repeating
    // itself on two separate calls and the cause is not established. If Gemini
    // ever sends a CUMULATIVE parts array -- message N carrying everything from
    // message N-1 as well -- then playing every part duplicates audio, and this
    // loop would be making it worse rather than better. `parts` above 1 on many
    // messages is the signature to look for.
    const audioParts = (sc.modelTurn?.parts || []).filter((p) => p.inlineData?.data);
    if (audioParts.length > 1) {
      log.info("live_multipart_audio", { callSid, parts: audioParts.length });
    }
    for (const part of audioParts) onModelAudio(part.inlineData.data);

    // What we said. echoGuard needs it to recognise our own words coming back,
    // and this is the half backlog LVX1 said did not exist under S2S: with
    // outputAudioTranscription it does.
    if (sc.outputTranscription?.text) {
      echoGuard.noteSpoken(sc.outputTranscription.text, atMs);
      // What the assistant actually said, accumulated for the reducer. The
      // spelling cap counts asks by matching this text against
      // strings.spellRequestRe, so a turn whose reply text never reaches the
      // reducer is a turn whose ask is never counted.
      inspectOutbound(sc.outputTranscription.text, atMs);
      turnReplyText += sc.outputTranscription.text;
    }

    if (sc.inputTranscription?.text) {
      if (awaitingTranscript && speechEndAt !== null) {
        summary.recordTranscriptLag(atMs - speechEndAt);
        awaitingTranscript = false;
      }
      // Content-side echo defence, and the verdict GATES rather than merely
      // being logged. Measured transcript lag of 113-360 ms is what makes it
      // usable at all; the timing half was never in doubt, the text was.
      //
      // On a speakerphone our own reply comes back through
      // inputAudioTranscription. Letting it through means arm C prices the
      // caller's turn end from words the caller never said, and the reducer is
      // told the caller uttered our own sentence -- which then lands in the
      // history the model reads next turn.
      //
      // An `else`, NOT a `return`. One serverContent can carry an echoed
      // transcript AND turnComplete, and returning here skipped the reducer,
      // the capability effects and the armed hang-up for that whole message --
      // so a goodbye that echoed back off a speakerphone left the line open.
      const verdict = echoGuard.classify(sc.inputTranscription.text, atMs);
      if (verdict.isEcho) {
        log.info("live_echo_suppressed", { callSid, reason: verdict.reason, ratio: verdict.ratio });
        bumpCounter("echo_suppressed_final");
      } else {
        // The caller's own words feed the reducer and price the turn end.
        applyCallerSpellingSignal(state, sc.inputTranscription.text, getStrings(state.config));
        turnUserText += sc.inputTranscription.text;
        strategy.onTranscript({ text: sc.inputTranscription.text, atMs });
      }
    }

    if (sc.generationComplete || sc.turnComplete) {
      modelSpeaking = false;
      // Gemini emits generationComplete and turnComplete as SEPARATE messages,
      // and outputAudioTranscription lags the audio it describes. A trailing
      // chunk landing between them made the second fold non-empty: two model
      // entries in history for one spoken turn, and one spelling question
      // counted twice against its own cap.
      // Folded on turnComplete ONLY. Gemini emits generationComplete first and
      // outputAudioTranscription lags the audio it describes, so a trailing
      // chunk lands between them -- folding on both put two model entries in
      // history for one spoken turn and counted one spelling question twice
      // against its own cap.
      //
      // A turn that never receives turnComplete is flushed when the next
      // caller turn opens, so nothing is stranded if the vendor omits it.
      if (!sc.turnComplete) return;
      turnApplied = true;
      const transfer = pendingTransfer;
      applyTurn();
      // ARMED, not executed. The model has finished GENERATING; the caller has
      // not finished HEARING. audioOut paces frames to Twilio and holds the
      // rest locally, so acting now would discard most of what was just said --
      // which is exactly what the previous version did while its comment
      // claimed otherwise.
      if (transfer && transferAllowed()) {
        pendingTransfer = null;
        armExit("transfer", transferNumber());
      } else if (endCallArmed) {
        armExit("end_call");
      }
    }

    if (sc.interrupted) {
      modelSpeaking = false;
      summary.recordInterrupted({ corroborated: atMs - lastBargeAt < 1500 });
      // An interrupted turn never receives generationComplete, so applyTurn
      // never runs for it and the half-spoken reply would otherwise be
      // concatenated onto the NEXT turn -- pushed into history as words said
      // then, and re-tested against spellRequestRe, burning the caller's
      // three-ask budget on one question.
      turnReplyText = "";
      turnUserText = "";
      turnApplied = false;
      leakHandledThisTurn = false;
      // The vendor has decided the caller interrupted and has stopped
      // generating. Everything already queued is an abandoned reply, and
      // audioOut holds most of it locally -- without this it keeps draining
      // out on top of the caller for as long as it takes to play.
      //
      // The local barge path does exactly this. This one is reached when the
      // vendor's detector fires on speech ours read as nothing, which the
      // summary's interrupted_without_local_barge counter exists to count, so
      // the divergence is expected rather than exceptional.
      clearAudio(atMs);
    }
  }

  /**
   * How long to wait for a playback mark before acting anyway.
   *
   * A mark that never comes back must not hold a line open forever: the caller
   * has already been said goodbye to, or told they are being put through, and
   * is listening to nothing while we wait.
   */
  const EXIT_FALLBACK_MS = Number.isFinite(exitFallbackMs) ? exitFallbackMs : 15_000;

  /**
   * Queue an exit behind the audio that is already on its way to the caller.
   *
   * @param {"end_call"|"transfer"} kind
   * @param {string|null} [number] - transfer target
   */
  function armExit(kind, number = null) {
    if (pendingExit || closed) return;
    const mark = `live-exit-${kind}`;
    pendingExit = { kind, mark, number };
    try {
      audioOut?.sendMark(mark);
    } catch (err) {
      log.error("live_exit_mark_failed", { callSid, kind, reason: err?.message, severity: "warn" });
    }
    log.info("live_exit_armed", { callSid, kind, mark });
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => runExit("fallback_timeout"), EXIT_FALLBACK_MS);
    exitTimer.unref?.();
  }

  /** Fire the armed exit exactly once, whether by mark or by backstop. */
  function runExit(trigger) {
    if (!pendingExit) return;
    const { kind, number } = pendingExit;
    // `mark` means the goodbye reached the caller. `fallback_timeout` means it
    // did not and we waited out the backstop -- the difference between a clean
    // hang-up and fifteen seconds of dead air, and it is invisible otherwise.
    log.info("live_exit_run", { callSid, kind, trigger });
    pendingExit = null;
    clearTimeout(exitTimer);
    exitTimer = null;

    if (kind === "transfer") {
      redialForTransfer(number, trigger).catch((err) => {
        log.error("live_transfer_failed", { callSid, reason: err?.message });
        captureException(err, { callSid });
        finish("transfer_failed");
      });
      return;
    }
    finish(`end_call_${trigger}`);
  }

  /**
   * Hand the call to a human, the same way the cascade does: replace the live
   * call's TwiML with a <Dial>.
   *
   * ringTone forces Twilio-generated ringback so the caller hears ringing even
   * when the downstream carrier supplies no early media; callerId presents the
   * original caller's number to the transfer target.
   */
  async function redialForTransfer(transferNumber, trigger) {
    if (!transferNumber) {
      finish("transfer_no_number");
      return;
    }
    const client =
      twilioClient ||
      (await import("twilio")).default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const callerIdAttr = state.callerNumber ? ` callerId="${escapeXml(state.callerNumber)}"` : "";
    await client.calls(callSid).update({
      // Resolved per business, as the cascade does. Hardcoding "uk" was right
      // for the tenant in front of me and would have given every US business a
      // British ringback -- which is exactly why it would have survived.
      twiml: `<Response><Dial ringTone="${resolveRingTone(state.config)}"${callerIdAttr}>${escapeXml(transferNumber)}</Dial></Response>`,
    });
    log.info("live_transfer_outcome", { callSid, success: true, trigger });
    // SCOPED, like every other write on both front-ends. Under FORCE RLS an
    // unscoped UPDATE matches zero rows and reports no error, so a swallowed
    // failure here leaves a transferred call marked as still in progress with
    // nothing to show for it -- the shape capabilities/messages.js documents
    // from a real call.
    if (state.businessId && database.withTenantSafe) {
      database
        .withTenantSafe(state.businessId, () => database.markCallTransferred?.(callSid), {
          operation: "liveMarkCallTransferred",
          callSid,
          fallback: null,
        })
        .catch((err) => log.error("live_mark_transferred_failed", { callSid, reason: err?.message }));
    }
    finish("transferred");
  }

  // -----------------------------------------------------------------------
  // Twilio socket
  // -----------------------------------------------------------------------

  async function onStart(startData) {
    callSid = startData.callSid;
    // The upgrade proved the caller holds a token minted by the voice webhook;
    // this proves they are using it for the call it was minted for. Without
    // it, one valid token authorises a session against a tenant of the
    // sender's choosing, because businessPhone arrives right below.
    if (ws.authorizedCallSid && ws.authorizedCallSid !== callSid) {
      log.error("live_stream_callsid_mismatch", {
        authorizedCallSid: ws.authorizedCallSid,
        claimedCallSid: callSid,
      });
      ws.close(1008, "call sid does not match token");
      return;
    }

    const custom = startData.customParameters || {};
    const businessPhone = env.LIVE_BUSINESS_PHONE || custom.businessPhone || "";
    const callerPhone = custom.callerPhone || "";

    log.info("live_stream_start", {
      callSid,
      streamSid: startData.streamSid,
      businessPhone,
      arm: strategy.name,
    });

    // Guarded. The webhook already resolved this row and deliberately treats a
    // throw as "carry on, the socket retries" -- so an unguarded rejection here
    // reaches the .catch on onStart, calls finish("start_failed"), and
    // disconnects the caller, undoing the very guarantee the webhook makes.
    // Staged timings, because warming the module graph at boot did NOT move the
    // 2.3 s cold start (measured 2,362 ms after the warm-up landed, against
    // 2,302 ms before it). The cost is somewhere else and guessing at it once
    // was already wrong, so each stage is now reported separately.
    const tStart = now();
    let tLookup = 0;
    let tContext = 0;

    let business = null;
    if (database.isEnabled()) {
      try {
        business = await database.lookupBusinessByPhone(businessPhone);
      } catch (err) {
        log.error("live_business_lookup_failed", { callSid, reason: err?.message, severity: "warn" });
      }
      if (!business) log.error("live_no_business_found", { callSid, businessPhone, severity: "warn" });
    }
    tLookup = now() - tStart;
    const config = database.loadConfig(business);
    state.config = config;
    state.businessId = business?.id || null;
    state.callerNumber = callerPhone;
    state.twilioNumber = businessPhone;

    const extras = {
      integrations: [],
      // Never fetched at all before the review: the KNOWLEDGE BASE section of
      // the prompt was absent on every Live call, so the assistant could
      // answer no FAQ.
      knowledge: [],
      businessId: business?.id || null,
      callerPhone,
      callId: null,
      callerContext: null,
      // services/gemini.js reads this to decide whether the prompt carries
      // transfer language at all. Unset defaults to true, which would offer a
      // transfer to a business whose policy forbids it.
      transferAllowed: Boolean(config?.transferPhoneNumber || process.env.TRANSFER_NUMBER) && resolveTransferAllowed(config),
      // No TTS leg on this path: the model IS the voice, so nothing has been
      // said when the session opens. Without this the prompt asserts the
      // caller was already greeted while the kick-off message asks for a
      // greeting -- and the business's own greeting, including any recording
      // disclosure, is never spoken at all.
      greetingSpoken: false,
    };

    // AWAITED, and that is a deliberate reversal of the cascade's fast-pickup
    // shape.
    //
    // The cascade can defer this because it speaks a greeting over TTS while
    // the context loads, then awaits it before turn 1. A Live session cannot:
    // the tool DECLARATIONS and the system prompt are fixed at connect and
    // there is no way to add a tool to a session already in progress. Firing
    // this without awaiting it -- which is what the first version did -- meant
    // extras.integrations was ALWAYS empty by the time the declarations were
    // built, so every webhook and EHR tool was missing from every call, and
    // guards.js never armed for an EHR business.
    //
    // The cost is one round trip before the caller hears anything. The
    // alternative is a receptionist that cannot answer an FAQ or use the
    // business's own integrations, which is worse than being slightly slower
    // to speak.
    if (business && database.isEnabled()) {
      const [callRes, integrationsRes, knowledgeRes, callerRes] = await database.withTenantSafe(
        business.id,
        () =>
          Promise.allSettled([
            database.createCall(business.id, callSid, callerPhone, businessPhone),
            database.listIntegrationsForBusiness(business.id, { enabledOnly: true }),
            database.fetchBusinessKnowledge(business.id),
            callerPhone ? database.fetchCallerContext(business.id, callerPhone) : Promise.resolve(null),
          ]),
        {
          operation: "liveSessionContext",
          callSid,
          // The shape allSettled would have produced, so losing the scope
          // itself does not also throw.
          fallback: [{ status: "rejected" }, { status: "rejected" }, { status: "rejected" }, { status: "rejected" }],
        }
      );

      if (callRes.status === "fulfilled" && callRes.value) {
        extras.callId = callRes.value;
        state.dbCallId = callRes.value;
      }
      extras.integrations = integrationsRes.status === "fulfilled" ? integrationsRes.value || [] : [];
      extras.knowledge = knowledgeRes.status === "fulfilled" ? knowledgeRes.value || [] : [];
      extras.callerContext = callerRes.status === "fulfilled" ? callerRes.value : null;
      state.callerContext = extras.callerContext;

      for (const [what, res] of [
        ["create_call", callRes],
        ["integrations", integrationsRes],
        ["knowledge", knowledgeRes],
        ["caller_context", callerRes],
      ]) {
        if (res.status === "rejected") {
          log.error("live_context_load_failed", { callSid, part: what, reason: res.reason?.message });
        }
      }
    }

    // Test seam, same reasoning as ws.liveState: the pacing queue is otherwise
    // only observable through Twilio, and a path that fails to drop it looks
    // exactly like one that does.
    tContext = now() - tStart - tLookup;

    audioOut = createAudioOut({
      streamSid: startData.streamSid,
      now,
      sendFrame: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    });

    ws.liveAudioOut = audioOut;
    liveExtras = extras;
    runner = createToolRunner({ config, extras, turnState, ...(execute ? { execute } : {}) });

    // The same shape lib/voice/session.js's leakCtx() builds, from the same
    // two exports, so both front-ends judge a leak against the identical
    // vocabulary -- including this business's own webhook tools, which are
    // in `extras.integrations` and are as leakable as the built-in ones.
    leakGuard = createLeakGuard({
      toolNames: callToolNames(config, extras),
      toolParamNames: callToolParamNames(config, extras),
      fallback: getStrings(config).actionNotCompleted,
    });

    // The PRODUCTION prompt, not a ten-line stand-in. That difference is the
    // whole reason backlog LVX4 -- the assistant refusing to read a caller's
    // phone number back -- is testable here and was not testable in the spike.
    const systemInstruction = buildSystemInstruction(state.step, state.intent, config, extras);

    const config_ = {
      responseModalities: ["AUDIO"],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: buildLiveTools(config, extras),
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
        languageCode: LANGUAGE_CODE,
      },
      ...strategy.connectConfig(),
    };

    const tConnect = now();
    try {
      const connected = await connect({
        env,
        config: config_,
        callbacks: {
          onmessage: (msg) => {
            try {
              if (msg.usageMetadata) summary.recordUsage(msg.usageMetadata);
              // AWAITED via .catch, not fire-and-forget. onToolCall is async
              // and the try/catch around this handler only covers synchronous
              // throws -- everything after the first await inside it rejected
              // into nothing, which on Node's default policy terminates the
              // process and takes every other in-flight call with it.
              if (msg.toolCall) {
                onToolCall(msg.toolCall).catch((err) => {
                  log.error("live_tool_call_failed", { callSid, reason: err?.message, severity: "warn" });
                });
              }
              if (msg.serverContent) onServerContent(msg.serverContent, now());
            } catch (err) {
              log.error("live_message_handler_failed", { callSid, reason: err?.message, severity: "warn" });
            }
          },
          onerror: (e) => log.error("live_session_error", { callSid, reason: e?.message || String(e) }),
          onclose: (e) => summary.recordClose(e?.reason || null),
        },
      });
      session = connected.session;
      log.info("live_open_timings", {
        callSid,
        lookup_ms: Math.round(tLookup),
        context_ms: Math.round(tContext),
        connect_ms: Math.round(now() - tConnect),
        total_ms: Math.round(now() - tStart),
      });
      summary.recordLanguagePinned(connected.languagePinned);
      log.info("live_session_open", {
        callSid,
        arm: strategy.name,
        model: connected.model,
        surface: connected.surface,
        language_pinned: connected.languagePinned,
      });
    } catch (err) {
      log.error("live_connect_failed", { callSid, reason: err?.message });
      finish("connect_failed");
      return;
    }

    // Nothing happens until the model is told a turn occurred, in either arm.
    // Sent here and not at connect time because there is nowhere to play a
    // greeting until audioOut exists.
    try {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: "(The caller has just connected. Open the call now.)" }] }],
        turnComplete: true,
      });
      speechEndAt = now();
      awaitingFirstAudio = true;
    } catch (err) {
      log.error("live_greeting_kick_failed", { callSid, reason: err?.message });
    }
  }

  function finish(reason) {
    if (closed) return;
    closed = true;

    // A deferred effect the caller was already told about must not be lost
    // because the line dropped first. capabilities/messages.js answers
    // immediately and writes in onEffect, so a message promised on the last
    // turn of a call has its write pending right here -- and "we'll pass that
    // on" followed by no row is the same failure as having no dispatcher at
    // all, just rarer and harder to notice.
    if (pendingCapabilityEffects.length) {
      try {
        dispatchEffects(pendingCapabilityEffects);
      } catch (err) {
        log.error("live_pending_effects_failed", { callSid, reason: err?.message, severity: "warn" });
      }
      pendingCapabilityEffects = [];
    }

    clearTimeout(exitTimer);
    exitTimer = null;
    pendingExit = null;
    audioOut?.stop();
    try {
      session?.close();
    } catch {
      /* already gone */
    }
    const record = summary.build();
    log.info("live_call_summary", {
      callSid,
      durationMs: Math.round(now() - t0),
      guards: runner?.guards?.counts() || null,
      ...record,
      // AFTER the spread, not before. `...record` carries its own
      // `close_reason` (the vendor's, usually null) and was overwriting the
      // computed one, so HOW a call ended -- mark, backstop, caller hang-up,
      // connect failure -- was never reported on any call. Found on the first
      // real call, where it was the one question the log could not answer.
      close_reason: record.close_reason || reason || null,
    });
    try {
      if (ws.readyState === ws.OPEN) ws.close();
    } catch {
      /* already gone */
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === "start") {
      onStart(msg.start || {}).catch((err) => {
        log.error("live_start_failed", { callSid, reason: err?.message });
        finish("start_failed");
      });
      return;
    }
    if (msg.event === "media" && msg.media?.payload) {
      onMediaFrame(Buffer.from(msg.media.payload, "base64"), now());
      return;
    }
    if (msg.event === "mark" && msg.mark?.name) {
      audioOut?.notifyMarkPlayed(msg.mark.name);
      // The handler that existed and was never reachable, because nothing ever
      // sent a mark.
      if (pendingExit && msg.mark.name === pendingExit.mark) runExit("mark");
      return;
    }
    if (msg.event === "stop") finish("twilio_stop");
  });

  ws.on("close", () => finish("ws_close"));
  ws.on("error", (err) => {
    log.error("live_ws_error", { callSid, reason: err?.message });
    finish("ws_error");
  });
}
