import { performance } from "node:perf_hooks";

import * as db from "../../../services/db.js";
import {
  ACTION_TOOL_NAMES,
  buildSystemInstruction,
  callToolNames,
  callToolParamNames,
  promisedAction,
} from "../../../services/gemini.js";
import { STEPS } from "../../callState.js";
import {
  resolveTransferAllowed,
  buildSilenceNudge,
  buildSilenceGoodbye,
  SILENCE_THRESHOLDS,
  SILENCE_THRESHOLDS_DEFAULT,
} from "../session.js";
import { applyReplyState, spellingSettled, applyCallerSpellingSignal } from "../replyState.js";
import {
  dispatchCapabilityEffects,
  mergeCapabilityState as mergeCapabilityStateInto,
} from "../../capabilities/effects.js";
import { getStrings } from "../strings.js";
import { resolveRingTone } from "../voiceLocale.js";
import { postCallMode, verifyCall } from "../../postCallVerify.js";
import * as notifications from "../../../services/notifications.js";
import { captureException } from "../../sentry.js";
import { escapeXml } from "../../twiml.js";
import { log } from "../../logger.js";
import { bumpCounter } from "../metrics.js";
import { isUnusableTranscript } from "../../transcriptUtils.js";
import { createVad } from "../inboundVad.js";
import { createAudioOut } from "../audioOut.js";
import { createEchoGuard } from "../echoGuard.js";
import { createDownsampler, mulaw8kToPcm16k, createFramer } from "../resample.js";
import { connectLive, createLiveClient, liveSurface, LIVE_MODEL_DEFAULT } from "./client.js";
import { buildLiveTools, createToolRunner } from "./tools.js";
import { createHalfDuplexGate } from "./halfDuplex.js";
import { createLeakGuard, buildLeakNote } from "./leakGuard.js";
import { IS_HIPAA_MODE } from "../../deploymentMode.js";
import { buildMinimalInstruction } from "./minimalPrompt.js";
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
// The cascade is the mature path and it is tier 3, the last thing standing
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

/**
 * Told to the model when it promised the caller an action and called nothing.
 *
 * The cascade re-prompts with `toolConfig: { mode: "ANY" }` and the model must
 * call something. Here it is a request, so the wording is direct about what
 * happened rather than polite about it.
 */
const PROMISE_NOTE =
  "(System: you told the caller you were about to do something - check, look " +
  "up, or update - but you did not call any tool. The caller is waiting on a " +
  "result. Either call the tool you need now, or tell them plainly that you " +
  "cannot do it and offer to take their details.)";

/**
 * Told to the model when a tool ran and it said nothing at all.
 *
 * On the cascade a zero-text turn is filled by a fixed line read through TTS.
 * There is no TTS leg here, so silence can only be broken by the model.
 */
/**
 * Told to the model when it claimed an action it never took.
 *
 * Deliberately does NOT say "do it now". A claim can legitimately trail the
 * tool that backs it by a turn, and a guard that reacts to that by demanding
 * action produces a second, different booking -- LVX22 with extra steps. This
 * asks it to check and to correct itself to the caller, which is safe whether
 * the claim was true or not.
 */
const CLAIM_NOTE =
  "(System: you have just told the caller that something is done - booked, " +
  "cancelled, rescheduled or noted - but no tool has run to make it so. If it " +
  "genuinely has not happened, tell the caller plainly that it has not gone " +
  "through yet and then do it properly. Do not repeat the claim.)";

/**
 * Told to the model when it offered times nothing had verified.
 *
 * Like CLAIM_NOTE, it does not say "book it anyway" -- it says stop offering
 * and go and look. The caller has not committed yet, so the safe correction is
 * to check before they do.
 */
const OFFER_NOTE =
  "(System: you have just offered the caller specific appointment times, but " +
  "no availability check has been run on this call, so those times are not " +
  "known to be free. Call the availability tool now and offer only what it " +
  "returns. Do not repeat the times you just gave.)";

const ZERO_TEXT_NOTE =
  "(System: you called a tool and it returned, but you said nothing to the " +
  "caller, who is listening to silence. Tell them briefly what happened in " +
  "plain language.)";

/**
 * Told to the model when it answered a REFUSED write by offering a callback.
 *
 * LVX34. The spelling gate refused a booking and told the model, in words, to
 * ask the caller to spell their name and wait for the answer. The model told
 * the caller someone would ring them back -- twice -- and only asked for the
 * spelling when the caller pushed. A refusal is an instruction, and it was read
 * as a failure.
 *
 * Deliberately does NOT say "call the tool again". The refusal it followed
 * already said what to do, and a note that competes with it is how a guard
 * starts a loop -- see LVX21, where a hair-trigger leak guard delivered half a
 * second of audio in twenty-five. This points the model back at the instruction
 * it was already given.
 */
/**
 * Told to the model when the caller has just given their name and it did not
 * ask for the spelling.
 *
 * The prompt ALREADY instructs this, in as many words -- "when they give you a
 * name you are going to write down, ask them right then, while you are still
 * taking details, to spell it... do not leave it until you are confirming or
 * booking". On a real call on 2026-09-03 the model collected everything, said
 * "that's all confirmed, is there anything else?", heard "no", and only THEN
 * asked for the spelling. The instruction was present and was not followed.
 *
 * A prompt line is a request, never a guarantee. This is the counted nudge that
 * fires in the turn the name arrives, which is the only moment at which asking
 * is not an interruption.
 *
 * At most once per call, like every other note here. The gate in
 * services/tools.js is still the thing that guarantees the spelling before a
 * write -- this only moves WHEN the asking happens.
 */
const SPELLING_NOTE =
  "(System: the caller has just given you their name. Ask them to spell it NOW, " +
  "before you go any further with the booking, and read the letters back. Asking " +
  "later, while you are confirming, means interrupting them after they think you " +
  "are finished.)";

/*
 * The caller's turn did not transcribe as usable speech, and the assistant
 * answered it anyway.
 *
 * An English turn came back as the Korean characters "에레는" and got "Great,
 * 8 AM on Tuesday, September 8th, is available" -- and the call booked from it.
 * Two turns earlier the same caller said "Uh" twice and got sensible clarifying
 * questions, so the model is perfectly capable of asking; it simply did not
 * here. See LVX50.
 *
 * The WRITE is already refused by services/tools.js, which is the half that
 * protects the row. This is the half that protects the conversation: without it
 * the assistant carries on from an invented reading of noise and the caller has
 * to work out what went wrong.
 */
const UNUSABLE_TRANSCRIPT_NOTE =
  "(System: the caller's last turn did not come through as usable speech, so " +
  "you do not actually know what they said. Do not answer it and do not guess " +
  "at what they meant. Tell them you did not catch that and ask them to say it " +
  "again.)";

const DEFERRAL_NOTE =
  "(System: you just told the caller that someone will get back to them, but " +
  "the action they asked for was refused this turn and the refusal told you " +
  "what to do next. Do not take a message or promise a callback instead. Do " +
  "the thing the refusal asked for now, ask the caller for what it needs, and " +
  "wait for their answer.)";

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
    // LVX29's post-call read. Injectable for the same reason `execute` is:
    // asserting that the ledgers reach it should not require a database.
    verify = verifyCall,
  } = deps;

  const t0 = now();

  // A diagnostic, never a setting. Refused outright in hipaa mode -- by the
  // shared constant, which is the authority, and by the injected env, which is
  // what a test can vary. Refusing twice is the safe direction.
  const wantsDebugTranscript = env.LIVE_DEBUG_TRANSCRIPT === "1";
  const hipaa =
    IS_HIPAA_MODE || String(env.DEPLOYMENT_MODE || "").trim().toLowerCase() === "hipaa";
  const debugTranscriptOn = wantsDebugTranscript && !hipaa;
  if (wantsDebugTranscript && hipaa) {
    log.error("live_debug_transcript_refused", {
      reason: "hipaa mode",
      note: "LIVE_DEBUG_TRANSCRIPT records assistant speech, which carries caller details.",
      severity: "warn",
    });
  } else if (debugTranscriptOn) {
    // Loud on purpose. A capture nobody remembers switching on is how this
    // becomes the thing LVX24 was.
    log.error("live_debug_transcript_enabled", {
      note: "Assistant speech is being written to the log. Diagnostic only; never production.",
      severity: "warn",
    });
  }

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
  /**
   * Everything the caller has been transcribed saying on this call.
   *
   * Separate from turnUserText, which applyTurn clears every turn. The
   * name-provenance check needs the whole call: on the LVX53 call the name was
   * lifted from an appointment row several turns after the caller had stopped
   * being intelligible, and a per-turn view cannot answer "did they ever say
   * this?".
   *
   * Capped, in memory only, and NEVER logged or sent anywhere -- it carries the
   * caller name and number that LVX24 was about. The cap keeps a long call from
   * growing this without bound; the earliest turns are the ones a caller is
   * least likely to have first named themselves in, and the gate fails SAFE
   * (it asks) rather than silently trusting a record.
   */
  let callerSaidThisCall = "";
  const CALLER_TRANSCRIPT_CAP = 4000;
  /** Has the current spoken turn already been folded into the reducer? */
  let turnApplied = false;
  let pendingIntentArgs = null;
  let pendingEndCallArgs = null;
  let pendingCapabilityEffects = [];
  /**
   * LVX29. What the call WROTE and what the call CLAIMED, kept for the whole
   * call so the two can be compared against the database once it ends.
   *
   * Both are shapes, never sentences. The claim ledger records that a turn
   * matched the completion-claim predicate, not the text that matched it --
   * LVX24 was exactly this mistake made by a sanitizer that logged its catch,
   * and the assistant's own words on these calls routinely contain the
   * caller's name, number and appointment time.
   */
  const writesThisCall = [];
  const claimsThisCall = [];
  /**
   * Action tools this call REFUSED, and the ones it later completed.
   *
   * A write that was refused, whose refusal the caller then answered, and which
   * was never called again — announced as done regardless. LVX72, from a real
   * call: the name-correction tool was refused pending a spelling, the caller
   * spelled it, and the tool never ran again. The row never moved and the
   * caller was told it had.
   *
   * Names rather than counts, because "something was abandoned" is not
   * actionable and the difference between an abandoned cancellation and an
   * abandoned name change is the whole story. Nothing here is caller data.
   */
  const refusedToolsThisCall = new Set();
  const completedToolsThisCall = new Set();
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

  // ---- turn discipline (handoff section 8) --------------------------------
  //
  // getReplyStreaming bounds its tool rounds, recovers a call written as text,
  // backstops a promise with no action, and never lets a turn end in silence.
  // This path had none of the four. What follows is those four at the Live
  // turn boundary -- not the extraction section 8 asked for, because
  // tests/vertexStreamingPath.test.js asserts on that function's own source
  // text specifically to catch it being moved, and the cascade serves a paying
  // clinic.

  /** Tool-call messages seen in the current model turn. */
  let toolRoundsThisTurn = 0;
  /** Tools that actually executed this turn, so a leak can tell "described" from "called". */
  const calledToolsThisTurn = new Set();
  /** Did any tool really run this turn? Gates the promise and zero-text checks. */
  let realToolCallsThisTurn = 0;
  /**
   * Caller-visible writes REFUSED this turn.
   *
   * Counted separately from the attempts above because they are different
   * facts about the call and the guards need different ones. `realToolCalls`
   * answers "did the model do anything at all"; this answers "did the caller
   * ask for something that did not happen". LVX34 is the second question, and
   * the first cannot express it -- a refused call still increments an attempt.
   */
  let refusedActionCallsThisTurn = 0;
  /**
   * Every refused call this turn, action tool or not.
   *
   * `toolsRanThisTurn()` below is attempts minus these, and that difference is
   * the whole of LVX31: the claim guard used to ask "did the model call
   * anything", when the question it needed answered was "did anything actually
   * happen". A refused call answers yes to the first and no to the second.
   */
  let refusedCallsThisTurn = 0;
  /** Has the spelling nudge been spent on this call? At most one. */
  let spellingNudged = false;
  /**
   * Did any tool actually EXECUTE this turn?
   *
   * Demonstrated on a real call, 2026-09-03: the spelling gate refused a write,
   * the assistant then claimed something was done, the post-call read found no
   * row -- and `live_claim_without_action` stayed 0, because the refused call
   * had counted as an attempt and switched the guard off. The counter that was
   * supposed to say whether acting on this is safe was reading low, in the
   * direction that makes the guard look quieter than it is.
   */
  const toolsRanThisTurn = () => realToolCallsThisTurn - refusedCallsThisTurn > 0;
  /**
   * Did a tool run on the PREVIOUS turn?
   *
   * A claim of completion can legitimately trail the tool that backs it by one
   * turn -- "so that's booked?" / "yes, I've booked it" -- so the claim guard
   * looks back one turn before calling anything a fabrication.
   */
  let toolRanPrevTurn = false;
  /**
   * At most ONE system note per model turn, across every mechanism below.
   *
   * A note provokes a model turn. A model turn can provoke a note. Without a
   * single latch shared by all four, two of them firing on the same turn is a
   * conversation between the guards rather than with the caller.
   */
  let noteSentThisTurn = false;
  /**
   * And at most this many for the whole call. The per-turn latch bounds width;
   * this bounds depth, which is the ping-pong case -- and it is counted rather
   * than silent, because a guard that quietly stops guarding is worse than one
   * that never existed.
   */
  let notesThisCall = 0;
  const MAX_NOTES_PER_CALL = 8;
  /**
   * Tool rounds allowed in one model turn.
   *
   * The cascade's MAX_FC_ROUNDS (services/gemini.js) clamps 1..8 and defaults
   * to 5, and the same number is used here deliberately: two drivers that
   * disagree about how many rounds a turn may take are two drivers that behave
   * differently on the same conversation.
   *
   * The Live loop had no bound at all. Whatever the model asked for, it ran.
   */
  const MAX_TOOL_ROUNDS = (() => {
    const v = Number.parseInt(env.LIVE_MAX_TOOL_ROUNDS, 10);
    return Number.isFinite(v) && v >= 1 && v <= 8 ? v : 5;
  })();

  // ---- the silence ladder (LVX19) -----------------------------------------
  //
  // A call sat for 61 seconds with the caller silent and ended only because
  // they hung up. One who puts the phone down instead leaves the line open to
  // the 30-minute cap, billing Gemini the whole time. The cascade nudges twice
  // and then says goodbye; none of that existed here.
  //
  // No timer, deliberately. Twilio streams media frames during silence too, so
  // onMediaFrame is already a 20 ms clock, and the only setTimeout on this
  // path is the exit backstop.

  /** 0 = quiet is still fine, 1 = nudged once, 2 = twice, 3 = leaving. */
  let silenceStage = 0;
  /**
   * When the CALLER was last heard, or when the ladder armed.
   *
   * Deliberately not reset by our own audio. A nudge is us speaking, and if
   * speaking reset this then every nudge would restart the ladder at the
   * bottom rung and the call would never end. The cascade has the same
   * problem and solves it the same way -- its mark handler skips re-arming for
   * anything named `nudge-`.
   */
  let ladderSince = 0;
  /**
   * Armed only once our own first audio has been queued.
   *
   * live.connect() costs ~2.2 s on EVERY call (LVX17) and the model is the
   * only voice here, so a ladder armed at socket open spends that handshake
   * counting the caller's silence and can nudge someone who has not yet been
   * greeted.
   */
  let ladderArmed = false;
  /** Tool calls in flight. The model is thinking; the caller cannot tell. */
  let pendingToolCalls = 0;
  /** Which rung has already reported a suppression, so it reports once. */
  let suppressionNotedForStage = -1;
  /** Say goodbye, then leave -- armed when that goodbye's turn completes. */
  let exitAfterTurn = false;

  /**
   * Speak a fixed line by asking the model to say it.
   *
   * There is no TTS leg on this path, so a line the CALL wants said -- rather
   * than one the model chose -- can only be spoken by the model. It will
   * sometimes paraphrase, and `nudges_fired` therefore counts attempts. How
   * often it complies is a question only a real call answers.
   *
   * Not routed through sendTurnNote: that rations notes so the guards cannot
   * talk to each other all call, and a hang-up must not be blocked by a budget
   * the leak guard has already spent.
   */
  function speakLine(kind, line) {
    if (!session || closed) return false;
    try {
      session.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                // "and nothing else" was in this line on the first real call,
                // and it is a heavier instruction than it looks: it forbids
                // the model from doing anything on that turn, tool calls
                // included. Arriving after every reply -- which the clock bug
                // above made it do -- it stopped the assistant working at all.
                // Correct timing is the real fix, but the sharp edge goes too:
                // the wording still needs to be the business's own, and that
                // does not require forbidding everything else.
                text:
                  "(System: the caller has gone quiet. Say this to them, word " +
                  'for word: "' +
                  line +
                  '")',
              },
            ],
          },
        ],
        turnComplete: true,
      });
      log.info("live_silence_line", { callSid, kind, stage: silenceStage });
      return true;
    } catch (err) {
      log.error("live_silence_line_failed", { callSid, kind, reason: err?.message, severity: "warn" });
      return false;
    }
  }

  /**
   * One rung of the ladder, judged on every inbound frame.
   *
   * @param {number} atMs
   * @param {boolean} voiced - the caller, per inboundVad, ungated
   * @param {boolean} playing - our own audio is reaching them
   */
  function checkSilence(atMs, voiced, playing) {
    if (!ladderArmed) {
      if (!hasEnqueuedAudio) return;
      ladderArmed = true;
      ladderSince = atMs;
      return;
    }

    if (voiced) {
      // They answered. Back to the bottom rung, and the ladder's clock starts
      // again from here.
      ladderSince = atMs;
      silenceStage = 0;
      suppressionNotedForStage = -1;
      return;
    }

    // OUR OWN VOICE IS NOT THE CALLER'S SILENCE, and the clock has to say so.
    //
    // This reset was missing on the first real call, and it is the whole
    // defect: with the clock running only from the caller's last word, a reply
    // longer than the first threshold left it already past that threshold the
    // moment our audio stopped. The caller heard "I'm still here whenever
    // you're ready" the instant the assistant finished speaking, five times.
    //
    // It also stopped the assistant working at all. A nudge tells the model to
    // say one line "and nothing else", so arriving after every turn it
    // suppressed tool calling entirely -- the caller asked to cancel an
    // appointment and got circles and an offer to take a message, on a session
    // with cancel_appointment_db declared and never once called.
    //
    // The stage is deliberately NOT reset here. Only the caller answering
    // takes the ladder back to the bottom rung; our own speech just restarts
    // the clock for the rung we are on.
    if (playing) {
      ladderSince = atMs;
      return;
    }

    if (silenceStage >= 3 || exitAfterTurn) return;

    const th = SILENCE_THRESHOLDS[state.step] || SILENCE_THRESHOLDS_DEFAULT;
    // DELTAS between rungs, not the absolute thresholds, because `ladderSince`
    // is restarted by each rung's own playback above. This is the same
    // arithmetic as the cascade's armSilenceTimer, which arms each stage with
    // the gap to the next rather than the total from the caller's last word.
    const due = [th.nudge1, th.nudge2 - th.nudge1, th.hangup - th.nudge2][silenceStage];
    if (atMs - ladderSince < due) return;

    // Thinking is not silence, but it sounds identical from the other end.
    // Nudging over an answer that is still being computed is worse than
    // waiting, so the rung holds -- and says once that it held, because a
    // ladder that quietly never fires looks exactly like one that is not
    // there.
    //
    // `modelSpeaking` is deliberately NOT part of this test: it is only
    // cleared on generationComplete, so a vendor that omits one would jam the
    // ladder for the rest of the call.
    if (pendingToolCalls > 0) {
      if (suppressionNotedForStage !== silenceStage) {
        suppressionNotedForStage = silenceStage;
        bumpCounter("nudges_suppressed");
        log.info("live_silence_suppressed", { callSid, stage: silenceStage + 1, reason: "tool_in_flight" });
      }
      return;
    }

    if (silenceStage < 2) {
      const line = buildSilenceNudge(silenceStage + 1, state.step, state.intent, state.config);
      if (speakLine("nudge", line)) {
        bumpCounter("nudges_fired");
        silenceStage += 1;
        suppressionNotedForStage = -1;
        // The next rung's gap is measured from this one, not from the caller's
        // last word.
        ladderSince = atMs;
      }
      return;
    }

    // The last rung. armExit, NOT finish: audioOut paces frames to Twilio and
    // holds the rest locally, so hanging up when the model stops GENERATING
    // throws away most of the goodbye it just said. The exit is armed when
    // that turn completes, and rides out behind its own audio.
    if (speakLine("goodbye", buildSilenceGoodbye(state.config))) {
      bumpCounter("silence_hangups");
      log.info("live_silence_hangup", { callSid, quiet_ms: Math.round(atMs - ladderSince) });
      silenceStage = 3;
      exitAfterTurn = true;
    }
  }

  /**
   * Say something to the model, at most once per turn and a bounded number of
   * times per call.
   *
   * Every guard on this path can only talk to the model -- there is no TTS leg
   * to speak a correction and no toolConfig to force one. That makes the notes
   * the single shared resource, and this the single place that rations them.
   *
   * @returns {boolean} whether the note was actually sent
   */
  function sendTurnNote(kind, text) {
    if (noteSentThisTurn || !session || closed) return false;
    if (notesThisCall >= MAX_NOTES_PER_CALL) {
      bumpCounter("live_turn_notes_capped");
      log.error("live_turn_notes_capped", { callSid, kind, sent: notesThisCall, severity: "warn" });
      return false;
    }
    try {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      });
      noteSentThisTurn = true;
      notesThisCall += 1;
      log.info("live_turn_note", { callSid, kind, sent: notesThisCall });
      return true;
    } catch (err) {
      log.error("live_turn_note_failed", { callSid, kind, reason: err?.message, severity: "warn" });
      return false;
    }
  }

  /**
   * The two checks that can only be made once a model turn is over.
   *
   * Runs BEFORE applyTurn(), which clears the turn's accumulated text -- so
   * the order of these two calls at the turnComplete site is load-bearing.
   */
  /**
   * Record what the ASSISTANT said this turn. Off unless asked for.
   *
   * The LVX23 bisect came down to a question the owner had to notice while
   * also driving the call -- does it ask one thing at a time or four -- and the
   * honest answer was "I don't remember". No number of extra calls fixes an
   * instrument that runs on recall.
   *
   * Guarded rather than simply added, because this is the category of data
   * LVX24 was just fixed for: the assistant's own speech carries the caller's
   * name, number and appointment time back to them, and the PHI lint works on
   * field NAMES, so it cannot see any of it. Opt-in, refused in hipaa mode,
   * announced when on.
   *
   * IT NOW RECORDS THE CALLER'S HALF TOO, and that reverses an earlier
   * decision. Leaving `inputTranscription` alone looked like restraint and was
   * actually a blind spot: LVX36 is a defect -- the assistant offered three
   * slots and booked a fourth -- whose entire evidence is one side of the
   * conversation, and it cannot be resolved in either direction. On a
   * front-end whose open P0 is that it says things nobody asked for, "did the
   * caller actually ask for that?" has to be answerable.
   *
   * Nothing about the risk changes: it is the same flag, the same hipaa
   * refusal, the same debug_only marking, the same rule that the log is
   * scrubbed after a sitting. The caller's words were always in this process;
   * they were simply not written down.
   */
  function debugTranscript(replyText, userText) {
    if (!debugTranscriptOn || (!replyText && !userText)) return;
    log.info("live_debug_assistant_turn", {
      callSid,
      step: state.step,
      debug_only: true,
      text: replyText,
      // Already echo-gated: suppressed self-echo never reaches turnUserText, so
      // a turn the model talked over itself on does not appear as the caller.
      user_text: userText || null,
    });
  }

  function auditTurn() {
    const replyText = turnReplyText.trim();
    // turnUserText is still populated here: applyTurn() is what clears it and
    // runs AFTER this at the turnComplete site.
    debugTranscript(replyText, turnUserText.trim());
    const S = getStrings(state.config);

    // LVX27. The assistant said it was done, and nothing did it.
    //
    // This is the only check on this path that sits ABOVE the tool layer.
    // The availability invariant, the idempotency cache and the round cap all
    // fire on calls that are actually made; none of them can see a call that
    // was never made. On 2026-09-03 the assistant invented five appointment
    // slots and confirmed a booking, with no tool events in the log and no row
    // in the database, on a session whose previous call had used the same
    // tools successfully.
    //
    // Looks back one turn, because a claim can legitimately trail the tool
    // that backs it, and counts by default. Acting is opt-in and stays off
    // until the counter has said how often this fires when nothing is wrong.
    const claimedCompletion = Boolean(replyText && S.completionClaimRe?.test(replyText));

    // LVX29's claim ledger, and it is deliberately WIDER than the guard below.
    //
    // The guard must stay narrow: it exists to avoid nagging a model that has
    // just done the thing it said it did, so a claim on a turn where a tool
    // ran is none of its business. The post-call read is asking a different
    // question -- did the database end up holding what the caller was told? --
    // and there a claim backed by a tool that ran and wrote nothing is exactly
    // the case the guard is blind to and `row_mismatch` exists to catch.
    //
    // Shape only: which turn, which step, whether a tool backed it. Never the
    // sentence, which contains the caller's name and appointment time.
    if (claimedCompletion) {
      // The POSITIVE half of the claim family, and it was missing.
      //
      // Every other counter here fires on a fault, so `claims: 0` in a
      // postcall_verify line has always had two readings -- "the assistant
      // never claimed anything" and "the detector could not see what it
      // claimed" -- and on 2026-09-03 the second one was true twice while the
      // first was assumed. This counter separates them: a call with claims and
      // no faults now reads differently from a call that never got there.
      bumpCounter("live_claim_detected");
      claimsThisCall.push({
        turn: callerTurnCount,
        kind: "claim",
        step: state.step,
        toolBacked: toolsRanThisTurn() || toolRanPrevTurn,
      });
    }

    // BOTH halves are success-based, and the second is not an afterthought:
    // `toolRanPrevTurn` on attempts would let a turn that tried and was refused
    // grant the NEXT turn's claim immunity, which is a new blind spot in the
    // shape of the one being closed.
    //
    // Expect this to fire MORE often than before, including on calls where the
    // model corrected itself a turn later. That is the counter seeing cases it
    // was blind to, not the model getting worse. Nothing acts on it:
    // LIVE_CLAIM_GUARD stays unset, and the whole point of the ladder is that
    // the decision to act is made FROM this number.
    if (claimedCompletion && !toolsRanThisTurn() && !toolRanPrevTurn) {
      bumpCounter("live_claim_without_action");
      log.error("live_claim_without_action", { callSid, step: state.step, severity: "warn" });
      if (env.LIVE_CLAIM_GUARD === "act") sendTurnNote("claim", CLAIM_NOTE);
    }

    // The same failure, one step earlier. An OFFER of times, on a call where
    // no availability response has ever put a slot on the record.
    //
    // The authority is guards.js's verifiedSlots, not the sentence: that set
    // is filled only from a real availability tool's response and is what the
    // booking invariant already gates on, so this needs no parsing of the
    // times themselves. It therefore does NOT catch a wrong time quoted after
    // a genuine check -- a smaller hole than the one it closes.
    if (
      replyText &&
      !(runner?.guards?.verifiedCount?.() > 0) &&
      S.slotOfferRe?.test(replyText)
    ) {
      bumpCounter("live_offer_unverified");
      log.error("live_offer_unverified", { callSid, step: state.step, severity: "warn" });
      if (env.LIVE_CLAIM_GUARD === "act") sendTurnNote("offer", OFFER_NOTE);
    }

    // A promise with no action behind it. `promisedAction` is the cascade's
    // own predicate, exported rather than reimplemented, and it is stricter
    // than it looks: it fires only when the promise ENDS the reply or is
    // essentially the whole of it, so "one moment" inside a longer answer does
    // not count. The counter records the CONDITION; whether a note went out is
    // a separate question, because the leak guard may already have spent this
    // turn's note.
    if (!realToolCallsThisTurn && promisedAction(replyText, S.promiseRe)) {
      bumpCounter("live_promise_only_turns");
      log.info("live_promise_only_turn", { callSid });
      sendTurnNote("promise", PROMISE_NOTE);
    }

    // The caller gave their name and the assistant did not ask how to spell it.
    //
    // Keyed on what the CALLER said, not on the assistant's read-back: a caller
    // says it plainly ("it's Jane Fitzgerald") while a read-back can be phrased
    // a hundred ways. Fires in the turn the name arrives, which is the moment
    // the prompt asks for and does not reliably get.
    //
    // Once per call. A nudge that can repeat is the shape that made the leak
    // guard destroy a call (LVX21), and the write gate in services/tools.js is
    // still the actual guarantee -- this only moves the asking earlier.
    //
    // TWO triggers since 2026-09-04, because one was not enough and the way it
    // failed was invisible. nameGivenRe fires on the caller announcing
    // themselves; on the two calls after the fix shipped the caller said "let's
    // do uh Nathan Dodla", which has no lead-in, and the nudge never fired --
    // live_spelling_ask_nudged 0 against spelling_gate_refusals 2.
    //
    // nameReadBackRe fires on the assistant repeating the name, which the
    // prompt demands in three separate places. A caller can introduce
    // themselves a hundred ways; the assistant was told how to answer. Either
    // side spends the same single nudge.
    const nameSeenThisTurn = Boolean(
      (turnUserText && S.nameGivenRe?.test(turnUserText)) ||
        (replyText && S.nameReadBackRe?.test(replyText))
    );
    if (!spellingNudged && !spellingSettled(state) && nameSeenThisTurn) {
      // Counted BEFORE the already-asked check, and this is the diagnostic that
      // was missing. When the nudge did not fire there was no way to tell
      // "the trigger did not match the caller's phrasing" from "no name was
      // ever given on that call" without re-reading the log by hand -- which is
      // exactly the question the LVX44 post-mortem could not answer. Eligible
      // with no nudge now means the assistant had already asked; eligible zero
      // with the gate refusing means the trigger is still missing cases.
      bumpCounter("live_spelling_nudge_eligible");
      if (!(replyText && S.spellRequestRe?.test(replyText))) {
        spellingNudged = true;
        bumpCounter("live_spelling_ask_nudged");
        log.info("live_spelling_ask_nudged", { callSid, step: state.step });
        sendTurnNote("spelling", SPELLING_NOTE);
      }
    }

    // A refused write, answered with a callback promise. LVX34.
    //
    // TWO conditions, and the pairing is what makes it safe to act on. Telling
    // a caller that someone will ring them back is a perfectly good thing for a
    // receptionist to say; it is only wrong when the tools refused the thing
    // they asked for on this same turn, because a refusal here always carries
    // an instruction to follow instead.
    //
    // This is why `promisedAction` above never fired on the call that found it.
    // It is gated on `!realToolCallsThisTurn`, and a refusal still counts as an
    // attempt -- and `promiseRe` matches "one moment, let me check", which is a
    // different speech act from "someone will call you back" and does not match
    // it in any phrasing.
    if (refusedActionCallsThisTurn && replyText && S.deferralRe?.test(replyText)) {
      bumpCounter("live_deferral_after_refusal");
      log.error("live_deferral_after_refusal", { callSid, step: state.step, severity: "warn" });
      sendTurnNote("deferral", DEFERRAL_NOTE);
    }

    // The caller's turn did not transcribe as usable speech. LVX50.
    //
    // Below the leak, spelling and deferral notes on purpose: position inside
    // auditTurn is priority order, because sendTurnNote allows one note per
    // turn. Each of those is about something the assistant DID; this is about
    // something the caller said, and it is the one the write gate in
    // services/tools.js already covers independently, so it can afford to lose
    // the tie.
    //
    // The positive counter is bumped for every caller turn actually examined,
    // not only for the bad ones. A fault-only counter reads zero for a clean
    // call and for a call where the check never ran, and the second is what
    // LVX45 turned out to be.
    if (turnUserText) {
      bumpCounter("live_transcript_script_checked");
      if (isUnusableTranscript(turnUserText)) {
        bumpCounter("live_unusable_transcript");
        // No text logged: this is caller speech. The shape is what matters.
        log.error("live_unusable_transcript", {
          callSid,
          step: state.step,
          chars: turnUserText.length,
          severity: "warn",
        });
        sendTurnNote("unusable_transcript", UNUSABLE_TRANSCRIPT_NOTE);
      }
    }

    // A tool ran and the caller heard nothing. On the cascade this is a
    // fallback LINE read by TTS; here the model is the only voice, so the only
    // way to fill the silence is to ask the model to fill it.
    if (realToolCallsThisTurn && !replyText) {
      bumpCounter("live_zero_text_turns");
      log.info("live_zero_text_turn", { callSid });
      sendTurnNote("zero_text", ZERO_TEXT_NOTE);
    }
  }

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
    // What the caller actually last said, for the end_call gate.
    //
    // The cascade never needed this: Deepgram's text goes through
    // cleanTranscript, which strips "um"/"uh"/"hmm", so a hesitation arrives as
    // an empty turn and never reaches the model as an answer. On this path the
    // MODEL is the ASR -- there is no text stage at all -- so "umm" arrives
    // verbatim, and on a real call on 2026-09-03 it was read as agreement and
    // the line was closed on a caller who was still thinking.
    lastCallerText: turnUserText,
    // Everything the caller has said on this call, for the name-provenance
    // check. LVX53: the caller's name never transcribed intelligibly at all,
    // the model took one off an existing appointment row, and it was written --
    // and the spelling gate stayed silent because that string was already on
    // file. A record can confirm a spelling; it cannot supply the fact that
    // this caller identified themselves.
    //
    // In memory only, capped, and NEVER logged: it carries the caller's name
    // and number, which is exactly what LVX24 was.
    callerSaidThisCall,
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
    noteSentThisTurn = false;
    toolRoundsThisTurn = 0;
    // BEFORE the reset below, or the look-back always reads false and the
    // claim guard fires on every legitimate trailing confirmation.
    toolRanPrevTurn = toolsRanThisTurn();
    realToolCallsThisTurn = 0;
    calledToolsThisTurn.clear();
    refusedActionCallsThisTurn = 0;
    refusedCallsThisTurn = 0;
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

    // The debug transcript is BLIND to exactly this failure, which is why it
    // is repeated here.
    //
    // `debugTranscript` runs from `auditTurn`, and `auditTurn` only runs on
    // `turnComplete`. A call that leaks repeatedly never completes a turn --
    // observed 2026-09-03 on a real call: six leak cycles, `turns: 0`, and not
    // a single `live_debug_assistant_turn` line, with LIVE_DEBUG_TRANSCRIPT
    // switched on. The one instrument that could name the defect could not see
    // the calls the defect happens on.
    //
    // `outbound_sanitized` reports `chars` and `rules` and deliberately not the
    // text (LVX24), which is right for a line that fires in production and
    // useless when the question is "what did it actually say". So the text goes
    // here instead, under the SAME guard as debugTranscript: opt-in, refused in
    // hipaa mode, assistant speech only, and the caller's own words untouched.
    if (debugTranscriptOn) {
      log.info("live_debug_leak_text", {
        callSid,
        step: state.step,
        debug_only: true,
        matched: verdict.matched ?? null,
        // The tail, not the whole turn: the leak is in what just arrived, and
        // an unbounded field is how a log line becomes a transcript dump.
        text: `${turnReplyText}${fragment}`.slice(-400),
      });
    }

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

    // Text-channel recovery, folded into the same note rather than given its
    // own. If the model NAMED a tool aloud and has not actually called it this
    // turn, it described the call instead of making it -- the Live shape of
    // the defect services/gemini.js recovers from. One detection, one note.
    const described = verdict.matched && !calledToolsThisTurn.has(verdict.matched);
    if (sendTurnNote("leak", buildLeakNote(described ? verdict.matched : null))) {
      bumpCounter("live_outbound_reasks");
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

    // The ungated verdict, not the gated one below: a caller talking over us
    // has not gone quiet, whether or not we forward the frame to the model.
    checkSilence(atMs, v.voiced, playing);

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

    // The bound the cascade has had since text-channel recovery landed, and
    // this path never did. Past the cap the calls are ANSWERED but not run: a
    // Live session left holding an unanswered tool call does not error, it
    // waits, and the caller hears silence.
    toolRoundsThisTurn += 1;
    if (toolRoundsThisTurn > MAX_TOOL_ROUNDS) {
      bumpCounter("live_tool_rounds_capped");
      log.error("live_tool_rounds_capped", {
        callSid,
        round: toolRoundsThisTurn,
        cap: MAX_TOOL_ROUNDS,
        severity: "warn",
      });
      try {
        session.sendToolResponse({
          functionResponses: (toolCall.functionCalls || []).map((fc) => ({
            id: fc.id,
            name: fc.name,
            response: {
              success: false,
              message:
                "Too many tool calls in one turn. Stop calling tools and speak to the caller now with what you already have.",
            },
          })),
        });
      } catch (err) {
        log.error("live_tool_response_failed", { callSid, reason: err?.message, severity: "warn" });
      }
      return;
    }

    for (const fc of toolCall.functionCalls || []) calledToolsThisTurn.add(fc.name);
    realToolCallsThisTurn += (toolCall.functionCalls || []).length;

    let out;
    pendingToolCalls += 1;
    try {
      out = await runner.handleToolCall(toolCall);
    } finally {
      // In a finally, so a throw cannot leave the silence ladder permanently
      // suppressed -- which would restore the exact 61-second call this exists
      // to end.
      pendingToolCalls -= 1;
    }

    // Held for the reducer rather than applied here. applyReplyState orders
    // these deliberately -- intent first, then effects (so a completed action
    // wins the step over an intent change in the same turn), then end_call
    // last so it wins over everything -- and reimplementing that ordering is
    // how two drivers drift.
    refusedActionCallsThisTurn += out.refusedActionCalls || 0;
    refusedCallsThisTurn += out.refusedCalls || 0;

    if (out.intentArgs) pendingIntentArgs = out.intentArgs;
    if (out.endCallArgs) {
      pendingEndCallArgs = out.endCallArgs;
      endCallArmed = true;
    }
    if (out.capabilityEffects?.length) {
      pendingCapabilityEffects.push(...out.capabilityEffects);
      // LVX29's write ledger. The same effects, recorded into a list that is
      // never drained -- `pendingCapabilityEffects` is cleared the moment the
      // reducer consumes it, and the post-call read needs to know what the
      // WHOLE call wrote, not what is still outstanding at the end of it.
      //
      // Shapes only. `data` on a booked effect is the model's own arguments
      // and carries the caller's name; none of it is needed here, because
      // every value that reaches a caller is read back from the row.
      for (const e of out.capabilityEffects) {
        if (e?.capability !== "appointments") continue;
        if (e.type === "booked") writesThisCall.push({ type: "booked", tool: "book_appointment" });
        else if (e.type === "changed") {
          writesThisCall.push({
            type: "changed",
            tool: e.data?.tool || null,
            appointmentId: e.data?.appointmentId || null,
          });
        }
      }
    }

    // Which action tools were refused, and which ones actually landed. LVX72.
    //
    // Read off the function RESPONSES rather than the capability effects,
    // because a refusal produces no effect at all -- which is precisely why an
    // abandoned write was invisible. A tool that appears in both sets was
    // refused and then retried successfully, which is the system working as
    // designed and is not reported.
    for (const fr of out.functionResponses || []) {
      if (!fr?.name || !ACTION_TOOL_NAMES.includes(fr.name)) continue;
      if (fr.response?.success === false) refusedToolsThisCall.add(fr.name);
      else completedToolsThisCall.add(fr.name);
    }

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
        callerSaidThisCall = (callerSaidThisCall + " " + sc.inputTranscription.text).slice(
          -CALLER_TRANSCRIPT_CAP
        );
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
      // BEFORE applyTurn(), which clears the turn's accumulated reply text and
      // resets the per-turn counters both checks read.
      auditTurn();
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
      } else if (endCallArmed || exitAfterTurn) {
        // exitAfterTurn is the silence ladder's last rung: the goodbye has now
        // been generated, so the exit can queue behind the audio carrying it.
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
      noteSentThisTurn = false;
      toolRoundsThisTurn = 0;
      realToolCallsThisTurn = 0;
      calledToolsThisTurn.clear();
      refusedActionCallsThisTurn = 0;
      refusedCallsThisTurn = 0;
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
      // VOICE_INTENT_MARKER IS INCOMPATIBLE WITH THIS FRONT-END, and forcing it
      // off here is the fix rather than a preference.
      //
      // Marker mode asks the model to write `<<intent:general_question>>` inline
      // instead of calling set_call_intent, and it is a real latency win on the
      // cascade -- where getReplyStreaming strips the marker out of the text
      // before a single character reaches TTS. Here THE MODEL IS THE VOICE.
      // There is no text stage between it and the caller, so the marker is
      // simply spoken aloud.
      //
      // Observed on staging 2026-09-03, and it destroys the call rather than
      // merely embarrassing it: the leak guard catches the marker as structural
      // syntax, cuts the audio, and sends a note; the model apologises, emits
      // the marker again, and loops. Six leak cycles, `turns: 0`,
      // `usage.audio_out: 13`, and a caller who hears silence. Fourteen calls on
      // a laptop where the variable was unset produced ZERO leaks, which is why
      // this survived every earlier round of testing.
      //
      // Set as a boolean on extras because intentMarkerEnabled() checks that
      // BEFORE the environment variable -- so this turns the marker off for the
      // prompt (buildSystemInstruction) and the declarations (buildLiveTools)
      // together, which is required: disabling one and not the other leaves the
      // model told to emit a marker it has no tool for.
      intentMarker: false,
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
    //
    // LVX23's two knobs sit here, and nowhere else. Both default to production
    // and both are read from `env` -- the injected one -- because LIVE_VOICE
    // and LIVE_LANGUAGE_CODE already bypass that seam (backlog LVX13) and the
    // two settings a call summary REPORTS are the two nothing can vary per
    // session. Adding a third would be repeating a known mistake knowingly.
    const minimalPrompt = env.LIVE_PROMPT === "minimal";
    const noTools = env.LIVE_TOOLS === "none";
    const systemInstruction = minimalPrompt
      ? buildMinimalInstruction(config)
      : buildSystemInstruction(state.step, state.intent, config, extras);
    if (minimalPrompt || noTools) {
      log.info("live_bisect_arm", { callSid, prompt: minimalPrompt ? "minimal" : "full", tools: noTools ? "none" : "all" });
    }

    const config_ = {
      responseModalities: ["AUDIO"],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Empty, not omitted: the model must be given nothing to call, while the
      // runner and its guards stay constructed so the only thing that differs
      // between arms is what the model can see.
      tools: noTools ? [] : buildLiveTools(config, extras),
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
      // verified_slots alongside the counts, because it is the discriminator
      // the offer guard judges on and nothing in the record showed it. Without
      // it, a call where the guard stayed silent cannot be distinguished after
      // the fact from one where it had nothing to judge -- which is exactly
      // the ambiguity that made an earlier round's echo numbers unreadable.
      guards: runner?.guards
        ? { ...runner.guards.counts(), verified_slots: runner.guards.verifiedCount() }
        : null,
      ...record,
      // AFTER the spread, not before. `...record` carries its own
      // `close_reason` (the vendor's, usually null) and was overwriting the
      // computed one, so HOW a call ended -- mark, backstop, caller hang-up,
      // connect failure -- was never reported on any call. Found on the first
      // real call, where it was the one question the log could not answer.
      close_reason: record.close_reason || reason || null,
    });

    // LVX29. The last thing a call does is check what it actually wrote.
    //
    // HERE and not in /twilio/status because this path never writes the shared
    // call state, so the status handler reads no businessId and no dbCallId
    // for a Live call and its whole summary block is skipped (recorded as
    // LVX30, deliberately not fixed). Everything the read needs -- the tenant,
    // the call row, the config, the ledgers -- is already in this closure.
    //
    // Fire-and-forget. `finish` runs with the socket closing and nothing
    // downstream waits on the result; `verifyCall` resolves rather than
    // throwing by construction, and the .catch is the belt to that brace.
    const postCall = postCallMode(env);
    if (postCall !== "off" && state.businessId && state.dbCallId) {
      verify({
        businessId: state.businessId,
        callId: state.dbCallId,
        config: state.config,
        callerNumber: state.callerNumber,
        writes: writesThisCall,
        claims: claimsThisCall,
        // Refused and never completed. See LVX72 and the two sets above.
        abandoned: [...refusedToolsThisCall].filter((n) => !completedToolsThisCall.has(n)),
        mode: postCall,
        callSid,
      }).catch((err) =>
        log.error("postcall_verify_failed", { callSid, reason: err?.message, severity: "warn" })
      );
    }

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
