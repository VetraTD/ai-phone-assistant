import { performance } from "node:perf_hooks";

import * as db from "../../../services/db.js";
import { buildSystemInstruction } from "../../../services/gemini.js";
import { STEPS } from "../../callState.js";
import { resolveTransferAllowed } from "../session.js";
import { applyReplyState, spellingSettled } from "../replyState.js";
import {
  dispatchCapabilityEffects,
  mergeCapabilityState as mergeCapabilityStateInto,
} from "../../capabilities/effects.js";
import { getStrings } from "../strings.js";
import * as notifications from "../../../services/notifications.js";
import { captureException } from "../../sentry.js";
import { log } from "../../logger.js";
import { createVad } from "../inboundVad.js";
import { createAudioOut } from "../audioOut.js";
import { createEchoGuard } from "../echoGuard.js";
import { createDownsampler, mulaw8kToPcm16k, createFramer } from "../resample.js";
import { connectLive, liveSurface, LIVE_MODEL_DEFAULT } from "./client.js";
import { buildLiveTools, createToolRunner } from "./tools.js";
import { createHalfDuplexGate } from "./halfDuplex.js";
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
    step: STEPS.GREETING,
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
  let pendingIntentArgs = null;
  let pendingEndCallArgs = null;
  let pendingCapabilityEffects = [];
  let pendingTransfer = null;
  let callerTurnCount = 0;
  let lastVoicedMs = 0;
  let speechEndAt = null;
  let awaitingFirstAudio = false;
  let awaitingTranscript = false;
  let modelSpeaking = false;
  let lastBargeAt = -Infinity;
  let endCallArmed = false;

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

  /** Whether this business permits a transfer right now. */
  function transferAllowed() {
    return state.config ? resolveTransferAllowed(state.config) : false;
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
    } catch (err) {
      log.error("live_reply_state_failed", { callSid, reason: err?.message, severity: "warn" });
    }
    pendingIntentArgs = null;
    pendingEndCallArgs = null;
    pendingCapabilityEffects = [];
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

  /** activityStart / activityEnd, sent only by an arm that owns endpointing. */
  function signal(kind) {
    if (!session || closed || !strategy.manual) return;
    try {
      session.sendRealtimeInput(kind === "start" ? { activityStart: {} } : { activityEnd: {} });
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
      audioOut?.clear({ fadeMs: 120 });
      echoGuard.noteAudioStopped(atMs);
      // The caller is talking over us. Whichever arm is running, the turn is
      // open from here.
      signal("start");
    }

    for (const frame of forward) sendAudio(frame);

    const verdict = strategy.onFrame({ voiced: v.voiced, isActive: v.voiceActive, atMs }) || {};
    if (verdict.open) signal("start");
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
    const audioPart = sc.modelTurn?.parts?.find((p) => p.inlineData?.data);
    if (audioPart) onModelAudio(audioPart.inlineData.data);

    // What we said. echoGuard needs it to recognise our own words coming back,
    // and this is the half backlog LVX1 said did not exist under S2S: with
    // outputAudioTranscription it does.
    if (sc.outputTranscription?.text) {
      echoGuard.noteSpoken(sc.outputTranscription.text, atMs);
      // What the assistant actually said, accumulated for the reducer. The
      // spelling cap counts asks by matching this text against
      // strings.spellRequestRe, so a turn whose reply text never reaches the
      // reducer is a turn whose ask is never counted.
      turnReplyText += sc.outputTranscription.text;
    }

    if (sc.inputTranscription?.text) {
      if (awaitingTranscript && speechEndAt !== null) {
        summary.recordTranscriptLag(atMs - speechEndAt);
        awaitingTranscript = false;
      }
      // Content-side echo defence. Measured lag of 113-360 ms is what makes it
      // usable at all; the timing half was never in doubt, the text was.
      const verdict = echoGuard.classify(sc.inputTranscription.text, atMs);
      if (verdict.isEcho) {
        log.info("live_echo_suppressed", { callSid, reason: verdict.reason, ratio: verdict.ratio });
      }
      turnUserText += sc.inputTranscription.text;
      strategy.onTranscript({ text: sc.inputTranscription.text, atMs });
    }

    if (sc.generationComplete || sc.turnComplete) {
      modelSpeaking = false;
      applyTurn();
      // Hang up only after the goodbye has actually been spoken. Closing on
      // the tool call would cut the model off mid-sentence, which is the
      // failure the cascade's own end_call path is shaped around.
      if (endCallArmed) finish("end_call");
    }

    if (sc.interrupted) {
      modelSpeaking = false;
      summary.recordInterrupted({ corroborated: atMs - lastBargeAt < 1500 });
    }
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

    let business = null;
    if (database.isEnabled()) {
      business = await database.lookupBusinessByPhone(businessPhone);
      if (!business) log.error("live_no_business_found", { callSid, businessPhone, severity: "warn" });
    }
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
      transferAllowed: resolveTransferAllowed(config),
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

    audioOut = createAudioOut({
      streamSid: startData.streamSid,
      now,
      sendFrame: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    });

    runner = createToolRunner({ config, extras, turnState, ...(execute ? { execute } : {}) });

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

    try {
      const connected = await connect({
        env,
        config: config_,
        callbacks: {
          onmessage: (msg) => {
            try {
              if (msg.usageMetadata) summary.recordUsage(msg.usageMetadata);
              if (msg.toolCall) onToolCall(msg.toolCall);
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
      close_reason: record.close_reason || reason || null,
      guards: runner?.guards?.counts() || null,
      ...record,
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
