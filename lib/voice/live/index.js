import { performance } from "node:perf_hooks";

import * as db from "../../../services/db.js";
import {
  ACTION_TOOL_NAMES,
  buildSystemInstruction,
  callToolNames,
  callToolParamNames,
  promisedAction,
} from "../../../services/gemini.js";
import { STEPS, writeShared } from "../../callState.js";
import {
  resolveTransferAllowed,
  buildSilenceNudge,
  buildSilenceGoodbye,
  SILENCE_THRESHOLDS,
  SILENCE_THRESHOLDS_DEFAULT,
} from "../session.js";
import { applyReplyState, spellingSettled, applyCallerSpellingSignal } from "../replyState.js";
import { callerHasNameOnFile } from "../../nameQuality.js";
import { countryFromE164 } from "../../phone.js";
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
import { bumpCounter, bumpCounterBy } from "../metrics.js";
import {
  isUnusableTranscript,
  longestSharedRun,
  REPEAT_RUN_WORDS,
  countAsks,
} from "../../transcriptUtils.js";
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
import { classifyClose } from "./closeKind.js";

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

/** How many recent assistant turns LVX78 compares against. See recentReplies. */
const REPEAT_WINDOW_TURNS = 3;

/**
 * How many repeats one call may have cut out of it.
 *
 * THREE, and the bound matters more than the number. LVX21 is this path's
 * standing record of what a hair trigger costs, and a cutter firing on every
 * turn would be a worse call than the repeats it removes. Three covers the
 * observed rate -- the 2026-09-05 call had two such blocks -- while capping the
 * damage if the detector is wrong about what a repeat looks like.
 */
const MAX_REPEAT_CUTS = 3;

/**
 * How many unverified-offer cuts one call may make. LVX80.
 *
 * Three, matching MAX_REPEAT_CUTS and for the same reason: a detector that is
 * wrong about what it is looking at should damage a bounded number of turns.
 * The exposure here is narrower than the repeat cutter's -- the guard only
 * fires while NOTHING on the call has ever verified a slot, so a single
 * successful availability check disarms it for the rest of the call.
 */
const MAX_OFFER_CUTS = 3;

/**
 * How long the caller has to interrupt after the goodbye has played.
 *
 * 1,500 ms, matching lib/voice/session.js's HANGUP_GRACE_MS exactly. Its comment
 * is the argument: "the window has to be long enough for someone to actually
 * start talking -- 800ms is barely a breath. The cost of being generous is a
 * little dead air at the end of a call that is over anyway; the cost of being
 * stingy is hanging up on someone mid-sentence."
 *
 * Two front-ends that hang up after different pauses is a difference nobody
 * wants to discover from a call recording.
 */
const HANGUP_GRACE_MS = 1_500;

/**
 * How much of the tail of a turn is compared against its own head, for LVX78's
 * within-turn case.
 *
 * Measured in WORDS rather than characters, after a character gate caused this
 * check to skip a doubled goodbye entirely: 25 words is about a sentence and a
 * half, wide enough to hold a restated one and narrow enough that an ordinary
 * turn does not overlap itself.
 */
const REPEAT_TAIL_WORDS = 25;

/**
 * The prebuilt voice used when a tenant has not chosen one, per LANGUAGE.
 *
 * Keyed on the language the ladder below actually resolved -- not on a second
 * derivation from the phone number -- so the voice and the accent it is being
 * asked to hold can never disagree.
 *
 * BOTH ENTRIES ARE "Kore" ON PURPOSE, and that is not an oversight. Nothing in
 * this project has ever established which prebuilt voice names the Live API
 * accepts, nor what it does with one it does not recognise -- whether it errors,
 * substitutes, or ignores the field. Writing a British-sounding name here from
 * memory would therefore be either a change nobody has heard or a no-op that
 * looks like a fix, and there is no way to tell which from the code.
 *
 * So the en-GB entry is filled in from scripts/voice-compare.js, which renders
 * candidates to audio and compares them, once the owner has picked by ear --
 * roadmap phase 1, "a British voice you are happy with". Until then this map
 * exists, is consulted, and reports which rung of the ladder was taken.
 */
const VOICE_BY_LANGUAGE = {
  "en-GB": "Kore",
  "en-US": "Kore",
};

/** For a language with no entry above. Unchanged from the old global constant. */
const VOICE_DEFAULT = "Kore";

/**
 * The BCP-47 language the Live voice is pinned to, for one tenant.
 *
 * This was a module constant defaulting to en-GB, which is Digile Media's
 * locale and was correct while Digile Media was the only tenant. It is not
 * correct now: `businesses.locale` for Brightwork Family Dental reads "en-US",
 * loadConfig has carried it as `config.locale` all along (services/db.js:543),
 * and this front-end ignored it and pinned a British voice on an American
 * dental practice reachable on an American number.
 *
 * Found because the owner asked why the accent kept changing. It is not the
 * cascade cutting in -- that cannot happen mid-call, the connect-time fallback
 * is the only fallback that exists and it decides before any TwiML is returned.
 * It is one voice being asked to speak British English over content the model
 * is generating as American, and drifting.
 *
 * Precedence: an explicit LIVE_LANGUAGE_CODE wins, because an operator setting
 * it is overriding on purpose and a test rig needs that seam. Otherwise the
 * tenant's own locale, which is the whole reason the column exists. Otherwise
 * the old default, so a tenant with no locale behaves exactly as before.
 */
function resolveLiveLanguage(config, businessPhone, env) {
  const override = String(env?.LIVE_LANGUAGE_CODE || "").trim();
  if (override) return { code: override, source: "env" };
  const tenant = String(config?.locale || "").trim();
  if (tenant) return { code: tenant, source: "tenant" };

  // NO LOCALE ON THE ROW, which is the case that reached a real caller.
  //
  // The first version of this function fell through to LANGUAGE_CODE -- an
  // en-GB default that is Digile Media's locale, baked in from when they were
  // the only tenant. Reading the tenant's locale fixed the LOCAL database,
  // where Brightwork's row says "en-US", and did nothing on the deployment,
  // whose own Postgres has that column empty. A caller on an American number,
  // to an American dental practice, was answered in British English, and the
  // log said so exactly: language_code en-GB, language_source DEFAULT.
  //
  // That is the config-only-in-one-environment trap for the second time in this
  // project -- the first cost fourteen clean laptop calls and a silent
  // deployment (VOICE_INTENT_MARKER, LVX37). Reading one database and calling
  // it fixed is the same mistake in a new place.
  //
  // So the fallback stops being a country and becomes a derivation, using the
  // rule server.js already applies twice for the unrouted-voicemail voice
  // (:530, :678). A tenant that never sets a locale now gets the language of
  // its own phone number instead of Digile Media's.
  const gb = countryFromE164(businessPhone) === "GB";
  return { code: gb ? "en-GB" : "en-US", source: "from_number" };
}

/**
 * The prebuilt voice this call is answered in, and where that came from.
 *
 * The LANGUAGE became tenant-aware on 2026-09-04 and the VOICE NAME did not:
 * it stayed one module-scope constant for every tenant on the platform, so the
 * accent a tenant was pinned to could be corrected while the voice speaking it
 * could not. For a UK demo tenant that is a demo-quality problem rather than a
 * preference -- British is the CORRECT accent there, and the owner reports the
 * current pairing sounds muffled.
 *
 * Precedence is liveLanguage's, deliberately identical so there is one ladder
 * on this path and not two: an explicit env override wins, because an operator
 * setting it is overriding on purpose and a rig needs that seam; then the
 * tenant's own column, which is the whole reason it exists; then the per-
 * language default.
 *
 * `languageCode` is the RESOLVED language, passed in rather than re-derived.
 * Deriving it twice is how two things that must agree stop agreeing.
 */
function resolveLiveVoice(config, languageCode, env) {
  const override = String(env?.LIVE_VOICE || "").trim();
  if (override) return { name: override, source: "env" };
  const tenant = String(config?.liveVoice || "").trim();
  if (tenant) return { name: tenant, source: "tenant" };
  return { name: VOICE_BY_LANGUAGE[languageCode] || VOICE_DEFAULT, source: "default" };
}

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
  "(System: the caller has just given you their name. Ask them to spell their FULL " +
  "name NOW - first name and surname, not just one of them - before you go any " +
  "further with the booking, and read the letters back. Asking " +
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

/**
 * Told to the model after WE re-issued the write it never retried.
 *
 * It has to say the booking is real, because the model is about to describe it
 * to the caller and the entire point is that the description is now true.
 */
const WRITE_RETRIED_NOTE =
  "[not caller speech] The booking you were asked to spell the name for has now been " +
  "completed and saved. It is real. Confirm it to the caller in one short sentence and do " +
  "NOT call the booking tool again.";

/**
 * The name half, and it exists because of what call 5 got wrong.
 *
 * The retry replays the arguments as they were when the gate refused -- which
 * is the PRE-SPELLING name. On call 5 the caller said "Nitin Dodla", spelled
 * "N I T H I N", the assistant read the letters back correctly, and the row was
 * written as "Nitin Dodla". The gate exists to get the name right and the retry
 * wrote the un-corrected one.
 *
 * The letters are not assembled in code on purpose. applyCallerSpellingSignal
 * only ever sets a boolean, and LVX62 is the reason: spelled letters do not
 * transcribe reliably here -- a spelled "D" has arrived as "V". The model heard
 * the letters and is the thing that can turn them into a name, so it is asked
 * to, through the tool that exists for exactly this.
 *
 * The failure mode if it declines is a saved booking with a slightly wrong
 * name, which is strictly better than the four calls that saved nothing -- and
 * an abandoned correct_appointment_name is itself caught by the write ledger.
 */
const WRITE_RETRIED_NAME_NOTE =
  "[not caller speech] The booking has been saved, and the name on it is the one you gave " +
  "BEFORE the caller spelled it. If the spelling they just gave differs from what is on the " +
  "booking, call correct_appointment_name now with the corrected spelling. Do NOT call the " +
  "booking tool again, and do not mention any of this to the caller.";

/**
 * And the other half, which matters more: it did NOT go through.
 *
 * Without this the model is left free to describe a booking that still does not
 * exist, which is the exact defect this whole path exists to stop.
 */
const WRITE_RETRY_FAILED_NOTE =
  "[not caller speech] The booking could NOT be completed and nothing has been saved. Do " +
  "NOT tell the caller it is booked. Tell them plainly that it did not go through, and ask " +
  "whether they would like you to try again or to leave a message.";

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
    // LVX30. The shared call-state write, injectable so a test can assert the
    // patch without standing up a store. Real one is fire-and-forget, ordered
    // per call SID and swallows its own errors -- see lib/callState.js.
    writeCallState = writeShared,
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

  // LVX78's cutter is on by default and switchable off without a deploy, for
  // the same reason LIVE_TURN_END and LIVE_CLAIM_GUARD are: anything that cuts
  // a caller's audio needs a way to stop doing so in the middle of an incident.
  const repeatCutOff = String(env.LIVE_REPEAT_CUT || "").trim().toLowerCase() === "off";

  // ON by default as of 2026-09-06 -- see the claim gate in auditTurn for the
  // call that changed it. "act" is still accepted so an existing deployment
  // setting it keeps working; only "off" now changes anything.
  const claimGuardOff = String(env.LIVE_CLAIM_GUARD || "").trim().toLowerCase() === "off";

  // LVX80's cut, and it gets its OWN switch rather than riding on
  // LIVE_CLAIM_GUARD. The note has been in production since 2026-09-06 and is
  // known safe; cutting the caller's audio is new. If the cut turns out to fire
  // on ordinary conversation, the thing to turn off is the cut -- turning off
  // detection with it would lose the evidence needed to decide what to do next,
  // which is the mistake the claim guard's own count-then-act ladder avoided.
  const offerCutOff = String(env.LIVE_OFFER_CUT || "").trim().toLowerCase() === "off";

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
   * The same question, restricted to tools that can CHANGE something.
   *
   * LVX93. `toolsRanThisTurn()` and its look-back treat every tool alike, so a
   * `check_appointment_availability` that ran last turn vouches for a "your
   * appointment is booked" claim this turn. Checking whether a slot is free
   * cannot substantiate having booked it.
   *
   * Measured on a real call, 2026-09-09: availability ran at 02:09:33,
   * book_appointment was REFUSED by the spelling gate at 02:09:58, and the
   * caller was told "so I have you booked" — with the guard silent, because a
   * read had run the turn before.
   *
   * THIS DRIVES A COUNTER ONLY, and that is deliberate. It is biased the way
   * LVX31's was — low, in the direction that makes the guard look quieter and
   * therefore safer than it is — so the number has to be corrected before any
   * decision rests on it. Whether the guard should ACT on this wider condition
   * is the decision LVX31 left to a measured value, and it stays unmade until
   * there is one.
   */
  let actionToolCallsThisTurn = 0;
  const actionToolsRanThisTurn = () =>
    actionToolCallsThisTurn - refusedActionCallsThisTurn > 0;
  let actionToolRanPrevTurn = false;
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
   * LVX98. Was a note sent on the turn BEFORE this one?
   *
   * The discriminator between "the assistant apologised" and "the assistant
   * apologised because we told it something". Both are worth counting and only
   * the second is LVX98: a refusal apology to a caller who asked for a past
   * date is a clean turn, and six escalating apologies downstream of a claim
   * note are the defect. Assigned in applyTurn from noteSentThisTurn, in the
   * same place and for the same reason as toolRanPrevTurn.
   */
  let noteSentPrevTurn = false;
  /**
   * Did a tool call this turn carry a caller name in its arguments?
   *
   * The spelling nudge's phrasing-independent trigger. Per TURN, because
   * auditTurn reads it at turnComplete and the question it answers ("is a name
   * in play right now") is about this turn and not the call.
   */
  let nameInToolArgsThisTurn = false;
  /**
   * And at most this many for the whole call. The per-turn latch bounds width;
   * this bounds depth, which is the ping-pong case -- and it is counted rather
   * than silent, because a guard that quietly stops guarding is worse than one
   * that never existed.
   */
  let notesThisCall = 0;
  const MAX_NOTES_PER_CALL = 8;
  /**
   * Leak notes sent on this call, and the ceiling on them.
   *
   * Separate from MAX_NOTES_PER_CALL, which is a shared budget across every
   * mechanism and far too loose to bound a loop the note itself feeds. See the
   * send site for the two measured cycles this number comes from.
   */
  let leakNotesThisCall = 0;
  const MAX_LEAK_NOTES = 2;
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
  /**
   * @param {string} kind
   * @param {string} text
   * @param {{requestReply?: boolean}} [opts] - `false` appends the note to the
   *   model's context WITHOUT asking it to speak. See below.
   */
  function sendTurnNote(kind, text, { requestReply = true } = {}) {
    if (noteSentThisTurn || !session || closed) return false;
    if (notesThisCall >= MAX_NOTES_PER_CALL) {
      bumpCounter("live_turn_notes_capped");
      log.error("live_turn_notes_capped", { callSid, kind, sent: notesThisCall, severity: "warn" });
      return false;
    }
    try {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text }] }],
        // turnComplete: true asks the model to REPLY. Every other note on this
        // path wants that -- they exist because the model just said something
        // wrong and needs to say something else.
        //
        // The write-retry note does not, and call 6 is why. The retry fires 43
        // ms after turnComplete, and the note then forced an entire extra spoken
        // turn in which the model repeated its previous sentence verbatim:
        //
        //   turn 8  "Thanks, Nithin Dodla. I have Monday, September 7th at
        //            4:00 pm for your cleaning. Is there anything else...?"
        //   turn 9  the identical sentence again
        //
        // That note only needs a TOOL called; the model had already told the
        // caller the right thing. So it is appended as context instead, and the
        // model acts on it at its next natural turn.
        //
        // The cost, stated: if the call ends before that turn, the correction
        // never happens -- which leaves the booking saved under the pre-spelling
        // name, exactly the state we would have been in anyway.
        turnComplete: requestReply,
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

  // -------------------------------------------------------------------------
  // LVX83. The transcript, written down.
  //
  // Sited beside debugTranscript rather than anywhere new, because that
  // diagnostic already proved this is the moment both accumulators hold a
  // whole turn: after the guards have run, before applyTurn() clears them.
  //
  // WHY hipaa REFUSES HERE AND THE CASCADE DOES NOT. session.js persists
  // caller speech verbatim with no gate at all, and that is not a precedent to
  // copy blindly -- it predates the mode existing. A Live session carries the
  // caller's entire utterance to a vendor the Cloud BAA does not reach, and
  // this estate holds no BAA, so the row is refused rather than written and
  // the refusal is announced once per call. Owner decision, 2026-09-08.
  //
  // Fire-and-forget, in the shape markCallTransferred already uses on this
  // path: never awaited, never thrown, never in front of a turn. A transcript
  // row is worth having and is worth nothing at the price of a pause.
  // -------------------------------------------------------------------------

  /** Next free sequence number. Advances by two, caller then assistant. */
  let transcriptSeq = 0;
  /** Set once a turn's rows are issued, so a barge followed by turnComplete does not double-write. */
  let transcriptWrittenThisTurn = false;
  /** The hipaa refusal is a fact about the call, not about the turn. Said once. */
  let transcriptRefusalLogged = false;
  /**
   * Turns whose rows were issued, carried into live_call_summary.
   *
   * A fault-only counter cannot tell a clean call from one that never reached
   * the write at all -- both read zero. This is the positive half.
   */
  let transcriptTurnsWritten = 0;

  /**
   * Both rows for one turn, in ONE tenant scope.
   *
   * NOT two calls, and the difference is not stylistic. `withTenantSafe` opens
   * a transaction — BEGIN, set_config, the INSERT, the audit row, COMMIT — so
   * a scope per speaker is roughly ten round trips per turn rather than five,
   * each holding a pooled connection.
   *
   * The pool is 10 per instance and Phase 3b measured one instance REACHING 10
   * at ten concurrent calls. The connections this would have taken are the same
   * ones a booking tool call needs, and that one IS on the latency path with a
   * caller waiting on it. Nothing here is worth a slower answer.
   */
  function persistTranscriptRows(rows) {
    database
      .withTenantSafe(
        state.businessId,
        async () => {
          for (const [speaker, message, sequence] of rows) {
            await database.addTranscriptEntry(state.dbCallId, speaker, message, sequence);
          }
        },
        { operation: "addTranscriptEntry", callSid }
      )
      .then(() => bumpCounterBy("live_transcript_written", rows.length))
      .catch((err) => {
        bumpCounter("live_transcript_write_failed");
        log.error("live_transcript_write_failed", {
          callSid,
          rows: rows.length,
          reason: err?.message,
          severity: "warn",
        });
      });
  }

  /**
   * Write one turn's two rows.
   *
   * @param {string} userText  what the caller said this turn, echo-gated already
   * @param {string} replyText what the assistant said this turn
   */
  function persistTurnTranscript(userText, replyText) {
    if (transcriptWrittenThisTurn) return;
    if (!userText && !replyText) return;
    if (hipaa) {
      if (!transcriptRefusalLogged) {
        transcriptRefusalLogged = true;
        log.error("live_transcript_refused", {
          callSid,
          reason: "hipaa mode",
          note: "A transcript row carries caller speech. No row is written on this deployment.",
          severity: "warn",
        });
      }
      return;
    }
    // Nothing to attach a row to. createCall either failed or was skipped, and
    // an orphan row is worse than a missing one.
    if (!state.dbCallId) return;

    transcriptWrittenThisTurn = true;
    const callerSeq = transcriptSeq;
    transcriptSeq += 2;
    const rows = [];
    if (userText) rows.push(["caller", userText, callerSeq]);
    if (replyText) rows.push(["ai", replyText, callerSeq + 1]);
    persistTranscriptRows(rows);
    transcriptTurnsWritten += 1;
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
    // LVX97's phrasing, counted but NOT spoken to.
    //
    // A strict superset of the line above. The note still fires on the narrow
    // predicate, so nothing about what the model is told mid-call moves and the
    // calls of this round stay comparable with the ten that produced LVX94-98.
    // What the wide one drives is the ledger and the reconciliation, which run
    // after the caller has hung up and cannot influence the conversation.
    //
    // FALLS BACK TO THE NARROW ONE. Only `en` carries a wide variant, because
    // only English calls have been read. Without this fallback a Spanish call
    // would evaluate `undefined?.test(...)`, never fill the ledger, and turn
    // LVX29's post-call audit off for every Spanish caller -- a guard that
    // protects only English callers is the defect promiseRe's comment already
    // names, arriving through a different door.
    const wideClaimRe = S.completionClaimWideRe || S.completionClaimRe;
    const claimedCompletionWide = Boolean(replyText && wideClaimRe?.test(replyText));

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
    }

    // THE LEDGER READS THE WIDE PREDICATE. LVX97.
    //
    // On call 156fb2 the post-call audit was blind for exactly the reason the
    // live guard was: it reads this ledger, and the ledger was filled from the
    // narrow regex, which never matched "we're all set for your free
    // consultation on Wednesday". A fabricated booking produced zero claim
    // events and a clean `postcall_verify` line.
    //
    // Filling it from the wide predicate is a MEASUREMENT change, not a
    // behaviour one -- nothing here is spoken, and the note above still fires
    // on the narrow condition. What it buys is that the reconciliation
    // downstream can see the phrasing that was invisible to both detectors.
    //
    // The counters split so the widening is readable rather than assumed:
    // live_claim_detected is the old population and live_claim_wide_only is
    // exactly what the extra alternations added. If the second one turns out to
    // fire on ordinary turns, that is the number that says so, and it says it
    // without a caller having heard anything.
    if (claimedCompletionWide) {
      bumpCounter("live_claim_detected_wide");
      if (!claimedCompletion) {
        bumpCounter("live_claim_wide_only");
        log.info("live_claim_wide_only", { callSid, step: state.step });
      }
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
    // was blind to, not the model getting worse.
    //
    // ACTING AS OF 2026-09-06, and the ladder is why. This was opt-in behind
    // LIVE_CLAIM_GUARD=act with an explicit rule attached: "count first, act
    // once the counter says how often it fires when nothing is wrong." The
    // counter has now said, on a real call, and the answer was not academic.
    //
    // The assistant told the caller "I have you booked for a strategy call with
    // the team on Monday the 7th of September at 4:30 PM UK time" and
    // book_appointment NEVER RAN. The tools for the entire call were
    // set_call_intent and check_appointment_availability. postcall_verify
    // returned claim_without_row, booked_rows: 0. The owner came off that call
    // believing it had gone well, because there is nothing in a call to hear.
    //
    // That is LVX27, the oldest open P0 on this project, caught live. A caller
    // who hangs up believing they have an appointment is the single worst thing
    // this system can do, and it is worse than any of the audible defects
    // because the caller cannot detect it.
    //
    // The note is safe in both directions by construction -- a claim can
    // legitimately trail its tool by a turn, and CLAIM_NOTE says "if it
    // genuinely has not happened", never "do it now". The guard is also narrow
    // by design: a claim on a turn where any tool ran is none of its business.
    //
    // LIVE_CLAIM_GUARD=off still disables it without a deploy, for the reason
    // every guard on this path has an off switch.
    if (claimedCompletion && !toolsRanThisTurn() && !toolRanPrevTurn) {
      bumpCounter("live_claim_without_action");
      log.error("live_claim_without_action", { callSid, step: state.step, severity: "warn" });
      if (!claimGuardOff) sendTurnNote("claim", CLAIM_NOTE);
    }

    // LVX93, and it is a MEASUREMENT, not a second guard. No note, no cut, no
    // change to what the model is told -- the condition above still decides
    // that, exactly as before.
    //
    // The gate above is narrow in a way nobody intended: its look-back counts
    // any tool, so a read licenses a write's claim. This counts the honest
    // condition -- a completion claimed with no ACTION tool behind it, this
    // turn or last -- and it is a strict superset, so the DIFFERENCE between
    // the two counters is exactly LVX93's population.
    //
    // Split rather than corrected in place because the next call is a
    // behaviour baseline, and because the fix may not be the one line it looks
    // like: sendTurnNote allows one note per model turn across every
    // mechanism, and on the call that found this the spelling nudge had
    // already spent it. A guard made to fire correctly might still say
    // nothing. Measure first, then decide -- which is the ladder LVX31 left in
    // place for this exact guard.
    if (claimedCompletion && !actionToolsRanThisTurn() && !actionToolRanPrevTurn) {
      bumpCounter("live_claim_unbacked_by_action");
      log.error("live_claim_unbacked_by_action", {
        callSid,
        step: state.step,
        note: "counter only; the claim guard's own condition is unchanged",
        severity: "warn",
      });
    }

    // The unverified-offer guard USED TO BE HERE, and moving it out is LVX80's
    // whole fix. This function runs on turnComplete, by which point the model
    // has stopped generating and audioOut holds only the tail of the turn -- so
    // a cut here would chop the harmless end of a sentence and leave the wrong
    // time already heard. It now runs per fragment as inspectOffer(), beside the
    // leak guard and the repeat cutter, where there is still queued audio to
    // drop. Nothing about the detection changed; only when it can see it.

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
        (replyText && S.nameReadBackRe?.test(replyText)) ||
        // THIRD trigger, 2026-09-09. See the note at the tool-call site: the
        // prompt no longer demands the assistant repeat the name, so
        // nameReadBackRe fires far less often and the two regex triggers alone
        // would leave the nudge weaker than before. A name in a tool argument
        // is a fact rather than a phrasing.
        nameInToolArgsThisTurn
    );
    // NOT FOR A CALLER WHOSE NAME IS ALREADY ON FILE. Added 2026-09-09, after
    // this nudge asked one to spell a name the business already had right.
    //
    // The caller had booked forty minutes earlier, so `Nithin Dodla` was on
    // their record, correctly spelled. The assistant read it off the record and
    // used it — which is fine — and the nudge then fired anyway and made it ask
    // for a spelling. What came back was `n i q h i n g o d l a`. The model
    // sensibly kept the record's version, but a correct name had just been put
    // at risk by a question that had nothing to gain.
    //
    // services/gemini.js's SPELLING NOT YET CONFIRMED block has carried exactly
    // this exception since it was written — "Without this the nudge asked a
    // returning caller to spell a name the business already has right" — and
    // the nudge here never had it. It went unnoticed because the two regex
    // triggers rarely fire for a returning caller: `nameGivenRe` needs them to
    // announce themselves and `nameReadBackRe` needs the assistant to repeat
    // it. The tool-argument trigger added earlier today has no such blind spot,
    // which is what surfaced the gap.
    const nameAlreadyOnFile = callerHasNameOnFile(state.callerContext);
    if (!spellingNudged && !spellingSettled(state) && nameSeenThisTurn && !nameAlreadyOnFile) {
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
        // WITHOUT ASKING IT TO SPEAK, as of 2026-09-05, and the caller heard
        // exactly why. This note fires because the model has JUST SAID a name,
        // so by construction it has already spoken this turn. Sent with
        // turnComplete:true it forced a second consecutive spoken turn, and the
        // model — having nothing new to say — said the same thing again:
        //
        //   18:26:27  "Thanks, Nitin Dadlani. And what's the best number...?"
        //             NOTE spelling  (turnComplete: true)
        //   18:26:35  "Thanks, Nitin Dadlani. Can you spell your full name...?
        //              And what's the best number to reach you on?"
        //   18:26:40  the caller's first word of the whole exchange
        //
        // Three assistant turns, sixteen seconds, and the caller had not spoken
        // once. The log calls that three turns; an ear hears one stream saying
        // the same thing twice, and the owner reported it as the single most
        // off-putting thing about the call.
        //
        // Identical mechanism to call 6's duplicate turn, in a different note.
        // Appending it instead costs one turn of delay -- the model asks for the
        // spelling at its next natural turn, which is the very next thing it
        // says -- and buys back the duplicate.
        sendTurnNote("spelling", SPELLING_NOTE, { requestReply: false });
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

    // -----------------------------------------------------------------------
    // LVX25 and the "anything else" tic. COUNT ONLY -- deliberately last, and
    // deliberately silent.
    //
    // No sendTurnNote. Seven prompt instructions already say "one question at a
    // time" and the model ignores them; a turn note would be an eighth, in the
    // one channel that costs a round-trip. Count first, act once the counter
    // says how often this happens when nothing is wrong. That is the ladder
    // live_claim_without_action climbed, and it is why LIVE_CLAIM_GUARD could
    // be left unset without losing the evidence.
    // -----------------------------------------------------------------------
    if (replyText) {
      // Positive twin, bumped before either check: a call with no faults and a
      // call where this block never ran must not read the same.
      bumpCounter("live_reply_turns_checked");
      summary.recordReplyChecked();

      // HOW MANY THINGS the turn asked, not whether it asked more than one.
      // LVX82, and the counter had to be fixed before the behaviour because
      // until now it could not have shown its own fix working.
      //
      // The boolean this replaces read 1 for a turn asking two things and 1 for
      // a turn asking five. On the deployed calls of 2026-09-07 it fired five
      // times, every time logging `marks: 2`, while the caller was hearing
      // roughly five asks a turn -- so the instrument was reporting a number
      // that could not move when the defect got better or worse.
      //
      // `marks` is kept beside `asks` rather than replaced by it. They disagree
      // on exactly the shape LVX82 is about ("Can I take your name, date of
      // birth, and what it is for?" is one mark and two asks), and `rule` names
      // which half fired, so a conjunction hit is no longer indistinguishable
      // from a near-miss in the logs.
      const questionMarks = (replyText.match(/\?/g) || []).length;
      const asks = countAsks(replyText);
      if (asks > 1) {
        bumpCounter("live_stacked_questions");
        bumpCounterBy("live_stacked_asks_total", asks);
        summary.recordStackedQuestion({ asks });
        log.info("live_stacked_questions", {
          callSid,
          step: state.step,
          asks,
          marks: questionMarks,
          rule: questionMarks > 1 ? (asks > questionMarks ? "both" : "marks") : "conjunction",
        });
      }

      if (S.closingTicRe?.test(replyText)) {
        bumpCounter("live_closing_tic");
      }

      // -------------------------------------------------------------------
      // LVX98. HOW OFTEN DOES THE ASSISTANT OPEN A TURN BY APOLOGISING?
      //
      // Count only, and deliberately not a cut. The machinery for suppressing
      // a spoken segment already exists -- inspectRepeat runs per fragment,
      // before the words reach turnReplyText, and clearAudio tapers what
      // audioOut still holds -- so an apology-preamble cutter is a small change
      // once the number justifies it. It is not justified yet: nothing here
      // knows how often an apology opens a turn on a call where nothing is
      // wrong, and a false cut is audible.
      //
      // The DENOMINATOR is the point of the first counter. Reply turns are
      // already counted by reply_turns_checked; this pair says what fraction of
      // them start with the assistant apologising, and the second one says how
      // many of those follow a note we sent it.
      //
      // The split matters because the two populations have different fixes.
      // "I apologize, but I can only book appointments for future dates" is a
      // clean refusal and belongs in the first number only. What LVX98 is about
      // is the second: six escalating apologies across a third of one call,
      // every one of them downstream of an internal correction that was never
      // written to be heard.
      // -------------------------------------------------------------------
      if (S.apologyPreambleRe) {
        bumpCounter("live_apology_checked");
        if (S.apologyPreambleRe.test(replyText)) {
          bumpCounter("live_apology_turn");
          if (noteSentPrevTurn) {
            bumpCounter("live_apology_after_note");
            log.info("live_apology_after_note", { callSid, step: state.step });
          }
        }
      }

      // -------------------------------------------------------------------
      // LVX95's ORDERING DETECTOR. Target: zero, on every real call.
      //
      // The signature of call be9bd6 exactly -- an ACTION tool executed on this
      // turn, and the same turn also puts the action to the caller as a
      // question. On that call three cancellations committed at 04:53:13 and
      // the confirmation was asked at 04:53:27, fourteen seconds later, with
      // end_call six seconds after that. Had the caller answered no, there was
      // nothing left to stop: cancel_appointment_db is an UPDATE that had
      // already returned three rows.
      //
      // A COUNTER, separate from the gate below, and the separation is the
      // point. The gate refuses and can be turned off; this measures, always,
      // and is how anyone will know whether the gate is working on real calls
      // rather than only in tests. `write_turns_checked` is the denominator, so
      // a call that never wrote and a call that wrote cleanly do not read the
      // same zero.
      // -------------------------------------------------------------------
      if (actionToolsRanThisTurn()) {
        bumpCounter("write_turns_checked");
        if (S.confirmReadBackRe?.test(replyText)) {
          bumpCounter("write_confirm_after_write");
          log.error("write_confirm_after_write", { callSid, step: state.step, severity: "warn" });
        }
      }

      // ---------------------------------------------------------------------
      // A SPOKEN GOODBYE ENDS THE CALL, 2026-09-06.
      //
      // The assistant said "Thanks for calling Digile Media, and have a great
      // day!" and then did nothing: end_call never ran, the line stayed open,
      // and the silence ladder nudged eleven seconds later. The owner's rule is
      // the right one -- once it says thank-you-for-calling, the call should go
      // to an end unless the caller speaks.
      //
      // Armed rather than executed. The exit waits for the goodbye's audio to
      // actually reach the caller, which is the window the caller can speak
      // into, and cancelPendingExit calls it off if they do.
      //
      // Only when end_call has not already run: that path arms its own exit and
      // has a gate in front of it that this must not bypass.
      // ---------------------------------------------------------------------
      // -------------------------------------------------------------------
      // LVX96, ROUTE A. A REFUSAL OUTRANKS THE SIGN-OFF, FOR THIS TURN ONLY.
      //
      // 2026-09-09, call e0a9f6, twenty-five seconds end to end. The caller
      // asked one question and was greeted, answered, farewelled and hung up
      // on before they could reply:
      //
      //   05:02:27.035  end_call   success=FALSE   <- correctly refused
      //   05:02:35.983  "...Thanks for calling Brightwork Studio and have a
      //                  great day.I'm not finding any upcoming appointments
      //                  ... Is there anything else I can help with?"
      //   05:02:35.983  live_goodbye_armed_exit
      //   05:02:37.568  live_exit_run
      //
      // end_call's own declaration requires the model to write its sign-off in
      // the SAME response as the call, so the farewell is composed BEFORE any
      // gate runs. The gate then refused -- correctly, the caller had asked one
      // question and had not been answered -- and this detector read the
      // farewell that the refusal itself had caused, and closed the line.
      //
      // Reproduced textbook twenty minutes later on call 76c2ba. Both times the
      // exit fired within two seconds of the assistant asking the caller a
      // question, and the caller's only rescue was a 1.6-second cancellation
      // window opening while they were still being asked something.
      //
      // Scoped to the TURN. This is not "the model signed off, ignore it": on
      // any turn where nothing refused, the 2026-09-06 rule still holds and the
      // exit still arms.
      // -------------------------------------------------------------------
      bumpCounter("live_goodbye_checked");
      if (endCallRefusedThisTurn && !pendingExit && !endCallArmed && S.signOffRe?.test(replyText)) {
        bumpCounter("live_goodbye_suppressed_by_refusal");
        log.info("live_goodbye_suppressed_by_refusal", { callSid, step: state.step });
      }
      if (!endCallRefusedThisTurn && !pendingExit && !endCallArmed && S.signOffRe?.test(replyText)) {
        // Counted from what armExit actually DID, not from the intention to
        // call it. Bumping first made the counter claim an arming that the
        // barge check had just refused -- a counter lying about the one thing
        // it exists to report.
        if (armExit("end_call")) {
          bumpCounter("live_goodbye_armed_exit");
          log.info("live_goodbye_armed_exit", { callSid, step: state.step });
        }
      }

      // -------------------------------------------------------------------
      // LVX78. Did this turn repeat a recent one, word for word?
      //
      // A caller reported hearing "something repeated in an unnatural way" and
      // could not say what. Nothing in this system could answer that, so four
      // calls were read back by hand -- which found a whole booking recited
      // twice in consecutive turns, a goodbye delivered twice, and a greeting
      // delivered twice. None of them was visible to any counter, and
      // postcall_verify returned `ok` for the call carrying the worst one.
      //
      // COUNT ONLY, and for once that is not caution but arithmetic: by the
      // time this runs the model has already spoken. There is nothing to
      // suppress. What a number buys is knowing whether it happens twice a call
      // or twice a month before anyone designs a fix -- the same ladder the
      // claim guard climbed.
      //
      // The window is the last few turns, not just the previous one, because
      // the doubled goodbye had OUR OWN silence nudge sitting between its two
      // halves.
      // -------------------------------------------------------------------
      if (recentReplies.length) {
        bumpCounter("live_repeat_pairs_checked");
        let longest = 0;
        for (const prior of recentReplies) {
          const run = longestSharedRun(prior, replyText);
          if (run > longest) longest = run;
        }
        if (longest >= REPEAT_RUN_WORDS) {
          bumpCounter("live_repeated_phrase");
          // LENGTH ONLY. The sixteen-word instance was the caller's appointment
          // and phone number; logging the run itself would put caller data in
          // the log, which is LVX24 exactly.
          log.error("live_repeated_phrase", { callSid, step: state.step, words: longest, severity: "warn" });
        }
      }
      recentReplies.push(replyText);
      if (recentReplies.length > REPEAT_WINDOW_TURNS) recentReplies.shift();

      // LVX78's cutter compares against the PREVIOUS completed turn only, not
      // the window: a restatement three turns later is a different thing from
      // one the caller has not had a chance to interrupt.
      lastReplyText = replyText;
      callerSpokeSinceLastReply = false;
      repeatCutThisTurn = false;
    }
  }

  /**
   * The last few assistant turns, for LVX78's repeat check.
   *
   * THREE, because the doubled goodbye had a silence nudge between its halves
   * and two would have been enough for that one instance only. Kept small on
   * purpose: this is a within-a-breath check, and a caller who hears the same
   * sentence again ten turns later has usually asked for it.
   *
   * In memory, capped, and never logged -- it holds whatever the assistant said,
   * which includes names and phone numbers read back to the caller.
   */
  const recentReplies = [];

  let callerTurnCount = 0;
  let lastVoicedMs = 0;
  let speechEndAt = null;
  let awaitingFirstAudio = false;
  let awaitingTranscript = false;
  let modelSpeaking = false;
  let lastBargeAt = -Infinity;
  let endCallArmed = false;
  /**
   * LVX96, route A. Did the end_call gate refuse during THIS model turn?
   *
   * `endCallArmed` cannot answer this. It is only ever set by the SUCCESS
   * branch, so `!endCallArmed` at the sign-off detector reads true both for
   * "the model never asked to hang up" and for "the model asked this very turn
   * and was told no" -- and on 2026-09-09 that second case armed an exit off
   * the farewell the refusal itself had caused to be spoken. Twice, in one
   * evening, on the ordinary path.
   *
   * PER TURN, and that is the whole design. A permanent suppression reinstates
   * the 2026-09-06 defect the sign-off detector exists for: the assistant says
   * thank-you-for-calling, nothing runs, and the line dangles until the silence
   * ladder nudges eleven seconds later. Both rules are right; what they needed
   * was an order of precedence within one turn, not a third condition bolted
   * onto one of them.
   */
  let endCallRefusedThisTurn = false;
  /**
   * LVX96, route B. Did an `armExit("end_call")` ask get turned down?
   *
   * `armExit` returns false inside HANGUP_GRACE_MS of a barge and does NOT set
   * `pendingExit`, so nothing records that a hang-up was wanted and denied. The
   * end-of-turn retry then re-asks on every subsequent turn, because
   * `endCallArmed` is never lowered -- turning a guard that was supposed to
   * protect a talking caller into an eleven-second deferral of the same
   * hang-up, fired eventually on a turn that ended in a fresh question.
   */
  let endCallArmRefused = false;
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
   * LVX78's cutter state.
   *
   * `lastReplyText` is the previous COMPLETED assistant turn, and
   * `callerSpokeSinceLastReply` is the structural half of the condition -- the
   * thing that tells a defect apart from a caller who asked to hear it again.
   */
  /** Set between the exit's mark arriving and the call actually closing. */
  let exitGraceTimer = null;
  let lastReplyText = "";
  let callerSpokeSinceLastReply = false;
  /**
   * LVX30's latch. A local, not a field on `state` -- see the write site.
   * Whether the caller has ever produced a non-echoed final on this call.
   */
  let sawCallerFinal = false;
  let repeatCutsThisCall = 0;
  /** Reset every turn: a turn may be cut at most once. */
  let repeatCutThisTurn = false;
  /** LVX80. Same shape as the repeat cutter's pair, same reasons. */
  let offerCutsThisCall = 0;
  let offerHandledThisTurn = false;
  /** True only while the end-of-call sweep re-issues a refused message write. */
  let lastChanceWrite = false;

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
    // LVX95. The PREVIOUS completed assistant turn, for the write-order gate.
    //
    // The half of "did the caller agree to this" that the caller's own words
    // cannot supply: a yes only means something if something was put to them.
    // Read at the tool boundary rather than asserted by the model, which is the
    // whole difference from confirmBeforeWrite -- that one is an argument the
    // model sets about itself, and a model that will narrate a confirmation
    // AFTER the fact is a model that will set the flag BEFORE it.
    //
    // Already maintained for LVX78's repeat cutter, so this costs nothing new;
    // what it needs is the copy into ctx, which is the wire
    // tests/liveToolContext.test.js exists to assert. A field produced here and
    // not copied there is how the hang-up gate sat unreachable for the life of
    // a deployment with end_call_refused_hesitation reading 0 throughout.
    lastReplyText,
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
    // LVX72. Action tools refused and never afterwards completed, derived the
    // same way finish() derives `abandoned` for the post-call read -- the
    // difference being that this is available WHILE the call is still up, which
    // is the only point at which anything could be done about it.
    //
    // Names, not a count: "something was abandoned" is not actionable, which
    // was LVX71's mistake one layer up. Nothing here is caller data.
    abandonedWrites: [...refusedToolsThisCall].filter((n) => !completedToolsThisCall.has(n)),
    // Only ever true inside saveOutstandingMessage, and only for a message.
    lastChance: lastChanceWrite,
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
  function clearAudio(atMs, { fadeMs = 120, barge = false } = {}) {
    // fadeMs 0 is a HARD clear, and the difference matters. A tapered clear
    // drops only what audioOut still holds locally and lets Twilio finish
    // playing what it already has; a hard clear also sends Twilio a `clear`
    // event, which discards its buffer too. A barge wants the taper -- it
    // sounds like ducking rather than a cut. A leak wants the hard stop,
    // because the audio Twilio is holding is exactly what must not be heard.
    audioOut?.clear(fadeMs > 0 ? { fadeMs } : {});
    echoGuard.noteAudioStopped(atMs);
    // WHAT A PENDING EXIT DOES HERE DEPENDS ON WHY THE AUDIO WAS CLEARED, and
    // getting that wrong costs something either way.
    //
    // This used to be an unconditional `if (pendingExit) runExit(...)`, and that
    // line exists for a real reason: audioOut.clear() empties outstandingMarks,
    // so the exit's mark never reaches the wire, Twilio never echoes it, and the
    // exit sits out its full fifteen-second backstop. Fifteen seconds of dead
    // air after a goodbye. tests/liveRegressions.js pins exactly that.
    //
    // But it is also why interrupting a goodbye HUNG THE CALLER UP FASTER, which
    // is the opposite of what interrupting means and the opposite of what was
    // asked for.
    //
    // Both are true, so the caller's own speech is the thing that separates
    // them. A barge CANCELS the exit -- they want to say something, and there is
    // no dead air because they are talking. Any other clear still RUNS it, for
    // the original reason.
    if (pendingExit) {
      if (barge) cancelPendingExit("barge");
      else runExit("audio_cleared");
    }
  }

  /**
   * The caller spoke while a hang-up was pending, so call it off.
   *
   * The owner's request, in their words: "add a slight delay or something to the
   * end call item so that if the user barges in the receptionist doesn't just go
   * straight through and end." The delay already existed -- an exit waits for
   * its audio mark -- but nothing used the window, and clearAudio actively
   * shortened it.
   *
   * Deliberately silent about WHY it was armed. A caller who interrupts a
   * goodbye wants to say something, not to be told the hang-up was cancelled.
   */
  function cancelPendingExit(reason) {
    if (!pendingExit) return;
    bumpCounter("live_exit_cancelled_by_caller");
    log.info("live_exit_cancelled", { callSid, kind: pendingExit.kind, reason });
    pendingExit = null;
    clearTimeout(exitTimer);
    exitTimer = null;
    // The grace timer as well. Without this the caller cancels the hang-up and
    // the call closes a second later anyway, which is the same defect wearing a
    // delay.
    clearTimeout(exitGraceTimer);
    exitGraceTimer = null;
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
    offerHandledThisTurn = false;
    // BEFORE the reset, exactly as toolRanPrevTurn is: the look-back is the
    // whole content of live_apology_after_note, and reading a flag after
    // clearing it is how that counter would have read zero forever.
    noteSentPrevTurn = noteSentThisTurn;
    noteSentThisTurn = false;
    // LVX96 route A. Cleared HERE and not earlier: auditTurn runs immediately
    // before applyTurn at the turnComplete site, and auditTurn is where the
    // sign-off detector reads this. Clearing it any sooner makes the
    // suppression unreachable, which is the same shape of bug as a producer
    // whose field is never copied.
    endCallRefusedThisTurn = false;
    // Cleared alongside the other per-turn latches, and AFTER auditTurn has
    // read it at the turnComplete site.
    nameInToolArgsThisTurn = false;
    toolRoundsThisTurn = 0;
    // BEFORE the reset below, or the look-back always reads false and the
    // claim guard fires on every legitimate trailing confirmation.
    toolRanPrevTurn = toolsRanThisTurn();
    actionToolRanPrevTurn = actionToolsRanThisTurn();
    realToolCallsThisTurn = 0;
    actionToolCallsThisTurn = 0;
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
  /**
   * LVX78. Cut the model restating itself when the caller has not asked it to.
   *
   * The owner's single loudest complaint: "it says the same thing twice in a
   * row... that is a big issue." The log of 2026-09-05 shows it exactly --
   *
   *   18:28:04  "...Would you prefer 9:00 AM, 1:00 PM, or 4:30 PM? ..."
   *   18:28:16  "Sure, we have slots open at 9:00 AM, 1:00 PM, or 4:30 PM..."
   *   18:28:18  the caller's first word since 18:27:53
   *
   * -- two entries in the log, twelve seconds apart, with no caller speech
   * between them. To an ear that is one stream saying the same thing twice.
   *
   * ---------------------------------------------------------------------------
   * Why this is allowed to act when the tic and the stacked questions are not
   * ---------------------------------------------------------------------------
   *
   * Those two are judgements about phrasing. This has a STRUCTURAL condition:
   * the caller has not spoken since the previous assistant turn. That is what
   * separates the defect from its most obvious false positive -- a caller who
   * says "sorry, could you repeat that?" SHOULD hear it again, and in that case
   * they have spoken, so nothing fires.
   *
   * ---------------------------------------------------------------------------
   * What it cannot do, stated plainly
   * ---------------------------------------------------------------------------
   *
   * The transcript lags the audio it describes, so the opening of the repeated
   * sentence has usually been heard by the time we can recognise it. This makes
   * a repeat SHORTER, not absent. The leak guard is the precedent and its record
   * is seven cut and four missed; this gets more warning than the leak guard
   * does, because it is matching a whole restated sentence rather than a single
   * word, but it is the same mechanism with the same ceiling.
   *
   * Capped per call, and switchable off without a deploy, for the reason LVX21
   * exists: a guard with a hair trigger on this path is worse than the defect.
   */
  function inspectRepeat(fragment, atMs) {
    if (repeatCutOff) return;
    if (repeatCutsThisCall >= MAX_REPEAT_CUTS) return;
    // ONCE PER TURN. On a real call this fired three times in 173 milliseconds
    // on a single turn and burned the whole call's cap, leaving everything after
    // it unprotected. Once a cut is made the following fragments still match the
    // head, so without this it keeps firing. The leak guard has had
    // leakHandledThisTurn for the same reason since it was written.
    if (repeatCutThisTurn) return;

    bumpCounter("live_repeat_cut_checked");
    const soFar = `${turnReplyText}${fragment}`;

    // TWO SHAPES, and the second was the one the owner actually heard.
    //
    // ACROSS TURNS: the model restates its previous turn and the caller has not
    // spoken since. The silence is the structural half of the condition -- a
    // caller who says "sorry, could you repeat that?" has spoken, so this does
    // not fire on the one legitimate repeat there is.
    const acrossTurns =
      !callerSpokeSinceLastReply &&
      lastReplyText &&
      longestSharedRun(lastReplyText, soFar) >= REPEAT_RUN_WORDS;

    // WITHIN ONE TURN: the model says a thing, then says it again, without ever
    // stopping. 2026-09-05, and it is a single logged turn:
    //
    //   "Great, so that's Monday, September 7th at 9 AM for your strategy call.
    //    Is there anything else I can help you with today? No? Then thanks for
    //    calling Digile Media and have a great day.Great, so that's Monday,
    //    September 7th at 9 AM. Is there anything else I can help you with
    //    today? Thanks for calling Digile Media, have a great weekend."
    //
    // Confirmation, closing question, an answer to its OWN question, a goodbye
    // -- and then all of it again. The owner described it as going "on a tangent
    // and saying four things it wasn't supposed to say".
    //
    // No caller condition applies here, because the caller has had no chance to
    // ask for anything: this is one uninterrupted stretch of speech. A model
    // repeating six or more words of ITSELF inside one turn has no legitimate
    // reading.
    //
    // Compared as head-versus-tail rather than fragment-versus-everything: the
    // vendor delivers transcription in small chunks, and a two-word chunk can
    // never reach the threshold on its own.
    // Split on WORDS, not characters, and that correction came from a call.
    //
    // The first version required the turn to exceed 280 characters before it
    // compared head against tail. On 2026-09-06 the assistant said "You're very
    // welcome. Thanks for calling Digile Media, have a great day." TWICE, and
    // the owner heard both. Doubled, that is 142 characters -- so the check did
    // not miss it, it never ran at all.
    //
    // A character gate was arbitrary. What decides whether a repeat can exist is
    // how many WORDS there are: below two runs' worth there is nothing a repeat
    // could be made of, and above it the comparison is worth doing however short
    // the sentence.
    let withinTurn = false;
    if (!acrossTurns) {
      const words = soFar.split(/\s+/).filter(Boolean);
      if (words.length >= REPEAT_RUN_WORDS * 2) {
        // The tail is capped at REPEAT_TAIL_WORDS but never more than HALF the
        // turn, and the halving is the part that matters. A fixed 25-word tail
        // on a 26-word turn leaves a one-word head, so a sentence said exactly
        // twice -- the observed case, and the most obvious repeat there is --
        // had nothing left to compare against.
        const tailLen = Math.min(REPEAT_TAIL_WORDS, Math.floor(words.length / 2));
        const tail = words.slice(-tailLen).join(" ");
        const head = words.slice(0, words.length - tailLen).join(" ");
        withinTurn = Boolean(head) && longestSharedRun(head, tail) >= REPEAT_RUN_WORDS;
      }
    }

    if (!acrossTurns && !withinTurn) return;

    // THE GREETING IS NEVER CUT.
    //
    // The owner heard a clipped greeting: this fired during the opening line,
    // which the char counts said was being spoken twice. A doubled greeting is
    // annoying; a mangled greeting is the first thing every caller hears, and
    // there is no recovering a first impression. The cascade has protected this
    // turn since before this front-end existed -- "the greeting is
    // uninterruptible: barge-in is disarmed until it finishes."
    //
    // Counted rather than acted on, so how often the greeting doubles is still
    // learned without spending the opening line to learn it.
    if (!callerTurnCount && !lastReplyText) {
      repeatCutThisTurn = true;
      bumpCounter("live_repeat_would_cut_greeting");
      log.error("live_repeat_would_cut_greeting", { callSid, chars: soFar.length, severity: "warn" });
      return;
    }

    repeatCutThisTurn = true;
    repeatCutsThisCall += 1;
    bumpCounter("live_repeat_cut");
    // Length only. The repeated text is whatever the assistant was saying, which
    // on the observed call included the caller's own appointment details.
    log.error("live_repeat_cut", {
      callSid,
      step: state.step,
      // Which shape fired. Across-turns and within-turn are different defects
      // with different fixes, and one counter cannot say which one happened.
      kind: acrossTurns ? "across_turns" : "within_turn",
      chars: soFar.length,
      cuts: repeatCutsThisCall,
      severity: "warn",
    });
    // TAPERED, unlike the leak guard's hard stop. A leak must not be heard at
    // all, so it takes Twilio's buffer with it; a repeat is merely unwanted, and
    // a hard clear in the middle of ordinary speech sounds like the line
    // dropping rather than like the assistant stopping.
    clearAudio(atMs);
  }

  /**
   * An OFFER of appointment times on a call where nothing has ever verified
   * one. LVX80.
   *
   * ---------------------------------------------------------------------------
   * Why this is here and not in auditTurn, where it used to be
   * ---------------------------------------------------------------------------
   *
   * Because auditTurn runs on turnComplete, and by then the model has finished
   * generating and audioOut is holding the TAIL of the turn. A clear there cuts
   * the harmless end of the sentence and leaves the wrong time already heard --
   * which is exactly what the caller reported on 2026-09-07: the offer went out
   * at 19:38:59.313 and check_appointment_availability ran at 19:39:00.325, one
   * second later, with OFFER_NOTE correcting into a caller who had already been
   * told 11:30pm. The lookup was never broken. It was late.
   *
   * The leak guard cuts successfully because it runs per FRAGMENT, while the
   * rest of the turn is still queued locally. This is the same mechanism, and
   * its ceiling is the same: seven cut and four missed, measured. A phrase
   * match gets more warning than the leak guard's single word does.
   *
   * ---------------------------------------------------------------------------
   * The authority is the verified set, not the sentence
   * ---------------------------------------------------------------------------
   *
   * guards.js's verifiedSlots is filled only from a real availability tool's own
   * response, and is what the booking invariant already gates on, so this needs
   * no parsing of the times themselves. It therefore does NOT catch a wrong time
   * quoted after a genuine check -- a smaller hole than the one it closes.
   *
   * ---------------------------------------------------------------------------
   * The false positive, stated rather than discovered
   * ---------------------------------------------------------------------------
   *
   * At fragment time verifiedCount() is 0 both for a model that offered before
   * checking and for one that is about to check on this same turn. The note-only
   * guard had that exposure already and it was accepted; what changes is that a
   * false positive is now audible. Three things bound it: once per turn, three
   * per call, and LIVE_OFFER_CUT=off. Tenants whose availability tool is the EHR
   * `get_available_slots` leave the invariant unarmed (guards.js), and this
   * fails open with it, unchanged.
   */
  function inspectOffer(fragment, atMs) {
    if (offerHandledThisTurn) return;
    if (runner?.guards?.verifiedCount?.() > 0) return;

    const S = getStrings(state.config);
    // The same window the leak guard and the repeat cutter see: what we had
    // said, plus what just arrived. An offer can straddle a fragment boundary.
    const soFar = `${turnReplyText}${fragment}`;
    if (!S.slotOfferRe?.test(soFar)) return;

    offerHandledThisTurn = true;
    bumpCounter("live_offer_unverified");

    // How much of what we are saying has NOT yet reached the caller. The leak
    // guard's comment applies here word for word: outputAudioTranscription lags
    // the audio it describes, audioOut paces that audio out over real time, and
    // whether the first lag is shorter than the second decides whether there was
    // ever anything to cut. Measured per offer rather than assumed, and the two
    // outcomes get separate counters so "we cut it" and "we were too late" never
    // collapse into one number.
    const cutWindowMs = Math.round((audioOut?.aiAudioPlayingUntil() ?? 0) - atMs);
    const cut = cutWindowMs > 0 && !offerCutOff && offerCutsThisCall < MAX_OFFER_CUTS;
    bumpCounter(cut ? "live_offer_cuts" : "live_offer_cut_missed");

    // Never the transcript. What the assistant says carries the caller's own
    // details back to them -- their name, their number, their appointment -- so
    // the text is PHI even though the defect is ours.
    log.error("live_offer_unverified", {
      callSid,
      step: state.step,
      cut_window_ms: cutWindowMs,
      cut,
      cuts: offerCutsThisCall + (cut ? 1 : 0),
      severity: "warn",
    });

    if (cut) {
      offerCutsThisCall += 1;
      // HARD, not tapered, on clearAudio's own reasoning: a tapered clear lets
      // Twilio finish playing the ~100 ms it already holds. A time nothing has
      // checked is the leak's category, not the repeat's -- the audio Twilio is
      // holding is exactly what must not be heard.
      clearAudio(atMs, { fadeMs: 0 });
    }

    // The note goes either way, including when the cut was too late. A caller
    // who has heard the whole wrong time needs the correction MORE, not less.
    if (!claimGuardOff) sendTurnNote("offer", OFFER_NOTE);
  }

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
    // -----------------------------------------------------------------------
    // AT MOST TWO PER CALL, because the note is part of the loop.
    //
    // The leak note is delivered as a synthetic USER turn -- the only
    // engine-to-model channel this API offers when no tool call is in flight --
    // so a model already emitting meta-text is handed more text and emits more.
    // Measured twice:
    //
    //   LVX37       six cycles, turns: 0, usage.audio_out: 13, and a caller
    //               who heard silence for the whole call.
    //   2026-09-09  two cycles 3.5s apart, then it recovered on the third.
    //
    // LVX37 blamed VOICE_INTENT_MARKER for that loop. The marker is forced OFF
    // on this front-end (see the extras at connect) and the loop happened
    // anyway, so the marker was A trigger and not THE mechanism.
    //
    // Two, because the second cycle is where the evidence divides: one call
    // recovered after it and one did not, so a cap of one would cut off a
    // recovery that has been observed working. Past two the note is not helping
    // and is measurably part of the problem.
    //
    // THE CALLER IS PROTECTED EITHER WAY. Capping the note does not uncap the
    // guard: the detection, the audio cut and every counter carry on for the
    // rest of the call. All that stops is talking to the model about it.
    // -----------------------------------------------------------------------
    if (leakNotesThisCall >= MAX_LEAK_NOTES) {
      bumpCounter("live_outbound_notes_capped");
      log.error("live_outbound_notes_capped", { callSid, sent: leakNotesThisCall, severity: "warn" });
    } else if (sendTurnNote("leak", buildLeakNote(described ? verdict.matched : null))) {
      leakNotesThisCall += 1;
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

  // -----------------------------------------------------------------------
  // LVX70 -- one record per caller speech EPISODE. An instrument, not a guard:
  // nothing behaves differently because of anything below.
  //
  // The unit is the RAW VAD episode, not the strategy's turn, and that is the
  // whole point. If the half-duplex gate withholds every frame of an utterance
  // and then discards them, the strategy never sees a voiced frame, so no turn
  // ever opens and no turn ever closes -- the utterance is invisible to every
  // existing instrument on this path. That is precisely the case LVX70 needs
  // to rule in or out, so it cannot be measured with a unit that presumes it
  // did not happen.
  //
  // Reading a record: `forwarded: 0` with `dropped` non-zero means the model
  // was never given that audio, and no endpointing setting on either side
  // could have ended the turn. `forwarded` non-zero with a large
  // `transcript_ms` means the vendor had it and held the turn open.
  //
  // No caller text ever appears here -- `transcript_chars` only, the same rule
  // live_unusable_transcript follows.
  // -----------------------------------------------------------------------

  /** Measured transcript lag on this path is 113-360 ms. Ten times the worst
   *  of that is not a slow transcript, it is a turn that was held open. */
  const LATE_TRANSCRIPT_MS = 3_000;
  /** How many newer episodes must close before an older one is adjudicated. */
  const UTT_PENDING_CAP = 3;

  let uttSeq = 0;
  /** The caller speech episode in progress, or null. */
  let openUtt = null;
  /** Closed episodes not yet adjudicated, oldest first. */
  const pendingUtts = [];

  /** The episode a late signal belongs to: the open one, else the most recent. */
  function currentUtt() {
    return openUtt || pendingUtts[pendingUtts.length - 1] || null;
  }

  function adjudicateUtterance(u) {
    if (!u) return;
    if (u.transcriptAtMs === null) {
      // Only a fault when the vendor HAD the audio. An utterance we withheld
      // entirely is already counted by live_utterance_all_withheld, and
      // counting it twice would make the gate's own losses look like vendor
      // silence -- which is the confusion this whole instrument exists to end.
      if (u.forwarded > 0) bumpCounter("live_utterance_no_transcript");
    } else if (u.closedAtMs !== null && u.transcriptAtMs - u.closedAtMs > LATE_TRANSCRIPT_MS) {
      bumpCounter("live_utterance_late_transcript");
    }
    log.info("live_utterance", {
      callSid,
      step: state.step,
      utterance: u.id,
      opened_ms: u.openedAtMs,
      duration_ms: u.closedAtMs === null ? null : u.closedAtMs - u.openedAtMs,
      voiced_ms: u.voicedFrames * 20,
      peak_rms: u.peakRms,
      playing_at_open: u.playingAtOpen,
      frames: u.frames,
      forwarded: u.forwarded,
      held: u.held,
      // Voiced frames only. See halfDuplex.push -- counting every frame that
      // fell out of the ring reported 2,540 losses on an utterance that
      // forwarded all 374 of its own.
      dropped_voiced: u.dropped,
      released: u.released,
      strategy_opened: u.strategyOpened,
      close_rule: u.closeRule,
      transcript_ms:
        u.transcriptAtMs === null || u.closedAtMs === null ? null : u.transcriptAtMs - u.closedAtMs,
      transcript_chars: u.transcriptChars,
    });
  }

  function closeUtterance(atMs) {
    if (!openUtt) return;
    const u = openUtt;
    openUtt = null;
    u.closedAtMs = Math.round(atMs);
    // The positive twin. Bumped for every episode that opened and closed,
    // whatever became of it -- a call reading zero here is a call where the
    // instrument never ran, which is a different fact from a clean one.
    bumpCounter("live_utterance_observed");
    if (u.forwarded === 0) bumpCounter("live_utterance_all_withheld");
    pendingUtts.push(u);
    while (pendingUtts.length > UTT_PENDING_CAP) adjudicateUtterance(pendingUtts.shift());
  }

  /** Drain everything still open or pending. Called once, from finish(). */
  function flushUtterances(atMs) {
    closeUtterance(atMs);
    while (pendingUtts.length) adjudicateUtterance(pendingUtts.shift());
  }

  /**
   * Attribute an arriving transcript to the utterance it belongs to.
   *
   * CORRECTED after call 1, 2026-09-04. The first version took the oldest
   * pending utterance without a transcript, which is right only while every
   * utterance gets one. Utterance 3 of that call never did -- its audio was
   * withheld and dropped, so the vendor had nothing to transcribe -- and every
   * transcript afterwards shifted onto the wrong utterance. `transcript_ms`
   * then read 14550, 27748, 43776 and 29624 against a measured
   * input_transcript_lag_ms_p50 of 412, and live_utterance_late_transcript
   * counted four "held turns" that were my own bookkeeping.
   *
   * An utterance that forwarded NOTHING can never have a transcript, so it must
   * not be able to absorb one. That single rule is what was missing.
   */
  function noteUtteranceTranscript(text, atMs) {
    const u =
      pendingUtts.find((x) => x.transcriptAtMs === null && x.forwarded > 0) || openUtt;
    if (!u) return;
    u.transcriptAtMs = Math.round(atMs);
    u.transcriptChars += (text || "").length;
  }

  function utteranceFrame({ atMs, v, playing, forwarded, held, dropped, released }) {
    if (v.voiceActive && !openUtt) {
      uttSeq += 1;
      openUtt = {
        id: uttSeq,
        openedAtMs: Math.round(atMs),
        playingAtOpen: playing,
        frames: 0,
        voicedFrames: 0,
        forwarded: 0,
        held: 0,
        dropped: 0,
        released: 0,
        peakRms: 0,
        strategyOpened: false,
        closeRule: null,
        closedAtMs: null,
        transcriptAtMs: null,
        transcriptChars: 0,
      };
    }

    // The gate discards its ring when playback ENDS, which is normally after
    // the caller has already stopped -- an "okay" spoken over the assistant is
    // dropped a beat after it finished being said. Attributing those frames to
    // the episode that just closed is what makes that case legible at all.
    const target = currentUtt();
    if (!target) return;
    target.dropped += dropped || 0;
    target.released += released || 0;
    if (!openUtt) return;

    openUtt.frames += 1;
    openUtt.forwarded += forwarded;
    openUtt.held += held || 0;
    if (v.voiced) openUtt.voicedFrames += 1;
    if (v.rms > openUtt.peakRms) openUtt.peakRms = Math.round(v.rms);

    if (!v.voiceActive) closeUtterance(atMs);
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

    const { forward, barge, held, dropped, released } = gate.push({
      frame: mulawFrame,
      playing,
      // LVX70: the gate needs the VAD's per-frame verdict, not only the run
      // length, so it can tell speech it withheld from silence it withheld.
      voiced: v.voiced,
      isActive: v.voiceActive,
      voicedRunMs,
    });
    if (released > 0) bumpCounter("live_gate_speech_released");

    // LVX70. Runs on every frame, changes nothing, and is the only place that
    // records what the gate did with the caller's audio.
    utteranceFrame({ atMs, v, playing, forwarded: forward.length, held, dropped, released });

    if (barge) {
      summary.recordBarge();
      clearAudio(atMs, { barge: true });
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
      // LVX70: an episode the strategy never opened is one it was never given.
      const opening = currentUtt();
      if (opening) opening.strategyOpened = true;
      signal("start");
    }
    if (verdict.close) {
      speechEndAt = atMs;
      awaitingFirstAudio = true;
      awaitingTranscript = true;
      callerTurnCount += 1;
      summary.recordTurn();
      if (verdict.shape) summary.recordHoldShape(verdict.shape);
      // LVX70: the close rule was previously discarded in the vendor and
      // hangover arms -- only arm C's `shape` survived, so the one number
      // saying WHY a turn ended was unavailable in the arm that is running.
      const closing = currentUtt();
      if (closing) closing.closeRule = verdict.rule || null;
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

  /**
   * Record what a tool round produced, into the ledgers the post-call read uses.
   *
   * Shared by the model's own tool calls and by retryPendingWrite below. Two
   * writers into one ledger, maintained separately, is how a ledger goes wrong
   * -- and this is the ledger postcall_verify reconciles against the database.
   */
  function recordToolOutput(out) {
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
  }

  /**
   * Re-issue the write the spelling gate refused, once the caller has answered.
   *
   * LVX72's real fix, and the reason it is here rather than in a refusal
   * message. FOUR calls have now lost a booking on this one path: the gate
   * refuses pending a spelling, the caller spells it, and the model announces
   * the booking without ever calling the tool again. Three separate texts have
   * asked it to -- LVX34's rewritten gate refusal, the abandoned-write refusal,
   * and the hang-up gate -- and all three were ignored, because a refusal
   * message is a request.
   *
   * Call 4 also settled that blocking the exit cannot help. end_call's own
   * declaration makes the model write its sign-off in the SAME response as the
   * call, so the goodbye is already spoken before any gate runs: the caller
   * heard "You're all set then" with booked_rows 0, and was then held on the
   * line for six seconds of dead air and a nudge.
   *
   * So the write happens without the model's cooperation. It goes THROUGH
   * `runner.handleToolCall`, not around it, so the availability invariant, the
   * name-provenance check, the consent gate and the duplicate guard all still
   * apply. This is a retry of a refused call, not a bypass of the refusal --
   * and if the gate would still refuse, it still refuses.
   *
   * NO sendToolResponse: there is no outstanding vendor tool call to answer.
   * The model is told through a turn note instead, in BOTH directions --
   * leaving it to guess after a failure is how a caller gets told about a
   * booking that does not exist, which is the defect itself.
   */
  async function retryPendingWrite() {
    if (!runner || !session || closed) return;
    const pending = runner.takePendingWrite?.();
    if (!pending) return;

    // CAPTURED HERE, SYNCHRONOUSLY, AND THAT PLACEMENT IS THE WHOLE POINT.
    //
    // This function is invoked fire-and-forget from the turnComplete handler
    // and awaits a tool round before it sends its note. The caller does not
    // wait: applyTurn() runs on the very next line and CLEARS turnReplyText.
    // Read after the await, this is always "" -- which reads as "the model said
    // nothing" on every single call, including the ones where it spoke.
    //
    // Found by a test, not by reasoning: moving the read after the await made
    // call 6's case fail while today's passed, which is precisely the tell for
    // a value that has been cleared underneath you.
    const modelSpokeThisTurn = Boolean(turnReplyText.trim());

    bumpCounter("write_retry_attempted");
    let out;
    pendingToolCalls += 1;
    try {
      out = await runner.handleToolCall({
        functionCalls: [{ id: `retry_${pending.name}`, name: pending.name, args: pending.args }],
      });
    } catch (err) {
      log.error("live_write_retry_error", {
        callSid,
        tool: pending.name,
        reason: err?.message,
        severity: "warn",
      });
      return;
    } finally {
      // In a finally for the same reason onToolCall's is: a throw must not
      // leave the silence ladder suppressed for the rest of the call.
      pendingToolCalls -= 1;
    }

    recordToolOutput(out);
    const ok = out.functionResponses?.[0]?.response?.success === true;
    bumpCounter(ok ? "write_retried_after_spelling" : "write_retry_refused");
    log.info("live_write_retried", { callSid, tool: pending.name, ok });

    // A booking that was refused for a SPELLING carries a name the caller has
    // since spelled, and the replayed arguments do not. Say so.
    const nameAtStake = ok && state.spellingCaptured && pending.args?.client_name;
    if (nameAtStake) bumpCounter("write_retry_name_unspelled");
    // WHETHER THIS NOTE ASKS THE MODEL TO SPEAK, and the condition was wrong.
    //
    // It used to be `!ok` -- speak on failure, stay silent on success. The
    // reasoning was call 6's: a successful retry means the model has already
    // told the caller the right thing, and asking it to reply made it repeat
    // that sentence word for word, 43 ms later, out loud.
    //
    // That is true of call 6 and it is not what the condition actually tests.
    // On 2026-09-05 the caller spelled their name, THE MODEL PRODUCED A TURN
    // WITH NO TEXT AT ALL, our retry saved the booking, and this note was
    // appended silently because the retry had succeeded. Nobody said anything.
    // The silence ladder nudged twice and the call ended 44 seconds later with
    // `postcall_verify: row_without_claim` -- a real booking the assistant
    // never mentioned to the person who made it.
    //
    // Success and failure both happen with and without the model having spoken,
    // so `ok` cannot separate these. The question that can is whether THE
    // CALLER IS WAITING ON AN ANSWER, and on this path a turn that produced no
    // text is exactly that: the model had its turn and used it to say nothing.
    //
    // `turnReplyText` is read here rather than after, because this runs BEFORE
    // applyTurn() clears it -- the same ordering the comment at the call site
    // depends on.
    sendTurnNote(
      "write_retried",
      !ok ? WRITE_RETRY_FAILED_NOTE : nameAtStake ? WRITE_RETRIED_NAME_NOTE : WRITE_RETRIED_NOTE,
      // A FAILED retry always speaks: the caller has been told about a booking
      // that does not exist and only the model can correct that out loud. A
      // SUCCESSFUL one speaks only when the model has left the caller waiting.
      { requestReply: !ok || !modelSpokeThisTurn }
    );
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
    // THE SPELLING NUDGE'S THIRD TRIGGER, and it is the only one that cannot
    // miss a phrasing.
    //
    // The nudge fires on `nameGivenRe(caller) || nameReadBackRe(assistant)`.
    // The second half watches for the assistant repeating the name — which the
    // prompt used to DEMAND, and no longer does as of 2026-09-09. Removing that
    // instruction would otherwise have quietly halved the trigger coverage and
    // left `nameGivenRe` alone, which is already recorded as having missed two
    // consecutive calls: the caller said "let's do uh Nathan Dodla", there was
    // no lead-in to anchor on, and live_spelling_ask_nudged read 0 against
    // spelling_gate_refusals 2.
    //
    // A tool argument is not a phrasing. If the model is trying to write a name
    // down, a name is in play, whatever anybody said to get there — so this
    // trigger holds however the caller introduces themselves and however the
    // assistant chooses to acknowledge it.
    //
    // Reads the same two argument names as services/tools.js's own
    // callerNameFromArgs, deliberately: a nudge that fires on a different set
    // of arguments from the gate it is trying to get ahead of would be nudging
    // for writes that were never going to be refused.
    for (const fc of toolCall.functionCalls || []) {
      const named = fc?.args?.client_name ?? fc?.args?.caller_name;
      if (typeof named === "string" && named.trim()) {
        nameInToolArgsThisTurn = true;
        break;
      }
    }
    realToolCallsThisTurn += (toolCall.functionCalls || []).length;
    // LVX93's half: attempts that could CHANGE something, so a read cannot
    // vouch for a write's claim. ACTION_TOOL_NAMES is the same list the tool
    // runner and the post-call verifier already use.
    actionToolCallsThisTurn += (toolCall.functionCalls || []).filter((fc) =>
      ACTION_TOOL_NAMES.includes(fc.name)
    ).length;

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
    // LVX96, route A. The gate said no, ON THIS TURN.
    //
    // Two consumers, and they want the same fact for different reasons:
    // the per-call summary, because a process-global counter cannot say which
    // call refused; and the sign-off detector in auditTurn, which must not arm
    // an exit on a goodbye the model spoke only BECAUSE it was refused.
    if (out.endCallRefusal) {
      endCallRefusedThisTurn = true;
      summary.recordEndCallRefusal(out.endCallRefusal);
    }
    recordToolOutput(out);

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
      // AFTER the leak guard and BEFORE the fragment is appended, so both see
      // the same "what we had said" + "what just arrived" window. A leak is the
      // more serious of the two and gets first refusal on the turn.
      inspectRepeat(sc.outputTranscription.text, atMs);
      // LVX80, last of the three and before the fragment is appended so it sees
      // the same window as the other two. A leak keeps first refusal on the
      // turn and a repeat second: both are about words that should not have
      // been said at all, where an unverified offer is about a fact that is
      // merely not established yet.
      inspectOffer(sc.outputTranscription.text, atMs);
      turnReplyText += sc.outputTranscription.text;
    }

    if (sc.inputTranscription?.text) {
      // LVX70, before the echo gate on purpose: an echoed transcript is still
      // evidence about WHEN the vendor emitted words for a given episode, and
      // suppressing it here would leave the episode looking untranscribed.
      noteUtteranceTranscript(sc.inputTranscription.text, atMs);
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
        // LVX30's latch, and it belongs AFTER the echo gate: an echo of our own
        // greeting is not a caller speaking. /twilio/status requires BOTH this
        // and zero caller transcript rows before tagging a short call as spam
        // (server.js:873), and without the latch every brief Live call is a
        // spam candidate. Set once.
        //
        // The cascade hit an ordering bug here -- its pickup write carries the
        // whole state object, which at that moment includes
        // sawCallerFinal:false, so a caller who spoke over the greeting could
        // produce latch-then-pickup and have the latch undone. This path
        // cannot: `state` has no sawCallerFinal key at all, and sharedSlice
        // skips undefined. Keeping it off the state object is what makes that
        // true, so it is a local rather than a field on purpose.
        if (!sawCallerFinal) {
          sawCallerFinal = true;
          writeCallState(callSid, { sawCallerFinal: true });
        }
        turnUserText += sc.inputTranscription.text;
        // LVX78. The caller has spoken, so anything the model says next is a
        // response rather than a restatement -- including a legitimate repeat
        // they explicitly asked for.
        callerSpokeSinceLastReply = true;
        // -----------------------------------------------------------------
        // LVX96 ROUTE B. THE HANG-UP INTENT HAS A LIFETIME, AND THIS ENDS IT.
        //
        // `endCallArmed` is set when end_call succeeds and, until now, was
        // lowered nowhere -- one assignment, no reset, in the whole file. The
        // end-of-turn retry re-asks `armExit("end_call")` while it is true, so
        // a refusal inside the barge grace window was never a cancellation. It
        // was a one-turn deferral of a standing intent, retried at the end of
        // every later turn no matter what the conversation had moved on to.
        //
        // The condition that justified the hang-up was "the conversation is
        // over". A caller who carries on speaking has falsified it. That is a
        // fact about the call, not a judgement about the model, which is why
        // this can be state rather than a note.
        //
        // Scoped to a REFUSED arm. An arm that succeeded is already handled by
        // cancelPendingExit below and by the exit-cancellation counter; that
        // path is counted rather than changed, because a caller saying "bye"
        // over the goodbye relies on the retry to actually end the call, and
        // this is not the session to move that.
        // -----------------------------------------------------------------
        if (endCallArmed && endCallArmRefused) {
          endCallArmed = false;
          endCallArmRefused = false;
          pendingEndCallArgs = null;
          bumpCounter("live_end_call_latch_cleared");
          log.info("live_end_call_latch_cleared", { callSid, step: state.step });
        } else if (endCallArmed && pendingExit?.kind === "end_call") {
          // The sibling hole, COUNTED not acted on: the exit is about to be
          // cancelled a line below, but the latch survives and will re-arm at
          // the end of the next turn. Same outcome, different door. A number
          // first, then a decision -- the ladder every guard on this path
          // climbed.
          bumpCounter("live_end_call_latch_stale_after_cancel");
        }
        // ...and if we were about to hang up, we are not any more.
        cancelPendingExit("caller_spoke");
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
      // The caller answered the spelling and the model has now had its own turn
      // to re-issue the write. If it did, the stash was cleared by that
      // success and this does nothing. If it did not -- which is what happened
      // on four calls out of five -- we issue it ourselves.
      //
      // Deliberately here rather than on the arriving transcript, which is
      // where it was first wired. Firing the moment the letters land races the
      // model's own retry, and the model's is BETTER: it carries the corrected
      // spelling, and ours cannot.
      if (spellingSettled(state)) {
        retryPendingWrite().catch((err) =>
          log.error("live_write_retry_error", { callSid, reason: err?.message, severity: "warn" })
        );
      }

      auditTurn();
      // LVX83, between the guards and the fold. applyTurn() is what clears the
      // two accumulators, so this is the last moment a whole turn exists.
      persistTurnTranscript(turnUserText.trim(), turnReplyText.trim());
      turnApplied = true;
      const transfer = pendingTransfer;
      applyTurn();
      transcriptWrittenThisTurn = false;
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
      //
      // LVX83 writes BEFORE the clear. applyTurn() is never reached on an
      // interrupted turn, so without this a barged turn is a hole in the
      // record rather than a short entry in it -- and a half-spoken
      // confirmation is exactly the turn worth being able to read back.
      persistTurnTranscript(turnUserText.trim(), turnReplyText.trim());
      turnReplyText = "";
      turnUserText = "";
      transcriptWrittenThisTurn = false;
      turnApplied = false;
      leakHandledThisTurn = false;
      offerHandledThisTurn = false;
      noteSentThisTurn = false;
      // The turn was abandoned, so its refusal cannot suppress a sign-off on
      // the NEXT turn -- the model will generate that one fresh, and a stale
      // suppression is the permanent one this is scoped to avoid.
      endCallRefusedThisTurn = false;
      nameInToolArgsThisTurn = false;
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
      //
      // barge: true for the same reason as the local path -- the vendor is
      // telling us the CALLER interrupted, which is precisely the case that
      // should call a pending hang-up off rather than trigger it.
      //
      // lastBargeAt is set here as well as on the local frame path. It was only
      // ever set locally, so a vendor-detected interrupt -- speech our own VAD
      // read as nothing, which is the whole reason this branch exists -- left no
      // trace for armExit to refuse on.
      lastBargeAt = atMs;
      clearAudio(atMs, { barge: true });
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
  /** @returns {boolean} whether an exit was actually armed. */
  function armExit(kind, number = null) {
    if (pendingExit || closed) return false;

    // THE CALLER JUST INTERRUPTED. Do not arm a hang-up on top of them.
    //
    // 2026-09-06, and this is why the grace window did not help. The exit arms
    // at TURN END, which is after the goodbye has been generated and played:
    //
    //   17:54:41.302  end_call ok
    //   17:54:44.894  live_exit_armed        <- 3.6s later, at turn end
    //   17:54:46.485  live_exit_run
    //
    // The caller barged DURING the goodbye -- barges: 1, and the utterance
    // recorded playing_at_open: true. At that moment pendingExit was still null,
    // so cancelPendingExit had nothing to cancel. We then armed an exit anyway
    // and hung up on someone who had already started talking.
    //
    // Cancelling an armed exit was never enough on its own: the interruption
    // almost always lands BEFORE the arming, because the thing worth
    // interrupting is the goodbye and the goodbye comes first.
    //
    // Hang-ups only. A transfer is a handover, and a caller talking through it
    // is not asking to stay on the line with us.
    if (kind === "end_call") {
      bumpCounter("live_exit_arm_checked");
      if (now() - lastBargeAt < HANGUP_GRACE_MS) {
        bumpCounter("live_exit_refused_recent_barge");
        log.info("live_exit_refused_recent_barge", { callSid, sinceBargeMs: Math.round(now() - lastBargeAt) });
        // LVX96 route B. REMEMBER that a hang-up was wanted and denied.
        //
        // Returning false here sets no pendingExit, so before this line
        // nothing anywhere recorded that the refusal had happened -- and
        // `endCallArmed`, which is never lowered, made the end-of-turn retry
        // re-ask on every subsequent turn until the grace window happened to be
        // clear. On call 7aef50 that was eleven seconds and two unrelated
        // exchanges later, on a turn that ended in a fresh question to the
        // caller. `live_exit_refused_recent_barge` fired for the first time
        // ever on that call, and what it recorded was a guard that DELAYED a
        // hang-up rather than preventing one.
        endCallArmRefused = true;
        return false;
      }
    }
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
    return true;
  }

  /** Fire the armed exit exactly once, whether by mark or by backstop. */
  /**
   * The mark says the goodbye has played. Wait a breath before actually going.
   *
   * 2026-09-06, and the owner heard it: "I tried to interrupt the end call thing
   * and it just ended the call in the middle of the sentence."
   *
   *   17:44:49.305  TOOL end_call ok
   *   17:44:52.584  live_exit_armed
   *   17:44:52.657  live_exit_run  trigger: "mark"   <- 73ms later
   *   17:44:52.657  caller speaking
   *
   * The exit waits for an audio mark, which is SUPPOSED to mean the goodbye has
   * finished playing. The model called end_call without speaking a goodbye at
   * all, so nothing was queued, the mark came straight back, and the call closed
   * 73 milliseconds after arming. The caller's speech arrived in the same
   * millisecond. There was no window to interrupt because there was no audio to
   * interrupt.
   *
   * The cascade has had this since before this front-end existed, and its
   * constant carries the reasoning: "the window has to be long enough for
   * someone to actually start talking -- 800ms is barely a breath... the cost of
   * being stingy is hanging up on someone mid-sentence."
   *
   * Same number, and deliberately the same number: two front-ends that hang up
   * after different pauses is a difference nobody wants to debug later.
   */
  function scheduleExit(trigger) {
    if (!pendingExit || exitGraceTimer) return;
    // ONLY a hang-up waits. A transfer is not the caller being got rid of --
    // they are being moved to a person, and a second and a half of silence
    // before the redial is dead air in the middle of a handover rather than a
    // courtesy at the end of a call.
    if (pendingExit.kind !== "end_call") {
      runExit(trigger);
      return;
    }
    exitGraceTimer = setTimeout(() => {
      exitGraceTimer = null;
      runExit(trigger);
    }, HANGUP_GRACE_MS);
    exitGraceTimer.unref?.();
  }

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

      // -------------------------------------------------------------------
      // LVX30. The call BOUNDARY write, once, at pickup.
      //
      // /twilio/status runs as an ordinary HTTP POST on whichever instance the
      // load balancer picks, which is never the one holding this WebSocket. It
      // reads dbCallId and businessId from the shared store, and this path
      // wrote neither -- so completeCall ran with no tenant, the summary block
      // was skipped entirely, and the missed-call notification had nobody to
      // notify.
      //
      // The status one was NOT merely unscoped-and-fine. withTenantSafe(null)
      // takes its unscoped branch, `app.business_id` is never set, and this
      // service connects by IAM as vetra_app -- NOSUPERUSER NOBYPASSRLS since
      // migration 029. Under FORCE RLS that UPDATE matches ZERO ROWS and
      // reports success, which is why the dashboard showed nine `completed`
      // status callbacks against rows still reading in-progress with no
      // duration. services/db.js predicted this in writing for the day the
      // superuser went away.
      //
      // The cascade has done this at session.js:3906 all along; this is the
      // same write, at the same point in the call, for the same reason.
      // -------------------------------------------------------------------
      writeCallState(callSid, state);
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
    // and both are read from `env` -- the injected one -- which is now the only
    // way anything on this path reads a setting. LIVE_VOICE and
    // LIVE_LANGUAGE_CODE used to bypass that seam by being read from
    // process.env at module load (backlog LVX13), which made the two settings a
    // call summary REPORTS the two nothing could vary per session. Both go
    // through `env` as of this change, so there is no longer a second way in.
    const minimalPrompt = env.LIVE_PROMPT === "minimal";
    const noTools = env.LIVE_TOOLS === "none";
    const systemInstruction = minimalPrompt
      ? buildMinimalInstruction(config)
      : buildSystemInstruction(state.step, state.intent, config, extras);
    if (minimalPrompt || noTools) {
      log.info("live_bisect_arm", { callSid, prompt: minimalPrompt ? "minimal" : "full", tools: noTools ? "none" : "all" });
    }

    // Resolved ONCE, and both the session and the log read the same objects.
    // The old code called liveLanguageCode() twice and rebuilt `language_source`
    // beside it from a separate process.env read -- two derivations of one fact,
    // which agreed only by accident. A log that reports a source the session did
    // not use is worse than no log: `language_source: default` in one line is
    // what identified the accent bug, and it can only do that while it is true.
    const language = resolveLiveLanguage(config, state.twilioNumber, env);
    const voice = resolveLiveVoice(config, language.code, env);
    bumpCounter(`live_voice_source_${voice.source}`);

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
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.name } },
        languageCode: language.code,
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
          onclose: (e) => {
            const kind = classifyClose(e);
            bumpCounter(kind === "clean" ? "live_close_clean" : "live_close_abnormal");
            if (kind === "abnormal") {
              // Logged as well as counted: the counter says how often, and only
              // the log says which code, which is what picks the fix.
              log.error("live_close_abnormal", {
                callSid,
                code: e?.code ?? null,
                reason: e?.reason || null,
              });
            }
            summary.recordClose(e?.reason || null);
          },
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
        // Which language the voice was actually pinned to, which VOICE spoke
        // it, and where each choice came from. "the accent changed" is
        // unanswerable from a log that does not record what was asked for, and
        // "which voice was that?" was unanswerable at all until now.
        language_code: language.code,
        language_source: language.source,
        voice: voice.name,
        voice_source: voice.source,
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

  /**
   * Write a promised message that the spelling gate refused and nobody re-issued.
   *
   * 2026-09-06. The caller asked for a callback; record_customer_request was
   * refused because they had given their name without spelling it; the
   * assistant said "I'll fix it so someone calls you back by the next business
   * day"; and customer_requests ended the call with zero rows.
   *
   * The arguments were never lost -- the gate stashes them (services/tools.js
   * pendingWrite) precisely so a write can be re-issued in code. Nothing was
   * reading that stash at the end of a call, so it was thrown away.
   *
   * MESSAGES ONLY, and the exclusion is the important half. LVX77, the same
   * morning, had the booking retry write "Jane Doe" -- a name the caller never
   * said -- into an appointment. A booking's name identifies the row. A
   * message's phone number does the work and comes from the call rather than
   * from the model, so a mis-heard name costs a wrong label on a callback that
   * still reaches the right person.
   *
   * This does NOT make the model ask for spellings. Three mechanisms already do
   * and it declined all three on the observed call. This stops the loss, not the
   * mis-hearing.
   */
  async function saveOutstandingMessage() {
    // NOT `runner?.peekPendingWrite?.()`. The optional call swallowed a missing
    // function for a whole build: peekPendingWrite had been added, reverted with
    // an unrelated patch, and this read `undefined` in silence rather than
    // throwing. A wire that is allowed to be absent is a wire nothing can prove.
    const pending = runner ? runner.peekPendingWrite() : null;
    if (!pending || pending.name !== "record_customer_request") return;

    try {
      lastChanceWrite = true;
      const out = await runner.handleToolCall({
        functionCalls: [{ id: `last_chance_${pending.name}`, name: pending.name, args: pending.args }],
      });
      const ok = out?.functionResponses?.[0]?.response?.success === true;
      bumpCounter(ok ? "message_saved_last_chance" : "message_lost_at_close");
      // Tool name and outcome only. The message text is the caller's own words
      // and their callback number is in the arguments, which is LVX24 exactly.
      log.info("live_message_last_chance", { callSid, ok });
    } catch (err) {
      bumpCounter("message_lost_at_close");
      log.error("live_message_last_chance_failed", { callSid, reason: err?.message, severity: "warn" });
    } finally {
      lastChanceWrite = false;
    }
  }

  function finish(reason) {
    if (closed) return;
    closed = true;

    // Before anything tears down: a message the caller was promised outlives
    // the call, or it does not exist at all.
    saveOutstandingMessage().catch((err) =>
      log.error("live_message_last_chance_failed", { callSid, reason: err?.message, severity: "warn" })
    );

    // LVX70. Drain the utterance instrument before anything else touches the
    // counters: an episode still open when the line drops is the most
    // interesting one on the call, and the last few pending records are the
    // ones nothing newer will ever push out.
    flushUtterances(now());

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
      // LVX83's positive half. live_transcript_write_failed reads zero for a
      // clean call AND for a call that never reached the write, so the count
      // of turns that DID issue rows is the one that can tell them apart.
      // `refused` distinguishes a hipaa deployment from a broken one.
      transcript_turns_written: transcriptTurnsWritten,
      transcript_refused: transcriptRefusalLogged || null,
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
      if (pendingExit && msg.mark.name === pendingExit.mark) scheduleExit("mark");
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
