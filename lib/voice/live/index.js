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
import {
  applyReplyState,
  spellingSettled,
  applyCallerSpellingSignal,
  applyCallerVoicedAnswer,
  voicedAnswerMs,
} from "../replyState.js";
import { callerHasNameOnFile } from "../../nameQuality.js";
import { countryFromE164 } from "../../phone.js";
import {
  dispatchCapabilityEffects,
  mergeCapabilityState as mergeCapabilityStateInto,
} from "../../capabilities/effects.js";
import { getStrings, getOutboundStrings } from "../strings.js";
// LVX137. The same matcher the consent latch uses to read a read-back, pointed
// at a denial instead: it already knows 3.8 speaks the clock in words
// ("two o'clock"), which is the thing aab2f12 had to fix once already.
import { readBackMentionsSlot } from "../slotMention.js";
import { resolveRingTone } from "../voiceLocale.js";
import { judgeMode, judgeCall } from "../../postCallJudge.js";
import { recoverOwedBooking } from "../../postCallRecover.js";
import { postCallMode, verifyCall } from "../../postCallVerify.js";
import * as notifications from "../../../services/notifications.js";
import { captureException } from "../../sentry.js";
import { escapeXml } from "../../twiml.js";
import { log } from "../../logger.js";
import { bumpCounter, bumpCounterBy } from "../metrics.js";
import {
  isUnusableTranscript,
  looksNonEnglish,
  replyLooksNonEnglish,
  longestSharedRun,
  REPEAT_RUN_WORDS,
  countAsks,
  isAffirmative,
  textFingerprint,
} from "../../transcriptUtils.js";
import { createVad } from "../inboundVad.js";
import { createAudioOut } from "../audioOut.js";
import { createEchoGuard } from "../echoGuard.js";
import { greetingTextFor } from "../greeting.js";
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
// OUTBOUND CALLING (Task 14, spec §9.2/§9.3). Reached only when the stream's
// `direction` parameter is "outbound"; an inbound call never calls into either.
import { resolveOutboundContext } from "../../outbound/callContext.js";
import { recognizeCallback } from "../../outbound/callbackRecognition.js";
import {
  createFirstSecondsController,
  CLIP_CALLER_HOLD_MAX_MS,
  CLIP_HOLD_DELAY_LINE_MS,
  CLIP_CONFIRM_WINDOW_MS,
  CLIP_CONFIRM_VOICED_FRAMES,
  CLIP_HOLD_DRAIN_MAX_MS,
  CLIP_HOLD_DRAIN_SETTLE_MS,
  CLIP_HOLD_STT_TIMEOUT_MS,
  CLIP_PRE_CLIP_TAIL_MAX_MS,
} from "../../outbound/firstSeconds.js";
// 2026-10-01 (spec 2026-10-01-outbound-live-first-line-design.md): `live`, the
// default first-speaker mode -- no recorded opener, the AI's live reply is the
// first thing heard. firstSeconds.js above still runs `clip` mode, unchanged.
import { createLiveFirstLine } from "../../outbound/liveFirstLine.js";
import { resolveFirstSpeaker } from "../../outbound/firstSpeakerMode.js";
import { transcribeMulawOnce } from "../sttDeepgram.js";
import { mediaStreamTokenRequired } from "../../mediaStreamToken.js";
// Task 19 (spec §9.7): the outbound transfer variant. `baseUrl` is the SAME
// BASE_URL derivation the outbound door routes use, imported rather than
// duplicated; `createTwilioClientFor` is the C17 seam every other outbound
// REST call goes through (Task 13); `isInsideTransferWindow` is the pure
// parser for the campaign's `transfer.when`.
import {
  baseUrl as outboundBaseUrl,
  WHISPER_PATH as OUTBOUND_WHISPER_PATH,
  TRANSFER_RESULT_PATH as OUTBOUND_TRANSFER_RESULT_PATH,
} from "../../outbound/doorRoutes.js";
import { createTwilioClientFor } from "../../outbound/internalRoutes.js";
import { isInsideTransferWindow } from "../../outbound/schedule.js";
// Task 20 (spec §11): the post-call hook. `postCall` defaults to the real,
// wired-up singleton (the SAME instance server.js's door routes and the
// sweep use); `isSessionSilent` is the two-limb rule ONLY -- no machine
// exclusion, no "no stream" case (those need answered_by and whether a
// session ever finished, which post-call itself is in the better position
// to judge, since the AMD verdict can land after this controller tears down).
import { postCall as defaultPostCall } from "../../outbound/postCall.js";
import { isSessionSilent, sessionEndSilent, detectOutboundTurn, firstReplyDiscloses } from "../../outbound/detectors.js";
import { skipOnOutbound } from "../../outbound/policy.js";

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
 * How long a run must be before a turn counts as re-speaking the GREETING.
 *
 * Ten, not REPEAT_RUN_WORDS' six, and the gap is the whole point. "How can I
 * help you today?" is six normalised words and it is an ordinary thing for an
 * assistant to say again after finishing a task — cutting that would be a
 * worse defect than the one this fixes. What was actually heard was the entire
 * opening line, verbatim, about twenty words of it. Ten separates the two.
 *
 * It also self-disarms: a business whose whole greeting is shorter than ten
 * words can never produce a run this long, so a short generic opening is left
 * alone rather than policed by a threshold it cannot help tripping.
 */
const GREETING_ECHO_RUN_WORDS = 10;

/**
 * How many greeting re-speaks one call may have cut, kept SEPARATE from
 * MAX_REPEAT_CUTS.
 *
 * A re-greet must not consume the budget that protects against the loop
 * MAX_REPEAT_CUTS exists for; they are different defects with different
 * populations, and LVX104 is the standing lesson about an allowance keyed to
 * the wrong one.
 */
const MAX_GREETING_ECHO_CUTS = 2;

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
 * campaign's own `language` (S3-6, spec §19, S3-D4) when this is an outbound
 * call and the campaign set one -- a per-campaign choice, so it outranks the
 * tenant's own default. Otherwise the tenant's own locale, which is the whole
 * reason the column exists. Otherwise the old default, so a tenant with no
 * locale (and no campaign language) behaves exactly as before.
 *
 * Exported (Task 14, outbound calling) so lib/outbound/liveRender.js renders
 * the backstop and voicemail clips in the SAME language as the call. Always
 * given the BUSINESS number -- on outbound that is the campaign's caller_id,
 * never the contact's.
 *
 * @param {string} [campaignLanguage] - S3-6: `state.outboundCall.config.language`
 *   / `row.config.language`. Absent on inbound, and absent on an outbound
 *   campaign that never set one -- both fall through to the tenant/default
 *   rungs exactly as before this parameter existed.
 */
export function resolveLiveLanguage(config, businessPhone, env, campaignLanguage) {
  const override = String(env?.LIVE_LANGUAGE_CODE || "").trim();
  if (override) return { code: override, source: "env" };
  const campaign = String(campaignLanguage || "").trim();
  if (campaign) return { code: campaign, source: "campaign" };
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
 *
 * Exported (Task 14) for the same reason as resolveLiveLanguage: the
 * pre-rendered outbound clips must be spoken in the call's own voice.
 */
export function resolveLiveVoice(config, languageCode, env) {
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
  "NOT tell the caller it is booked, and correct that plainly and briefly if you already " +
  "have. Do NOT ask the caller whether to try again, and do not offer them a choice about " +
  "it — retrying is not their decision to make. Say plainly that you could not get it into " +
  "the diary, and that the team will confirm the time with them directly.";

/**
 * A GATE IS NOT A FAILURE, and until 2026-09-11 this path could not tell them
 * apart.
 *
 * Call CAa08fc3. The spelling gate held a booking, the caller spelled their
 * name, and the engine retried the instant the spelling settled -- which is a
 * moment when the assistant's last turn was "I'll get that scheduled" and the
 * caller's last turn was a recital of letters. The write-order gate refused it,
 * correctly, with a message that opens "NOT A FAILURE — this is still going
 * ahead". retryPendingWrite saw only `success !== true`, reached for
 * WRITE_RETRY_FAILED_NOTE, and the caller heard:
 *
 *   "I'm sorry, it looks like the booking didn't go through on my end. Would
 *    you like me to try again, or would you prefer to leave a message for
 *    someone to call you back?"
 *
 * The model was OBEYING. Two parts of the system described one event in
 * opposite terms and the louder one won.
 *
 * Note the shape of the retry itself is still questionable -- firing the moment
 * a spelling settles guarantees the write-order gate cannot pass, because
 * nobody has been asked anything. That is what `write_retry_gated` counts. This
 * note stops the caller hearing about it; it does not stop it happening.
 */
const WRITE_RETRY_GATED_NOTE =
  "[not caller speech] NOT A FAILURE — nothing has gone wrong and the booking is still going " +
  "ahead. It has not been saved YET because it needs the caller's go-ahead first. Do NOT tell " +
  "the caller anything went wrong, do not say it failed, and do not offer a callback or a " +
  "message. Read the details back to them in one short sentence — what you are about to do, " +
  "and when — and ask whether to go ahead. When they agree, call the tool again with the same " +
  "details.";

const DEFERRAL_NOTE =
  "(System: you just told the caller that someone will get back to them, but " +
  "the action they asked for was refused this turn and the refusal told you " +
  "what to do next. Do not take a message or promise a callback instead. Do " +
  "the thing the refusal asked for now, ask the caller for what it needs, and " +
  "wait for their answer.)";

/** Twilio media frames are 160 bytes of mu-law, 20 ms. */
const FRAME_BYTES = 160;

/**
 * 2026-10-01 live mode (spec §5): the early-hang-up opt-out safety net keeps
 * the person's audio from the answer until Live's first non-empty input
 * transcript -- at most 15 s (750 frames), the EARLIEST audio kept.
 */
const LIVE_EARLY_AUDIO_MAX_FRAMES = (15 * 1000) / 20;

/** 2026-10-01 hold: at most 15 s of a muted generation's audio is kept for a release-time flush (8 kHz mu-law). */
const HOLD_MUTED_AUDIO_MAX_BYTES = 15 * 8000;

/**
 * Final wave W1 (A19). The non-action tools that are still CALLER-VISIBLE, so
 * are refused from a generation the caller never heard (onToolCall): ending
 * the call, and handing it to a person. Every ACTION_TOOL_NAMES tool is
 * refused too; the suppression writers (opt_out, set_call_outcome) and the
 * bookkeeping/read tools are deliberately not here.
 */
const UNHEARD_REFUSED_TOOLS = new Set(["end_call", "request_transfer"]);
const UNHEARD_TOOL_REFUSAL =
  "Not done: the caller could not hear what you just said (your opening line was still playing, or the call " +
  "had already ended), so they have not heard or agreed to this. Do not act on it; listen for what they say next.";

/** 2026-10-01 live mode: the same refusal while the call is on hold (spec §4) -- nobody is on the line. */
const HOLD_TOOL_REFUSAL =
  "Not done: you are on hold and nobody is on the line yet. Wait quietly; when a person speaks, start again " +
  "with who you are and check you are speaking to the right person.";

/**
 * D-R2-3 (2026-09-30 phone check, call ..cf41ed). `confirm_identity` is not an
 * action, so the W1 list above never named it -- but it is a GATE: once it
 * runs with name_confirmed true, the reason for the call, the questions and a
 * booking all unlock. On that call the stale reply to the pre-clip "Hello?"
 * (audio discarded, 28 chunks) called it 3.0 s into the opener clip, before
 * anyone could have said who they were, and the gatekeeper who answered was
 * then offered the booking.
 *
 * Refused from an unheard generation, which is WIDER than the W1 test
 * (`discardingNow()`): it also covers a stale generation the idle/cap bound
 * abandoned without its close ever arriving, until the person speaks again
 * (firstSeconds `abandonedStaleUnheard()`, review M1: after they speak, the
 * next generation is a reply to them, and its confirmation must not be refused
 * merely because its tool call came before its first audio chunk). A
 * generation replying to real speech -- including a "yes, speaking" held
 * during the clip and released after it -- runs normally: by then the stale
 * generation has closed (Live runs one generation at a time). The W1 list
 * itself is deliberately left on its own test.
 *
 * Its own refusal text: the model is told what to do NEXT (confirm in a reply
 * they can hear), not only that this attempt failed -- the CALL PLAN
 * (lib/outbound/prompt.js) says the same, and O-12 refuses every action until
 * it has run. Worded not to claim that nobody spoke (review M1): real speech
 * can reach Live during the clip, and only the REPLY went unheard.
 */
const UNHEARD_IDENTITY_TOOLS = new Set(["confirm_identity"]);
const UNHEARD_IDENTITY_REFUSAL =
  "Not done: identity is NOT confirmed yet. The person could not hear this reply (your opening line was still " +
  "playing), so confirm who you are speaking to in a reply they can hear, and call confirm_identity when they " +
  "tell you.";

/**
 * OUTBOUND CALLING (Task 14 fix round 1, M11). The pause before the one retry
 * of an outbound call's context load after a database error. Short: the
 * person has picked up and the 2 s limb is running.
 */
const DIAL_CONTEXT_RETRY_MS = 150;

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
    // Task 19, C17 seam: the SAME lazy, shared factory the outbound door
    // routes and dispatcher use (server.js's one `outboundTwilioClientFor`).
    // Defaults to a fresh lazy factory -- the same shape buildOutboundDeps'
    // own default takes -- so every existing test and every caller that never
    // passes this (there was no outbound transfer before this task) is
    // unaffected. `twilioClient` above still wins when injected: it is the
    // longer-standing test seam for the INBOUND transfer path, which this task
    // leaves untouched.
    twilioClientFor = createTwilioClientFor(env),
    exitFallbackMs,
    // LVX29's post-call read. Injectable for the same reason `execute` is:
    // asserting that the ledgers reach it should not require a database.
    verify = verifyCall,
    // The recovery that books what the call agreed to and never recorded.
    // Injectable for the same reason `verify` is, and for one more: the real one
    // reads a transcript and calls a model, so a test that could only reach it
    // through the genuine article could not assert the wire at all -- and the
    // slot list is exactly the kind of value that gets produced and never
    // copied. Asserted in tests/livePostCallRecover.test.js.
    recover = recoverOwedBooking,
    // The shadow judge, which USED TO RUN IN server.js's Twilio status webhook
    // and now runs here. It moved because the evidence it needs lives in this
    // closure: writesThisCall, the abandoned set, guards.counts(). A handler in
    // another process boundary could only have them via a migration, and the
    // `calls` table has no front-end column to tell a Live call from a cascade
    // one anyway -- see the comment at the judge call below.
    judge = judgeCall,
    // LVX30. The shared call-state write, injectable so a test can assert the
    // patch without standing up a store. Real one is fire-and-forget, ordered
    // per call SID and swallows its own errors -- see lib/callState.js.
    writeCallState = writeShared,
    // THE SEAM THAT WAS MISSING, and the reason the last claim-completion
    // attempt could be tested 894 lines deep and still never originate a write
    // in production: nothing could drive THIS function and reach a fake
    // appointments store at the same time.
    //
    // The rest of the chain already existed -- extras.capabilityDeps reaches
    // lib/voice/live/tools.js as ctx.depsOverride and is consumed in
    // services/tools.js (`ctx.depsOverride || CAPABILITY_DEPS`) -- but `extras`
    // is built inline below and simply omitted the key, so only the eval driver
    // (lib/harness/liveTextSession.js) could set it. A test could drive the
    // session with a stubbed `execute`, proving ordering but never the gates;
    // or drive the real gates without the session, proving decisions against a
    // hand-built ctx. Never both -- so "the ctx production actually produces"
    // was never asserted end to end, which is the gap a missing wire hides in.
    //
    // Undefined in production, which leaves CAPABILITY_DEPS untouched.
    capabilityDeps,
    // Task 20 (spec §11): the SAME shared instance as server.js's door
    // routes and the sweep, unless a test injects its own fake. Renamed at
    // the destructure (never `postCall`): `postCallMode(env)` further down
    // in `finish()` already owns that name for the shadow/act/off string.
    postCall: outboundPostCall = defaultPostCall,
    // Final wave W1 (I2): the hang-up drain's two bounds (see
    // beginClipHoldDrain). Injectable for the same reason exitFallbackMs is;
    // production uses the named constants.
    clipDrainMaxMs = CLIP_HOLD_DRAIN_MAX_MS,
    clipDrainSettleMs = CLIP_HOLD_DRAIN_SETTLE_MS,
    // Stage 4 S4-2: the one-shot Deepgram fallback for a drain Live did not
    // transcribe (see endClipHoldDrain). Injectable so no test reaches the
    // vendor; production uses the real helper.
    clipHoldStt = transcribeMulawOnce,
    clipHoldSttTimeoutMs = CLIP_HOLD_STT_TIMEOUT_MS,
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

  /**
   * What the claim guard DID on this call, per call rather than per process.
   *
   * ---------------------------------------------------------------------------
   * Why this exists: a real false claim, and no way to ask the call about it
   * ---------------------------------------------------------------------------
   *
   * CAb76b13, 2026-09-17, gemini-3.8-live. The model called
   * cancel_appointment_db without being asked, the consent gate refused it, and
   * it then told the caller "I have cancelled your existing appointment on
   * Friday, September eighteenth at four thirty PM" and hung up 1.6 seconds
   * later. No live_claim_unbacked_by_action, no note, no correction.
   *
   * completionClaimRe MATCHES that sentence -- checked directly against the
   * production table. end_call is not in ACTION_TOOL_NAMES. LIVE_CLAIM_GUARD was
   * not off. tests/liveClaimGuardSignoff.test.js drives both turn orderings and
   * the guard fires in all of them. Four hypotheses ruled out, and the question
   * that would have settled it in one line -- "did auditTurn evaluate that turn
   * at all, and what did it decide" -- HAS NO ANSWER, because the whole
   * live_claim_* family is a process-global counter shared by every call the
   * instance handled and zeroed by the next deploy.
   *
   * `turns_audited` is the load-bearing field and it is the DENOMINATOR. A
   * fault-only counter reads zero for a call the guard cleared and for a call
   * the guard never saw, which is the trap this codebase keeps rediscovering.
   * With it, "the guard ran and decided no" and "the guard never ran" stop
   * looking identical -- and the leading unproven hypothesis for CAb76b13, that
   * output transcription landed after auditTurn read the reply, becomes a thing
   * the next occurrence simply reports.
   *
   * Counts and booleans. No caller data, no reply text.
   */
  const claimAudit = {
    // auditTurn reached its claim section. The denominator.
    turns_audited: 0,
    // ...and had no reply text to judge. claimedCompletion cannot be true here,
    // so a call that is all of these is a call the guard could never fire on.
    turns_reply_empty: 0,
    // completionClaimRe matched. The narrow one -- the one that drives the note.
    claimed: 0,
    // The two unbacked conditions, which are not the same population: the
    // narrow one asks whether ANY tool ran, the wide one whether an ACTION tool
    // did, and the difference is LVX93.
    unbacked_any: 0,
    unbacked_action: 0,
    // Named suppressions, each of which is a decision to stay silent.
    suppressed_signoff: 0,
    suppressed_readback: 0,
    suppressed_existing_report: 0,
    suppressed_guard_off: 0,
    // A note actually went out. The gap between unbacked_action and this is
    // always attributable to one of the four above.
    note_sent: 0,
  };

  /**
   * LVX157's per-call ledger, and it exists because the first call on the fix
   * could not be read.
   *
   * All five of LVX157's counters shipped as process-global `bumpCounter`s on
   * 2026-09-19. On `CA98d6b04` the outcome was right -- booking landed, no
   * farewell in the completion turn, no jam -- and **whether the note had gone
   * out or been honoured had no per-call answer at all**, so the one thing the
   * call was run to decide could not be decided from it.
   *
   * This file already carries that lesson twice, in the words above
   * `endCallRefusals` and in claimAudit's own docstring: a counter zeroed by
   * the next deploy and shared by every call the instance handles cannot say
   * what happened on THIS one. Writing it a third time here rather than
   * pretending the first two were enough.
   *
   * The process counters stay. They are the cross-call series and their meaning
   * does not change; these are the per-call record beside them.
   */
  const closingAudit = {
    // Layer A went out with a completed write.
    ask_note_sent: 0,
    // ...and the model then actually asked, before any further write landed.
    // THE POSITIVE TWIN. An instruction read and ignored produces exactly the
    // same _sent as one that works, and this area has six failed wordings on
    // record. `sent` high with `honoured` at 0 means the note is decoration.
    ask_note_honoured: 0,
    // A no_ask refusal that happened ONLY because the ask predated the write --
    // the CA0ef8d221 shape. Separates "the fix is catching that call" from "the
    // model has started asking less often", which need opposite answers.
    ask_latch_stale: 0,
    // A no_ask refusal that was available only because a write landed since the
    // last one -- the CA84dc64 shape. A gate that had simply stopped latching
    // would show a second refusal WITHOUT this.
    ask_rearmed_by_action: 0,
    // THE DEFECT ITSELF: turns that signed off over a completed action with no
    // live ask behind it, whether or not anything then refused, held or armed.
    // This is the number that falls if the fix works; if only the refusal
    // counts move, the model is being caught rather than corrected.
    signoff_without_ask: 0,
    // The denominator nobody asks for until it is missing: completed
    // caller-visible writes. A call with none cannot exhibit any of the above,
    // and without this a clean call and an inapplicable one read the same.
    actions_completed: 0,
  };

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
  /**
   * OUTBOUND CALLING (spec §9.3): the first-seconds controller, built at stream
   * start on an outbound call and null on every inbound call -- so each of its
   * hooks below (media frame, model audio, clearAudio, mark, turn text) is a
   * no-op there. Named `dial*` because "outbound" already means model-to-caller
   * audio in this file (inspectOutbound, live_outbound_*).
   */
  let dialFirstSeconds = null;
  /**
   * 2026-10-01: the `live` first-speaker mode's controller
   * (lib/outbound/liveFirstLine.js) -- built INSTEAD of dialFirstSeconds on an
   * outbound call in live mode, so exactly one of the two is non-null on an
   * outbound call and both are null on inbound. Every dialFirstSeconds site
   * was censused for what live mode needs (ledger, Task 1): the null-safe
   * `?.` sites that must still act in live mode branch on this explicitly.
   */
  let liveFirstLine = null;
  /** Model audio of a generation muted on hold, kept so a release mid-generation can flush it (bounded). */
  let holdMutedAudio = [];
  let holdMutedBytes = 0;
  /** R3: wait_on_hold engages at the end of the generation that called it, so its "Sure, thank you" is heard. */
  let holdRequestedAt = null;
  /** Live mode (spec §5): caller frames since the answer, until Live first transcribes them (S4-2 safety net). */
  let liveEarlyAudio = [];
  let liveEarlyVoiced = 0;
  let liveEarlyTranscribed = false;
  /** The safety net's one-shot STT is running in place of a Live drain: finish() still closes Live. */
  let liveEarlySttStarted = false;

  function bufferEarlyCallerAudio(frame, voiced) {
    if (liveEarlyTranscribed || liveEarlyAudio.length >= LIVE_EARLY_AUDIO_MAX_FRAMES) return;
    liveEarlyAudio.push(frame);
    if (voiced) liveEarlyVoiced += 1;
  }

  /**
   * 2026-10-01 (spec §5, plan Task 5): live mode's half of the S4-2 rule.
   * There is no clip, so no clip hold and no drain -- the person's audio
   * already went to Live in real time. But "stop calling me" and a hang-up
   * before Live transcribed it must still never be re-dialled: if the call
   * ends with voiced audio buffered and no transcript, the buffer goes
   * through the SAME runClipHoldStt path (Deepgram one-shot, EU endpoint;
   * else the attempt is marked unverified and post-call holds the lead).
   * Called from finish() before `closed`; returns the settle promise, or null.
   */
  function beginLiveEarlyAudioStt() {
    // Final review #2: only CONFIRMED speech (liveFirstLine.heardSpeech: the
    // VAD's sustained flag or 11 voiced frames in 800 ms, never while our own
    // audio played) -- a click or an echo of our "Hello?" must not close the
    // lead held_for_review, or be written as words they never said.
    if (!liveFirstLine || closed || liveEarlyTranscribed || liveEarlyVoiced === 0 || !liveFirstLine.heardSpeech()) return null;
    clipDrainAudio = { frames: liveEarlyAudio, voiced: liveEarlyVoiced };
    liveEarlyAudio = [];
    liveEarlySttStarted = true;
    bumpCounter("outbound_live_early_audio_stt");
    log.info("outbound_live_early_audio_stt", { callSid, frames: clipDrainAudio.frames.length, voiced_frames: clipDrainAudio.voiced });
    return runClipHoldStt().catch(() => {});
  }

  /** Live mode: the business the first reply must name (the same name the clip was rendered with). */
  let liveBusinessName = "";
  /** Live mode: the first-reply disclosure check has been decided (satisfied, or corrected once). */
  let liveDisclosureDone = false;

  /**
   * 2026-10-01 (spec §5; rulings R4, R14): the live first reply must say it
   * is an AI. Judged on the first heard turn that answers the person (never
   * the silence "Hello?" -- liveFirstLine offers `firstAnswer` only for
   * that turn). An interrupted turn is judged on what was said of it: if it
   * disclosed, done; if not, nothing is corrected over the person's barge
   * and the next completed turn is judged instead (the clip-era I5 rule).
   * Missing on a completed turn: ERROR (alert policy) + one cue, APPENDED as
   * context (turnComplete false) so the model says it at its next natural
   * turn rather than talking over the answer to "am I speaking with...?".
   * An unusable transcript counts as missing (fail closed).
   */
  function checkLiveFirstReplyDisclosure(turn, text, { complete }) {
    if (!turn || !turn.firstAnswer || liveDisclosureDone) return;
    if (firstReplyDiscloses(text)) {
      liveDisclosureDone = true;
      return;
    }
    if (!complete) return;
    liveDisclosureDone = true;
    bumpCounter("outbound_disclosure_missing");
    log.error("outbound_disclosure_missing", { callSid, attemptId: state.attemptId, chars: String(text || "").length });
    sendDialContent("disclosure_cue", {
      turns: [
        {
          role: "user",
          parts: [{ text: `(System: Say plainly in your next sentence that you are an AI assistant calling from ${liveBusinessName}.)` }],
        },
      ],
      turnComplete: false,
    });
  }
  /** The generation a hold-muted / clip-discarded reply belongs to: either mode, false on inbound. */
  function firstLineDroppedThisGeneration() {
    if (dialFirstSeconds) return dialFirstSeconds.droppedThisGeneration();
    if (liveFirstLine) return liveFirstLine.droppedThisGeneration();
    return false;
  }
  /** What the controller asked Live for before Live had connected; sent on connect. */
  const dialPendingContent = [];

  /**
   * Send the controller's seed / note / prompt to Live -- or hold it until the
   * session exists. The backstop can fire before a slow connect completes
   * (spec §9.3: the silence deadline is a wall-clock limb), and the seed must
   * still reach Live once it opens. Direct, not through sendTurnNote: the
   * disclosure correction is a compliance line and must not be rationed away
   * by a guard that spoke first.
   */
  function sendDialContent(kind, content) {
    if (closed) return;
    if (!session) {
      dialPendingContent.push({ kind, content });
      return;
    }
    try {
      session.sendClientContent(content);
    } catch (err) {
      log.error("live_dial_content_failed", { callSid, kind, reason: err?.message, severity: "warn" });
    }
  }

  const vad = createVad();
  const gate = createHalfDuplexGate();

  /**
   * OUTBOUND CALLING, C1 fix (checkpoint-A review; fix round 2, N1/N2 of the
   * re-review). `gate` above is sized for LIVE'S OWN short reply (a 500 ms
   * lookback) and drops a caller's whole utterance long before a
   * multi-second opener clip finishes playing -- confirmed on 3 real sim
   * calls (live_utterance{playing_at_open:true, forwarded:0,
   * dropped_voiced:16}: a gatekeeper's "He's out." never reached Live's
   * ASR). Rather than retune the shared gate (inbound must stay
   * byte-identical), onMediaFrame bypasses it entirely, for outbound only,
   * while dialFirstSeconds.clipPlaying() is true, and every caller frame is
   * captured here instead -- in order, bounded by CLIP_CALLER_HOLD_MAX_MS
   * (see its own doc comment for the cap and what happens past it).
   *
   * F-R2 (half-2 controller analysis): "captured here" no longer means
   * "held whole" for a NON-voiced frame. Holding every frame, voiced or
   * not, also withheld the trailing silence Live's OWN end-of-turn VAD
   * needs to finish deciding a pre-clip hello was over -- so Live never
   * started replying to it DURING the clip, only once the whole hold
   * released in one burst at the seed, by which point the local
   * stale-discard state had already lifted with nothing to catch it
   * (D1's double-talk/re-ask, back by a different door). routeClipFrame
   * (below) now forwards silence through a short delay line instead,
   * close to real time; a voiced frame latches PROVISIONALLY and only a
   * CONFIRMED run (the count rule, NB2) enters the ordinary hold this
   * comment describes -- and after that only its voiced frames do, the
   * silence keeps flowing (final wave W1, A15). See routeClipFrame's own doc
   * comment and CLIP_HOLD_DELAY_LINE_MS (firstSeconds.js).
   *
   * RELEASE RULE (fix round 2): release only once dialFirstSeconds.
   * clipPlaying() reads false -- i.e. the clip's own audio is truly off the
   * wire -- never merely because the seed has been sent. Round 1 released
   * as soon as the seed went out, which is correct for the hello-end/slow
   * paths (the seed is sent AT the clip's own end-mark echo, so the two
   * events coincide) but wrong for the silence path, where the seed is sent
   * IMMEDIATELY at fire while the clip goes on playing for real: releasing
   * there forwarded the caller's mid-clip speech to Live in real time, and
   * any reply Live generated to it before the clip's audio finished was
   * then discarded as a "generation opened during the clip"
   * (catchMidClipGeneration, firstSeconds.js) -- Live's context said it
   * answered; the caller heard the rest of the clip and then silence (N2).
   * Checked with `maybeReleaseClipHold`, from every place that can observe
   * clipPlaying() go false, because the M9 mark-timeout can fire from
   * firstSeconds.js's onModelAudio as well as its tick() (N1): a Live audio
   * chunk arriving between two Twilio media frames can end clipPlaying with
   * nothing in onMediaFrame ever seeing the transition at the instant it
   * happens. So this is checked at the TOP of onMediaFrame (catches a
   * transition that happened between frames, via onModelAudio) AND again
   * after tick() (catches one tick() itself just caused) AND in the `seed`
   * callback (the ordinary case: clipPlaying() is usually already false by
   * the time the deferred-path seed goes out) AND unconditionally on a real
   * clip barge (CLIP_BARGE_MIN_MS, below -- a barge abandons the seed for
   * good, so nothing else will ever release it). `maybeReleaseClipHold` and
   * `releaseClipHold` are both idempotent (`clipHoldOpen` latches once),
   * so calling them redundantly from several places is always safe.
   *
   * TEARDOWN: if the session ends while something is still held, there is
   * no Live to deliver it to -- `teardownClipHold` (called from finish())
   * drops it, counted, rather than calling `sendAudio` into a socket that
   * has already set `closed = true` (which would silently look like a
   * successful release while delivering nothing).
   */
  let clipHoldBuffer = [];
  let clipHoldOpen = false;
  let clipHoldDroppedTotal = 0;
  /**
   * F-R2 (half-2 controller analysis, Direction A). A NON-voiced frame while
   * the clip plays no longer goes straight into clipHoldBuffer -- it sits
   * here, a short FIFO, and is forwarded to Live in close-to-real time
   * (routeClipFrame, below) so Live's own end-of-turn VAD keeps seeing the
   * hello's trailing silence on close to its own schedule, rather than
   * receiving none of it until the whole hold releases in one burst. See
   * CLIP_HOLD_DELAY_LINE_MS's own doc comment (firstSeconds.js) for why this
   * closes the D1 double-talk/re-ask regression. A voiced frame goes to the
   * provisional buffer first (NB2) and a confirmed run to clipHoldBuffer
   * (C1); whenever speech enters the hold, whatever is still sitting here is
   * drained into the hold ahead of it (its pre-roll), so the TRUE start of
   * the caller's speech is never forwarded ahead of the seed.
   */
  let clipDelayLine = [];
  /**
   * Set once a CONFIRMED run (the provisional count, NB2) has latched this
   * clip's routing (see routeClipFrame): from then on every VOICED frame is
   * held at once, without a new provisional window (final wave W1, A15 --
   * non-voiced frames keep flowing). Reset per call, like the other
   * clip-hold state.
   */
  let clipHoldVoiceLatched = false;
  /**
   * F-R2 fix round 1 (opus review, I1). Snapshotted once, on the FIRST frame
   * routeClipFrame ever sees for this clip: was the caller already mid-
   * utterance (voiceActive) when the clip started playing -- the
   * backstop_slow-tail shape, not a fresh onset. While true, frames keep
   * flowing through the delay line unlatched (see routeClipFrame's own doc
   * comment); cleared the moment voiceActive genuinely drops back to false
   * -- or (final wave W1, A18) CLIP_PRE_CLIP_TAIL_MAX_MS after that first
   * frame, whichever comes first.
   */
  let clipHoldPreClipTail = false;
  let clipHoldPreClipTailChecked = false;
  /** The clip's first routed frame (A18's bound runs from here). */
  let clipRouteStartAtMs = null;
  const CLIP_DELAY_LINE_MAX_FRAMES = Math.max(1, Math.ceil(CLIP_HOLD_DELAY_LINE_MS / 20));
  /**
   * F-R2 fix round 2 (opus re-review, NB2). A raw voiced frame while WATCHING
   * (not yet latched, not in the pre-clip tail) latches PROVISIONALLY into
   * this SEPARATE buffer -- never clipDelayLine, never clipHoldBuffer -- for
   * up to CLIP_CONFIRM_WINDOW_MS. Confirmed (CLIP_CONFIRM_VOICED_FRAMES
   * voiced frames counted within the window) -> folds into the ordinary
   * hold and clipHoldVoiceLatched takes over, unchanged from fix round 1.
   * Timed out unconfirmed -> released straight back to Live, in order (see
   * CLIP_HOLD_DELAY_LINE_MS's own doc comment, firstSeconds.js, for the full
   * derivation and the measured numbers).
   */
  let clipProvisional = false;
  let clipProvisionalBuffer = [];
  let clipProvisionalStartAtMs = null;
  let clipProvisionalVoicedCount = 0;
  /**
   * Guards `maybeReleaseClipHold` against firing before the clip has ever
   * fired at all: clipPlaying() reads false for the whole call up to that
   * point too, and without this a check running on the FIRST media frame
   * (long before any backstop decision) would latch clipHoldOpen closed
   * before pushClipHold ever ran once -- silently disabling the entire hold
   * for the rest of the call. Set exactly once, the first time a frame is
   * actually captured (see pushClipHold), which happens on the SAME frame
   * dialFirstSeconds.tick() first sets clipPlaying true (fireBackstop, then
   * this file's own routing decision, both within the one onMediaFrame
   * call), so there is no gap in which a real hold could be missed by this
   * guard.
   */
  let clipHoldEverStarted = false;
  const CLIP_HOLD_MAX_FRAMES = Math.max(1, Math.ceil(CLIP_CALLER_HOLD_MAX_MS / 20));

  // Stage 4 S4-2. Every caller frame routed through the clip hold, in ARRIVAL
  // order, held or not (references, not copies; capped like the hold). The hold
  // buffers only keep what they still hold: once a voice latch is on, the
  // unvoiced frames (pauses, a soft word-end) overflow the delay line straight
  // to Live. If Live then fails to transcribe the drain, Deepgram must read the
  // WHOLE utterance, not the voiced islands of it -- a measured 13-frame hole
  // at the end of "Please stop calling me." otherwise. Read only by
  // beginClipHoldDrain; nothing else consumes it.
  let clipCallerRecord = [];

  // Final wave W1 (I2, A12): every clip-hold buffer (clipDelayLine,
  // clipProvisionalBuffer, clipHoldBuffer) holds ENTRIES `{ f, v }` -- the
  // raw mu-law frame and the VAD's own per-frame `voiced` verdict for it --
  // so the teardown (and the hang-up drain) can tell held SPEECH from held
  // silence without re-running a VAD over the bytes.
  const clipEntry = (frame, voiced) => ({ f: frame, v: Boolean(voiced) });
  const sendClipEntry = (e) => sendAudio(e.f);

  function pushClipHold(e) {
    clipHoldEverStarted = true;
    if (clipHoldOpen) {
      sendClipEntry(e);
      return;
    }
    clipHoldBuffer.push(e);
    if (clipHoldBuffer.length > CLIP_HOLD_MAX_FRAMES) {
      clipHoldBuffer.shift();
      clipHoldDroppedTotal += 1;
      bumpCounter("outbound_clip_hold_dropped");
    }
  }

  /**
   * F-R2 (Direction A; fix round 1, I1; fix round 2, NB2). The ONE entry
   * point for a caller frame while dialFirstSeconds.clipPlaying() is true
   * (replaces the old unconditional pushClipHold call in onMediaFrame).
   * Takes BOTH `voiced` (the VAD's raw, per-frame verdict) and `voiceActive`
   * (its SUSTAINED/confirmed flag, O-6's own onset-confirm notion) plus
   * `atMs`. See CLIP_HOLD_DELAY_LINE_MS's own doc comment (firstSeconds.js)
   * for the full history and the measured numbers behind every constant
   * here.
   *
   * Four phases, in order, per clip:
   *   1. PRE-CLIP TAIL (only entered if voiceActive was ALREADY true on the
   *      very first frame processed for this clip -- backstop_slow can fire
   *      mid-utterance by design): frames flow through the delay line
   *      unlatched, exactly like silence, for as long as voiceActive stays
   *      continuously true. Ends the moment voiceActive genuinely drops to
   *      false (the VAD's own hangover-confirmed gap) -- or, final wave W1
   *      (A18), CLIP_PRE_CLIP_TAIL_MAX_MS after the clip's first frame,
   *      whichever is first: a talker whose gaps never reach the hangover
   *      used to stay here for the whole clip, every word of it reaching
   *      Live before the seed. This is a one-time SNAPSHOT of "already
   *      mid-utterance", not an ongoing confirm decision, so voiceActive is
   *      still exactly the right signal for it.
   *   2. WATCHING (the only phase entered when phase 1 never applied, and
   *      what phase 1 falls into once it ends): a raw voiced frame moves to
   *      phase 3 (PROVISIONAL); anything else flows through the delay line
   *      unlatched.
   *   3. PROVISIONAL (fix round 2, NB2 -- replaces round 1's "latch only on
   *      voiceActive", which let up to ~1.6 s of genuine speech reach Live
   *      before ever confirming, and 16/39 real utterances at -12 dB never
   *      confirmed at all). Latches on the FIRST raw voiced frame -- the
   *      same zero-onset-lag property the very first (pre-C1) design had --
   *      into ITS OWN buffer (clipProvisionalBuffer), separate from both the
   *      delay line and the real hold. Confirmed (CLIP_CONFIRM_VOICED_FRAMES
   *      voiced frames counted within CLIP_CONFIRM_WINDOW_MS of the latch --
   *      a COUNT, not voiceActive's strict consecutive-frames rule) -> folds
   *      into the ordinary hold and moves to phase 4. Timed out unconfirmed
   *      (the window elapses first) -> the buffer is released straight back
   *      to Live, in order, and this frame is re-evaluated fresh under phase
   *      2's own rules (a genuinely continuing run re-latches provisionally
   *      at once; a true blip, now past, resumes ordinary watching).
   *   4. LATCHED (final wave W1, A15 -- replaces "every later frame, voiced
   *      or not, goes straight into the hold"): a VOICED frame is held at
   *      once (the caller is confirmed to be talking during this clip, so no
   *      new provisional window), after first draining whatever the delay
   *      line holds into the hold as its PRE-ROLL (the sub-threshold lead-in
   *      of the run, up to CLIP_HOLD_DELAY_LINE_MS); a NON-voiced frame goes
   *      back through the delay line and on to Live, exactly as in phase 2.
   *      WHY: a latched hold used to withhold the silence too, so Live's own
   *      end-of-turn for the PRE-clip hello could no longer fire during the
   *      clip -- a sustained second "Hello?" or two short bursts inside the
   *      confirm window (F-R2 re-review 1 m1 / re-review 2 m2) then brought
   *      the stale hello reply back AFTER the opener, the defect F-R2 exists
   *      to prevent. C1 is unchanged by this: no voiced frame reaches Live
   *      before the seed (only silence older than the pre-roll does), and the
   *      held speech is released after it. ORDER: after a latch everything
   *      in the hold is older than anything in the delay line (each voiced
   *      frame drains the line first), so a release sends the hold, then the
   *      line; each stream reaches Live in arrival order, and the held speech
   *      arrives after silence that followed it -- the one reordering this
   *      design exists to make.
   */
  function pushDelayLine(e) {
    clipDelayLine.push(e);
    if (clipDelayLine.length > CLIP_DELAY_LINE_MAX_FRAMES) sendClipEntry(clipDelayLine.shift());
  }

  /**
   * Phase 3 exit A (NB2): confirmed -- fold the provisional buffer into the
   * real hold and latch for good. The delay line drains here TOO (in order,
   * BEFORE the provisional buffer -- phase 3 is only ever entered once phase
   * 2 has stopped feeding it, so anything still there is strictly older):
   * whatever silence was sitting there from before this provisional episode
   * started must not be orphaned, uncapped, outside pushClipHold's own
   * CLIP_HOLD_MAX_FRAMES accounting -- the same reason fix round 1's own
   * "voiced -> latch straight to phase 4" transition drained it.
   */
  function confirmClipProvisional() {
    clipHoldVoiceLatched = true;
    clipProvisional = false;
    const delayed = clipDelayLine;
    clipDelayLine = [];
    for (const f of delayed) pushClipHold(f);
    const confirmed = clipProvisionalBuffer;
    clipProvisionalBuffer = [];
    for (const f of confirmed) pushClipHold(f);
  }

  /**
   * Phase 3 exit B (NB2): unconfirmed within the window -- release straight
   * back to Live, in order, counted.
   *
   * F-R2 fix round 3 (opus re-review 2, N1). The delay line is flushed
   * FIRST, here, before the provisional buffer -- both still direct,
   * immediate `sendAudio`, no added delay. Phase 3 is only ever entered
   * once phase 2 has stopped feeding the delay line (see routeClipFrame's
   * own phase comment), so up to CLIP_DELAY_LINE_MAX_FRAMES of whatever was
   * sitting there is strictly OLDER than anything in clipProvisionalBuffer.
   * The pre-fix version sent the provisional buffer alone and left that
   * older content to trickle out later (from whatever released it next),
   * inverting order every single time this ran -- usually just silence
   * reordered against silence, but for a quiet caller the delay line can
   * hold the sub-threshold LEAD-IN of their own utterance, so their own
   * speech arrived at Live out of order.
   */
  /**
   * Final wave W1 (A20, F-R2 re-review 2 m1): `reason` says why. "window" is
   * the provisional window timing out unconfirmed -- the event the counter
   * exists for (a click, a cough, background noise; a high rate means the
   * confirm threshold is miscalibrated). "clip_release" is the clip's own end
   * releasing a latch still pending -- often the true start of the caller's
   * next words, delivered after the seed exactly as it should be -- so it is
   * logged, with its reason, but NOT counted (it used to pollute the alarm).
   * A28 (re-review 3 m2): the log counts EVERY frame this sent -- the
   * delay-line frames flushed ahead of the provisional ones, too (it logged
   * 40 when 65 went out).
   */
  function unlatchClipProvisional(reason) {
    clipProvisional = false;
    const released = clipProvisionalBuffer;
    clipProvisionalBuffer = [];
    clipProvisionalVoicedCount = 0;
    if (released.length === 0) return;
    const delayed = flushClipDelayLine();
    for (const e of released) sendClipEntry(e);
    if (reason === "window") bumpCounter("outbound_clip_provisional_unlatched");
    log.info("outbound_clip_provisional_unlatched", {
      callSid,
      reason,
      frames: delayed + released.length,
      provisional_frames: released.length,
      delay_line_frames: delayed,
    });
  }

  /** A15: a latched clip's next voiced frame takes the delay line's content with it, as pre-roll. */
  function drainDelayLineIntoHold() {
    if (clipDelayLine.length === 0) return;
    const delayed = clipDelayLine;
    clipDelayLine = [];
    for (const d of delayed) pushClipHold(d);
  }

  function routeClipFrame(frame, voiced, voiceActive, atMs) {
    const e = clipEntry(frame, voiced);
    clipCallerRecord.push(frame);
    if (clipCallerRecord.length > CLIP_HOLD_MAX_FRAMES) clipCallerRecord.shift();
    clipHoldEverStarted = true;
    if (!clipHoldPreClipTailChecked) {
      clipHoldPreClipTailChecked = true;
      clipHoldPreClipTail = voiceActive;
      clipRouteStartAtMs = atMs;
    }
    if (clipHoldVoiceLatched) {
      // Phase 4 (A15): hold only the voiced runs (with their pre-roll); the
      // silence keeps flowing so Live's own end-of-turn can still fire.
      if (voiced) {
        drainDelayLineIntoHold();
        pushClipHold(e);
      } else {
        pushDelayLine(e);
      }
      return;
    }
    if (clipHoldPreClipTail) {
      // A18: bounded -- a talker who never pauses long enough for voiceActive
      // to drop leaves phase 1 CLIP_PRE_CLIP_TAIL_MAX_MS into the clip.
      if (voiceActive && atMs - clipRouteStartAtMs < CLIP_PRE_CLIP_TAIL_MAX_MS) {
        pushDelayLine(e);
        return;
      }
      clipHoldPreClipTail = false; // the pre-clip utterance just ended (or ran past the bound); fall through to phase 2
    }
    if (clipProvisional) {
      if (atMs - clipProvisionalStartAtMs >= CLIP_CONFIRM_WINDOW_MS) {
        // Timed out BEFORE this frame: release everything accumulated so
        // far (never including this frame -- it was never added), then
        // fall through to handle THIS frame fresh. Never double-counted.
        unlatchClipProvisional("window");
      } else {
        clipProvisionalBuffer.push(e);
        if (voiced) clipProvisionalVoicedCount += 1;
        if (clipProvisionalVoicedCount >= CLIP_CONFIRM_VOICED_FRAMES) confirmClipProvisional();
        return;
      }
    }
    if (voiced) {
      clipProvisional = true;
      clipProvisionalStartAtMs = atMs;
      clipProvisionalBuffer = [e];
      clipProvisionalVoicedCount = 1;
      return;
    }
    pushDelayLine(e);
  }

  /**
   * F-R2: whatever is still sitting in the delay line at release is the last
   * (short) stretch of silence that had not yet reached its own
   * overflow-triggered send -- flushed here, in order, still real
   * (undelayed) delivery, just late. Called from releaseClipHold and
   * unlatchClipProvisional; teardownClipHold (there is no Live left to
   * deliver to at that point) merges the delay line into clipHoldBuffer
   * instead, so its own leftover frames are counted and logged the same way
   * the held buffer's are.
   */
  /** @returns {number} how many frames it sent */
  function flushClipDelayLine() {
    if (clipDelayLine.length === 0) return 0;
    const entries = clipDelayLine;
    clipDelayLine = [];
    for (const e of entries) sendClipEntry(e);
    return entries.length;
  }

  /** See the block comment above: safe to call more than once for the same clip. */
  function releaseClipHold(reason) {
    if (clipHoldVoiceLatched) {
      // Final wave W1 (A15): after a latch the hold is OLDER than the delay
      // line (every voiced frame drained the line into the hold first), so
      // arrival order is the hold, then the line. Nothing provisional can be
      // pending once latched.
      releaseHeldBuffer(reason);
      flushClipDelayLine();
      return;
    }
    flushClipDelayLine();
    // F-R2 fix round 2 (NB2): a provisional latch still pending when the
    // clip's own release fires (the clip ended before the confirm window
    // did) releases the SAME way an internal timeout would -- unconfirmed
    // content reaching Live directly is the same event either way. Always
    // AFTER the delay line: phase 3 (provisional) is only ever entered once
    // phase 2 (watching, the delay line's own phase) has already stopped
    // accepting new content, so anything still in the delay line here is
    // strictly older. (A20: reason "clip_release" -- logged, not counted.)
    unlatchClipProvisional("clip_release");
    releaseHeldBuffer(reason);
  }

  /** The hold's own release, once: clipHoldOpen latches here. */
  function releaseHeldBuffer(reason) {
    if (clipHoldOpen) return;
    clipHoldOpen = true;
    // A5: the clip ENDED (not a barge, which clears the audio at once): its
    // tail may still be "playing" for up to isPlaying()'s grace -- see
    // clipTailBypassActive.
    clipTailBypassOpen = reason !== "barge";
    if (clipHoldBuffer.length === 0) return;
    const frames = clipHoldBuffer;
    clipHoldBuffer = [];
    for (const e of frames) sendClipEntry(e);
    bumpCounter("outbound_clip_hold_released");
    log.info("outbound_clip_hold_released", {
      callSid,
      frames: frames.length,
      dropped: clipHoldDroppedTotal,
      reason,
    });
  }

  /**
   * Final wave W1 (A5, checkpoint-A re-review N4). Open from the clip hold's
   * natural release until the clip's own audio is truly off the wire
   * (isPlaying() false) or Live's own audio starts playing -- whichever is
   * first; one-shot. While open, onMediaFrame forwards caller frames
   * directly instead of through the half-duplex gate (see the routing there).
   */
  let clipTailBypassOpen = false;
  function clipTailBypassActive() {
    if (!clipTailBypassOpen) return false;
    if (!isPlaying()) clipTailBypassOpen = false;
    return clipTailBypassOpen;
  }

  /**
   * N1/N2 fix (checkpoint-A re-review). The only release rule: has the clip
   * actually fired at least once (clipHoldEverStarted), and is its own
   * audio now off the wire (clipPlaying() false)? Checked from several call
   * sites (see the block comment above) because that transition is not
   * visible from a single one of them.
   */
  function maybeReleaseClipHold(reason) {
    if (clipHoldEverStarted && !dialFirstSeconds?.clipPlaying?.()) releaseClipHold(reason);
  }

  /**
   * Everything the clip hold still has, in ARRIVAL order, taken out of every
   * buffer. Before a confirmed latch the hold itself is empty, and the delay
   * line is older than a pending provisional episode (phase 3 only starts
   * once phase 2 has stopped feeding the line): line, then provisional.
   * After a latch nothing is provisional and the hold is older than the line
   * (A15: each voiced frame drains the line into the hold first): hold, then
   * line -- the same order releaseClipHold uses.
   */
  function takeClipHeldInOrder() {
    const held = clipHoldVoiceLatched
      ? [...clipHoldBuffer, ...clipDelayLine]
      : [...clipDelayLine, ...clipProvisionalBuffer, ...clipHoldBuffer];
    clipDelayLine = [];
    clipProvisionalBuffer = [];
    clipHoldBuffer = [];
    clipProvisional = false;
    clipProvisionalVoicedCount = 0;
    return held;
  }

  /**
   * N1 fix (checkpoint-A re-review). The session is ending and there is no
   * Live left to deliver held audio to (no session, or finish() found no
   * held SPEECH worth draining -- see beginClipHoldDrain, which normally
   * takes everything first). Whatever is still buffered is DROPPED, not
   * released: sendAudio itself already no-ops once `closed` is true
   * (finish() sets it before this runs), which would silently count as
   * "released" while delivering nothing.
   *
   * Final wave W1 (A12, F-R2 m6/M6/m4): the loss is split by what was lost.
   * Silence and an unconfirmed provisional blip used to be counted under
   * `outbound_clip_hold_dropped` one per frame, which buried the one signal
   * that matters -- held caller SPEECH lost at teardown (I2's own signal) --
   * under the delay line's routine leftovers. `outbound_clip_hold_dropped`
   * now means the cap only; `outbound_clip_hold_voiced_dropped` counts the
   * VOICED frames lost here, one per frame; the log line carries both
   * numbers.
   *
   * log.info, not log.error: a call ending before the clip has run its
   * course (a quick hang-up, a short voicemail-shaped pickup) is ordinary,
   * not exceptional. (F13: this comment used to say it "fires on almost
   * every call" on the silence path -- true of the test harness, whose calls
   * mostly end mid-clip, not of production, where it fires only when a call
   * ends while the clip is still playing.) The voiced counter is the signal
   * to watch; this line is context for it.
   */
  function teardownClipHold() {
    clipHoldOpen = true;
    const held = takeClipHeldInOrder();
    if (held.length === 0) return;
    const voiced = held.filter((e) => e.v).length;
    clipHoldDroppedTotal += held.length;
    for (let i = 0; i < voiced; i++) bumpCounter("outbound_clip_hold_voiced_dropped");
    log.info("outbound_clip_hold_teardown_dropped", { callSid, frames: held.length, voiced_frames: voiced });
  }

  // -------------------------------------------------------------------------
  // FINAL WAVE W1, I2 (final review; ledger m1 / A7). An opt-out said DURING
  // the clip, followed by a hang-up before the clip ends, used to be lost:
  // the words sat in the hold (C1 keeps them from Live until the seed), the
  // hang-up dropped them, Live never heard them, no caller row existed, and
  // the post-call D9 detector had nothing to scan -- so the retry schedule
  // re-dialled someone who had said "stop calling me".
  //
  // Ruling: RELEASE, don't drop. At finish(), when the hold still carries
  // VOICED frames and Live is still open, everything held goes to Live, in
  // arrival order, followed by the end of the audio stream; the Live session
  // is kept open for a short bounded drain while its input transcription
  // for those frames arrives (Live is the only ASR on this path); the words
  // become a caller row by the ordinary transcript write; and only then do
  // the post-call readers run (finish() chains them on the drain).
  //   - Not a second ASR (the review's alternative, one STT pass over the
  //     buffer): that is a new vendor wire, a new key, and a transcript
  //     from a different model than every other row on the call -- this
  //     path uses the session that is already open and already transcribes
  //     every other word the caller says.
  //   - Bounded: CLIP_HOLD_DRAIN_MAX_MS from the hang-up at most, and done
  //     sooner once the transcript has settled (CLIP_HOLD_DRAIN_SETTLE_MS
  //     with no new caller text) or Live closes.
  //   - Nobody is listening any more: dialFirstSeconds.onCallerGone() makes
  //     every later Live output unheard (no AI row, no guard, no fold), and
  //     A19's tool gate refuses anything caller-visible (end_call, a
  //     booking, a transfer) while still letting an opt_out/set_call_outcome
  //     write run -- which, for "stop calling me", is the point.
  // Cost if wrong: the vendor does not transcribe audio sent after the
  // caller's leg ended -- then the drain times out with no text
  // (outbound_clip_hold_drain_untranscribed says how often) and the call is
  // no worse off than before this change, just ~2 s later to post-call.
  // -------------------------------------------------------------------------
  /** Resolves once the hang-up drain is over (null when finish() found nothing to drain). */
  let clipDrain = null;
  let clipDrainResolve = null;
  let clipDrainTimer = null;
  let clipDrainSettleTimer = null;
  let clipDrainTranscribed = false;
  // FINAL FIX WAVE N2: the caller text Live transcribed during the drain, so
  // the row that carries it can be read back (see verifyTranscribedDrain).
  let clipDrainText = "";
  // Residual fix 2: transcript sequence at the start of the drain (set in finish()).
  let clipDrainSeqFloor = 0;
  let clipDrainStartedAt = 0;
  // Stage 4 S4-2: the caller's mu-law frames for the Deepgram fallback (the
  // whole clip-window record, see clipCallerRecord), kept only when speech was
  // held (outbound only). Single-use: taken (and nulled) by runClipHoldStt, so
  // a second drain can never run a second STT.
  let clipDrainAudio = null;
  // S4-2 fix round 1 (I2): set when the drain was untranscribed and nothing
  // proves the caller's words were checked. Handed to this process's own
  // post-call claim, whatever happens to the calls.answers marker write.
  let optoutUnverifiedHint = false;
  // r1: true once calls.answers._optout_unverified is known to be in the database.
  let optoutMarkerWritten = false;

  /**
   * Called from finish() BEFORE `closed = true` (sendAudio refuses a closed
   * session). Returns the drain's promise, or null when there is nothing to
   * drain -- no clip hold ever started, nothing voiced held, or no Live.
   */
  function beginClipHoldDrain() {
    if (!dialFirstSeconds || !clipHoldEverStarted || closed) return null;
    const pending = [...clipDelayLine, ...clipProvisionalBuffer, ...clipHoldBuffer];
    const voiced = pending.filter((e) => e.v).length;
    if (voiced === 0) return null;
    if (!session) {
      // FINAL FIX WAVE I1. The hang-up came while Live was not open yet (a cold
      // connect, or a connect that failed): the opener clip can already be
      // playing and holding the person's speech, because dialFirstSeconds is
      // built BEFORE the vendor connect. There is no Live to drain to, but
      // the whole clip-window record is in memory, so it goes straight to the
      // Deepgram one-shot -- same persist, read-back, marker and hint as an
      // untranscribed drain. Returning null here dropped the speech and
      // re-dialled someone who may have said "stop calling me".
      takeClipHeldInOrder(); // the held frames are inside clipCallerRecord already
      clipDrainAudio = { frames: clipCallerRecord, voiced };
      clipCallerRecord = [];
      clipHoldOpen = true;
      dialFirstSeconds.onCallerGone();
      clipDrainStartedAt = now();
      bumpCounter("outbound_clip_hold_drained");
      log.info("outbound_clip_hold_drained", { callSid, frames: 0, voiced_frames: voiced, live_open: false });
      return runClipHoldStt().catch(() => {});
    }
    const held = takeClipHeldInOrder();
    clipDrainAudio = { frames: clipCallerRecord, voiced };
    clipCallerRecord = [];
    clipHoldOpen = true;
    dialFirstSeconds.onCallerGone();
    clipDrainStartedAt = now();
    // The caller's own end of the stream: with the vendor's automatic
    // activity detection (the default arm) that is `audioStreamEnd`, which
    // tells Live no more audio is coming so it closes the turn on what it
    // has; a manual arm brackets the burst itself.
    if (strategy.manual) signal("start");
    for (const e of held) sendClipEntry(e);
    if (strategy.manual) signal("end");
    else {
      try {
        session.sendRealtimeInput({ audioStreamEnd: true });
      } catch (err) {
        log.error("live_send_audio_failed", { callSid, reason: err?.message, severity: "warn" });
      }
    }
    bumpCounter("outbound_clip_hold_drained");
    log.info("outbound_clip_hold_drained", { callSid, frames: held.length, voiced_frames: voiced });
    return new Promise((resolve) => {
      clipDrainResolve = resolve;
      clipDrainTimer = setTimeout(() => endClipHoldDrain("max"), clipDrainMaxMs);
    });
  }

  /** A caller transcript fragment arrived during the drain: wait for it to settle. */
  function noteClipDrainTranscript(text) {
    if (!clipDrainResolve) return;
    // S4-2 (review M1): a whitespace-only fragment is not a transcript. It
    // must neither count as "Live transcribed" (that would skip the Deepgram
    // fallback and write no row) nor re-arm the settle timer.
    if (!String(text ?? "").trim()) return;
    clipDrainTranscribed = true;
    clipDrainText += text;
    clearTimeout(clipDrainSettleTimer);
    clipDrainSettleTimer = setTimeout(() => endClipHoldDrain("settled"), clipDrainSettleMs);
  }

  function endClipHoldDrain(reason) {
    if (!clipDrainResolve) return;
    const resolve = clipDrainResolve;
    clipDrainResolve = null;
    clearTimeout(clipDrainTimer);
    clearTimeout(clipDrainSettleTimer);
    clipDrainTimer = null;
    clipDrainSettleTimer = null;
    // The drained speech's own row: the CALLER half only. The caller had
    // hung up, so nothing Live said since was heard (onCallerGone).
    const drainWrite = persistTurnTranscript(turnUserText.trim(), "");
    bumpCounter(clipDrainTranscribed ? "outbound_clip_hold_drain_transcribed" : "outbound_clip_hold_drain_untranscribed");
    log.info("outbound_clip_hold_drain_settled", {
      callSid,
      reason,
      transcribed: clipDrainTranscribed,
      waited_ms: Math.round(now() - clipDrainStartedAt),
    });
    closeLiveSession();
    // STAGE 4, S4-2. Live transcribed nothing of the held speech: do not let
    // that read as "the caller said nothing". The held audio (kept by
    // beginClipHoldDrain) goes once to Deepgram, and the resolve below waits on
    // it -- post-call reads the transcript only from the DB, so the row (or the
    // unverified marker) must exist before the settle promise resolves. Bounded
    // twice over (see runClipHoldStt); never rejects.
    if (clipDrainTranscribed) {
      // FINAL FIX WAVE N2: Live's words are only as good as the row that carries
      // them. The write above is fire-and-forget through the swallowing
      // withTenantSafe + addTranscriptEntry pair, so read it back exactly as the
      // Deepgram branch does; a row that is not there means UNVERIFIED (hold),
      // never "the caller said nothing".
      clipDrainAudio = null;
      verifyTranscribedDrain(drainWrite).then(resolve, resolve);
      return;
    }
    if (!clipDrainAudio) {
      resolve();
      return;
    }
    runClipHoldStt().then(resolve, resolve);
  }

  /**
   * FINAL FIX WAVE N2. The Live-transcribed drain's caller row, verified. Never
   * throws (the settle promise must always resolve).
   */
  async function verifyTranscribedDrain(write) {
    try {
      await write;
    } catch {
      /* the read-back below is the judge, not the write's own outcome */
    }
    // RESIDUAL FIX 1: `write` is undefined when Live's own turn close already
    // took the write latch, and that write may still be in flight. Wait for the
    // whole write chain (never rejects) so the read-back cannot run ahead of it
    // and hold a correctly transcribed call for review.
    await transcriptSettled;
    const expected = clipDrainText.trim();
    if (!expected) return;
    // RESIDUAL FIX 2: only rows written since the drain began (sequence >=
    // clipDrainSeqFloor) can vouch for it -- an earlier caller row that happens
    // to contain the same words must not.
    if (await callerRowLanded(expected, { partOk: true, minSeq: clipDrainSeqFloor })) return;
    bumpCounter("outbound_clip_hold_drain_row_unverified");
    log.info("outbound_clip_hold_drain_row_unverified", { callSid, chars: expected.length });
    optoutUnverifiedHint = true;
    await markOptoutUnverified("drain_row_unverified");
  }

  /**
   * Stage 4 S4-2. Deepgram reads the audio Live did not. Outcomes:
   *   - non-empty text, persisted as the caller row: the ordinary post-call D9
   *     detector reads it (opted_out, or a normal retry if there is no opt-out);
   *   - anything else -- Deepgram error, timeout, no key, hipaa refusal, empty
   *     text, or a row that could not be written -- means the held speech is
   *     UNVERIFIED: the attempt is marked and post-call holds the lead for
   *     review instead of re-dialling it (owner rule 2026-09-29).
   * The log line carries counts and a reason class, never text or audio.
   */
  async function runClipHoldStt() {
    const audio = clipDrainAudio;
    clipDrainAudio = null; // single-use: a second drain can never run a second STT
    const startedAt = performance.now();
    let ok = false;
    let chars = 0;
    let why = null;
    let reason;
    let deadline;
    try {
      const pending = Promise.resolve(
        clipHoldStt({
          frames: audio.frames,
          callSid,
          // The session's own language (en-GB for UK numbers), never a
          // hard-coded en-US; plain "en" before it is resolved.
          language: sessionLanguageCode || "en",
          timeoutMs: clipHoldSttTimeoutMs,
        })
      );
      pending.catch(() => {}); // a late rejection after the deadline is not unhandled
      // The helper bounds itself; this is the belt for a stub or a future
      // implementation that does not, so the teardown can never hang on it.
      const out = await Promise.race([
        pending,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("clip hold stt deadline")), clipHoldSttTimeoutMs + 1000);
        }),
      ]);
      const text = typeof out?.text === "string" ? out.text.trim() : "";
      if (!text) why = "empty";
      else {
        const wrote = persistTurnTranscript(text, "");
        if (!wrote) why = "not_persisted";
        else if (!(await wrote)) why = "write_failed";
        // S4-2 fix round 1 (I1): the write's own boolean cannot be trusted --
        // withTenantSafe swallows a throw into its fallback and
        // addTranscriptEntry logs a failed INSERT and returns, so both read as
        // success. Only a read-back proves the caller's words are in the
        // transcript post-call will read. fetchCallTranscript answers [] on
        // any error, which reads as "missing" and fails closed.
        else if (!(await callerRowLanded(text))) why = "write_unverified";
        else {
          ok = true;
          chars = text.length;
        }
      }
    } catch (err) {
      why = err?.name === "ComplianceViolationError" ? "hipaa_refused" : "error";
      reason = err?.message;
    } finally {
      clearTimeout(deadline);
    }
    bumpCounter(ok ? "outbound_clip_hold_stt_ok" : "outbound_clip_hold_stt_failed");
    log.info("outbound_clip_hold_stt", {
      callSid,
      ok,
      chars,
      ms: Math.round(performance.now() - startedAt),
      ...(why ? { why } : {}),
      ...(reason ? { reason } : {}),
    });
    if (!ok) {
      // Two channels, on purpose. The in-process hint rides this process's own
      // post-call claim (finish()), so a lost marker cannot lead to a re-dial;
      // the calls.answers marker is the durable one for any other claimant.
      optoutUnverifiedHint = true;
      await markOptoutUnverified(why);
    }
  }

  /** True iff a caller row with exactly this text is now in the DB. Never throws. */
  async function callerRowLanded(text, { partOk = false, minSeq = null } = {}) {
    try {
      const rows = await database.withTenantSafe(state.businessId, () => database.fetchCallTranscript(state.dbCallId), {
        operation: "fetchCallTranscript",
        callSid,
        fallback: [],
      });
      // partOk (N2): the drain's words may have been split across turn rows, so a
      // caller row holding some of them counts; the Deepgram branch wrote one
      // row of exactly this text and keeps the exact match.
      return (
        Array.isArray(rows) &&
        rows.some(
          (r) =>
            r?.speaker === "caller" &&
            typeof r?.message === "string" &&
            (minSeq === null || Number(r?.sequence) >= minSeq) &&
            (r.message === text || (partOk && r.message.trim() && (text.includes(r.message.trim()) || r.message.includes(text))))
        )
      );
    } catch {
      return false;
    }
  }

  /**
   * calls.answers._optout_unverified = true, written BEFORE the settle promise
   * resolves so post-call's context read sees it. Retried: a lost marker means
   * the lead is re-dialled, which is exactly what this path exists to prevent.
   * If every attempt fails the loss is logged as an ERROR (alertable) and the
   * teardown carries on. What is then guaranteed is narrower than "held
   * regardless" (FINAL FIX WAVE r1): the in-process hint (optoutUnverifiedHint)
   * rides only THIS process's own post-call claim. If that claim succeeds the
   * lead is held; if it fails, or another instance (the Twilio status path, the
   * sweep) claims first, only the durable marker reaches it -- so finish()
   * retries the marker after a claim that was not ours (retryMarkerAfterLostClaim)
   * and raises outbound_optout_unverified_hint_dropped if that fails too.
   * Worst case per attempt is the pool's connect timeout (5 s), so up to ~15 s
   * for the drain's own 3 attempts, and up to ~25 s in all with the r1 retry
   * (4 more attempts, 1.5 s apart). Post-call, not the caller, waits on it.
   * @returns {Promise<boolean>} whether the marker is in the database
   */
  async function markOptoutUnverified(why, { attempts = 3, delayMs = 200, quiet = false } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        const done = await database.withTenantSafe(
          state.businessId,
          async () => {
            await database.mergeCallAnswers(callSid, { _optout_unverified: true });
            return true;
          },
          { operation: "mergeCallAnswers", callSid, fallback: false }
        );
        if (done === true) {
          optoutMarkerWritten = true;
          return true;
        }
      } catch {
        /* retried below */
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    if (!quiet) {
      bumpCounter("outbound_optout_unverified_marker_failed");
      log.error("outbound_optout_unverified_marker_failed", { callSid, attemptId: state.attemptId, why, attempts });
    }
    return false;
  }

  /**
   * FINAL FIX WAVE r1. The hint rode a post-call claim that was not ours (it
   * returned false, or threw): another process may hold the run and never saw
   * the hint, so the durable marker is the only thing that can stop it (or a
   * released-claim retry) from rescheduling. Already in the database: nothing
   * to do. Otherwise retry it with a longer backoff, bounded well inside the
   * post-call sweep's window (~2 min); if it still cannot be written, the
   * verdict is lost to every other process -- an alertable ERROR.
   */
  async function retryMarkerAfterLostClaim(claimOutcome) {
    if (optoutMarkerWritten) return;
    const ok = await markOptoutUnverified("claim_not_ours", { attempts: 4, delayMs: 1500, quiet: true });
    if (ok) return;
    bumpCounter("outbound_optout_unverified_hint_dropped");
    log.error("outbound_optout_unverified_hint_dropped", { callSid, attemptId: state.attemptId, claim: claimOutcome });
  }

  /** The Live session's own close, shared by finish() and the end of the hang-up drain. */
  function closeLiveSession() {
    try {
      session?.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * What finish()'s post-call readers wait on: the transcript writes -- and,
   * after a hang-up drain, the drain first (its caller row is written at its
   * end). Read at CALL time, not captured: persistTranscriptRows reassigns
   * `transcriptSettled` for every write. Exactly `transcriptSettled` when
   * there was no drain, which is every inbound call.
   */
  function whenTranscriptSettled() {
    return clipDrain ? clipDrain.then(() => transcriptSettled) : transcriptSettled;
  }

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
  /**
   * 2026-10-01 (spec 2026-10-01-outbound-live-first-line §5b): what the AI
   * has actually said this call -- HEARD generations only (a clip-discarded
   * or hold-muted one never counts) -- the read-back evidence record_answer
   * checks a `confirm` answer against (capabilities/qualification.js). Same
   * cap as the caller side.
   */
  let assistantSaidThisCall = "";
  /**
   * Final review #8: added only when a HEARD generation closes. Live streams a
   * reply's words before its tool call, so per-chunk evidence let "Best
   * College -- did I get that right?" + record_answer in ONE reply pass before
   * the person could answer; the spec's read-back is an earlier turn.
   */
  function noteAssistantSaid(heard, text) {
    const said = String(text || "").trim();
    if (!heard || !said) return;
    assistantSaidThisCall = (assistantSaidThisCall + " " + said).slice(-CALLER_TRANSCRIPT_CAP);
  }
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
   * THIS IS NOW THE CONDITION THE CLAIM GUARD ACTS ON — LVX127, 2026-09-12.
   * It drove a counter only until that call, on the ladder LVX31 left in place:
   * count first, act once the number says how often it fires when nothing is
   * wrong. The number said. CA41622e81 claimed three completions on a call that
   * wrote nothing, and two of them were licensed by tools that could not have
   * done what was claimed — one of them `set_call_intent`.
   *
   * The bias that argued for waiting is now closed too. This read LOW on an
   * interrupted turn, because the interruption path cleared every other
   * accumulator and not this one, so a barged turn's action count survived into
   * the next. Fixed at the interruption site rather than here.
   */
  let actionToolCallsThisTurn = 0;
  /**
   * b25 (checkpoint 2b review). `confirm_identity` calls this turn, OUTBOUND
   * ONLY. Read solely by the promise-without-tool check below --
   * `realToolCallsThisTurn` itself is left alone, per the reviewer's own
   * preference, because it is also read at `toolsRanThisTurn()` and by the
   * zero-text check, and both of those ARE satisfied by confirm_identity
   * having run (the model did something; it is not describing silence).
   *
   * The engine tool carries no caller-visible action: it flips a
   * verification flag and nothing else, so a turn whose only tool call was
   * this one and which ALSO ends in a bare promise ("One moment.") is
   * exactly LVX80's unbacked-promise shape, and the guard must still see it.
   *
   * Gated on `state.outboundCall` at the point this increments (not just
   * on the tool name): the name is reserved but not retroactively renamed
   * on a tenant integration created before the reservation (I1), so on
   * INBOUND a call literally named `confirm_identity` is a real webhook
   * action and must go on counting as one here, unchanged.
   */
  let confirmIdentityCallsThisTurn = 0;
  /**
   * LVX140. DID AN ACTION TOOL SUCCEED THIS TURN -- asked as one fact rather
   * than as the difference of two that are written at different moments.
   *
   * This used to be `actionToolCallsThisTurn - refusedActionCallsThisTurn > 0`,
   * and the arithmetic was right. What was wrong is WHEN each side is written:
   *
   * All three of these are inside `onToolCall`, in this order and no other:
   *
   *     actionToolCallsThisTurn += <action calls in the round>
   *     out = await runner.handleToolCall(toolCall)          <-- yields
   *     refusedActionCallsThisTurn += out.refusedActionCalls
   *
   * `onToolCall` is launched fire-and-forget from `onmessage` and nothing
   * serialises it against the turnComplete path -- `pendingToolCalls` gates the
   * silence ladder and nothing else. On 3.8 turnComplete lands a median 17 ms
   * after a tool call, which lib/voice/live/tools.js measures. When it lands inside that
   * await, applyTurn rolls a tally that holds the ATTEMPT and not yet the
   * REFUSAL, so `actionToolRanPrevTurn` is written TRUE and the next turn's
   * claim is vouched for by a write that was refused.
   *
   * CAd978554, production, 2026-09-18: reschedule_appointment_db refused at
   * 02:17:41, "I have successfully rescheduled your appointment to Tuesday,
   * September 22, at 3:00 PM" at 02:17:48, guard silent, and the fiction then
   * took the caller's consent to cancel an appointment that did not exist. That
   * call's summary reports turns_reply_empty: 3 -- the zero-text tool turns this
   * race needs.
   *
   * So the signal is now POSITIVE and written at the one moment the answer is
   * known: recordToolOutput, which already reads `success` off every function
   * response. `turnSeq` is what lets a result that lands after its own turn
   * ended still be credited to the turn it belonged to, instead of to the wrong
   * one or to neither.
   *
   * The attempt and refusal counters are KEPT. They are read elsewhere (the
   * deferral guard at ~1902) and their series stays comparable with every call
   * taken before this change; they simply no longer decide this question.
   */
  let actionToolSucceededThisTurn = false;
  /**
   * Which turn is current. Advanced ONLY by applyTurn -- not by the interrupt
   * path, which resets a turn's accumulators without ending it, and not by
   * anything else -- so "the previous turn" means the same thing here as it does
   * to `actionToolRanPrevTurn`.
   */
  let turnSeq = 0;
  const actionToolsRanThisTurn = () => actionToolSucceededThisTurn;
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

  // ---- LVX131. THE ONE THING IN HERE THAT WATCHES A REAL CLOCK ------------
  //
  // CAdfeb9d, 2026-09-17: the media websocket died mid-sentence. No `stop`, no
  // `close`, no `error` -- so finish() never ran, and with it no
  // live_call_summary, no postcall_verify, no escalation. That call had a
  // REFUSED booking attempt on it and a caller who was told nothing, which is
  // the exact case the post-call net built earlier the same evening exists for.
  //
  // Ruled out by evidence rather than by reasoning: not a crash (one instance
  // served the whole call and was alive afterwards), not swallowed (`closed` is
  // written in exactly one place, inside finish() itself), not late (still
  // absent four minutes later), not the deploy (three later calls on the same
  // revision tore down cleanly).
  //
  // THE ROOT CAUSE IS THAT NOTHING HERE OBSERVES WALL CLOCK WHILE A CALL IS
  // IDLE. The silence ladder is not a timer -- checkSilence is called once per
  // inbound frame, and says so at its own declaration. The turn-end strategies
  // are the same by design. exitTimer and exitGraceTimer are real timers but
  // are only armed AFTER an exit is requested. So when the frames stop, the
  // session freezes in place rather than tearing down.
  //
  // THE THRESHOLD. Twilio streams a frame every 20 ms including silence, so a
  // fifteen-second gap is not a quiet caller, it is a dead stream -- and the
  // silence ladder's own hang-up rung is 24 s, so a caller who says nothing is
  // still handled by the ladder and never reaches this. The failure modes are
  // not symmetric: a miss costs a frozen session and a lost post-call net, a
  // false positive HANGS UP ON SOMEONE. Hence the generous default, and hence
  // media_gap_max_ms in live_call_summary -- the gap distribution on healthy
  // calls is what turns 15,000 from a judgement into a measurement.
  const MEDIA_TIMEOUT_MS = (() => {
    const v = Number.parseInt(env.LIVE_MEDIA_TIMEOUT_MS, 10);
    return Number.isFinite(v) && v >= 3_000 && v <= 120_000 ? v : 15_000;
  })();
  const MEDIA_WATCHDOG_TICK_MS = 1_000;
  /**
   * LVX147. How long the verification will wait for the judge before deciding
   * without it.
   *
   * The call is already over and nobody is listening, so this costs no caller
   * anything. What it protects is the verification itself: it is the last thing
   * that can tell anyone a caller was lied to, and awaiting an LLM at teardown
   * is precisely the shape that hangs.
   */
  const POSTCALL_JUDGE_WAIT_MS = 15_000;
  /** Distinguishable from a judge that answered null. */
  const JUDGE_TIMED_OUT = Symbol("judge_timed_out");
  /** When the last media frame arrived, on the injected clock. null until the stream starts. */
  let lastMediaAt = null;
  let mediaWatchdog = null;
  /**
   * The largest gap between two frames on this call.
   *
   * Reported in live_call_summary on EVERY call, not just a timed-out one. A
   * counter that only fires on the fault can never say how much headroom the
   * threshold has.
   */
  let mediaGapMaxMs = 0;

  /**
   * Has a frame arrived recently enough for this call to still be a call?
   *
   * Split out from the interval so the decision is one readable line and the
   * sabotage matrix has something to break.
   */
  function mediaIsStale(atMs) {
    if (lastMediaAt == null) return false;
    return atMs - lastMediaAt >= MEDIA_TIMEOUT_MS;
  }

  function startMediaWatchdog() {
    if (mediaWatchdog) return;
    // Armed from the START frame, not from the first media frame: a stream that
    // opens and never delivers a single frame is the same frozen session, and
    // waiting for a frame to arm the thing that watches for frames is how a
    // watchdog misses the case it exists for.
    lastMediaAt = now();
    bumpCounter("live_media_watchdog_armed");
    mediaWatchdog = setInterval(() => {
      if (closed) return;
      const atMs = now();
      if (!mediaIsStale(atMs)) return;
      const gapMs = Math.round(atMs - lastMediaAt);
      bumpCounter("live_media_timeout");
      log.error("live_media_timeout", { callSid, gapMs, thresholdMs: MEDIA_TIMEOUT_MS });
      // finish() has its own `closed` latch, so a tick that races the ordinary
      // teardown is a no-op rather than a second summary.
      finish("media_timeout");
    }, MEDIA_WATCHDOG_TICK_MS);
    mediaWatchdog.unref?.();
  }

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
      // LVX120. Set here rather than at either call site so a third canned line
      // cannot be added without it -- the turn this produces is a line the CALL
      // asked for, and it must not become the reply the caller is answering.
      spokenLinePending = true;
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
    // 2026-10-01 (spec §4): on hold the person is away -- no nudges, no
    // silence goodbye. The clock restarts from the release, so the first
    // rung is never already overdue when they come back.
    if (liveFirstLine && liveFirstLine.onHold()) {
      ladderSince = atMs;
      return;
    }
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
      const line = buildSilenceNudge(
        silenceStage + 1,
        state.step,
        state.intent,
        state.config,
        state.outboundCall
      );
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
    if (speakLine("goodbye", buildSilenceGoodbye(state.config, state.outboundCall))) {
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
      // ONLY WHEN IT ASKS FOR A REPLY, and the latch's own reason is why. It
      // exists because "a note provokes a model turn, and a model turn can
      // provoke a note" -- an appended note provokes neither, so spending the
      // turn's single SPEAKING slot on one buys nothing and costs whatever
      // would have spoken next.
      //
      // That cost was about to become real. The claim note runs FIRST in
      // auditTurn's priority order, so a silent claim note would have disarmed
      // the promise, deferral, unusable-transcript and zero-text notes on the
      // same turn while saying nothing itself. It also feeds noteSentPrevTurn,
      // which is the entire population of live_apology_after_note -- a note
      // that provokes no turn cannot produce a downstream apology, and counting
      // it would inflate the LVX98 numerator with turns that could not have
      // contributed to it.
      //
      // This deliberately also changes the spelling note and the write-retry
      // note, both of which burn the slot silently today. Same argument, and
      // taking it for one note and not the others would be an accident.
      //
      // notesThisCall stays unconditional: MAX_NOTES_PER_CALL bounds how much
      // synthetic user content we inject, and a silent note is still injected.
      if (requestReply) noteSentThisTurn = true;
      notesThisCall += 1;
      log.info("live_turn_note", { callSid, kind, sent: notesThisCall, spoken: requestReply });
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
  /**
   * The tail of every transcript write, so a post-call reader can wait for it.
   *
   * persistTranscriptRows is fire-and-forget by design -- a turn must not block
   * on a database round trip to say the next sentence. But finish() runs while
   * the LAST turn's rows are still in flight, and the last turn is where the
   * agreement and the claim live. A recovery that reads then sees a transcript
   * missing exactly the turns it needs, and declines `no_transcript` for a
   * reason that is not true.
   *
   * server.js already documents this race for the Twilio status callback. At
   * teardown it is strictly worse: nothing else is keeping the call alive, so
   * there is no incidental delay to hide behind.
   */
  let transcriptSettled = Promise.resolve();

  function persistTranscriptRows(rows) {
    const written = database
      .withTenantSafe(
        state.businessId,
        async () => {
          for (const [speaker, message, sequence] of rows) {
            await database.addTranscriptEntry(state.dbCallId, speaker, message, sequence);
          }
        },
        { operation: "addTranscriptEntry", callSid }
      )
      .then(() => {
        bumpCounterBy("live_transcript_written", rows.length);
        return true;
      })
      .catch((err) => {
        bumpCounter("live_transcript_write_failed");
        log.error("live_transcript_write_failed", {
          callSid,
          rows: rows.length,
          reason: err?.message,
          severity: "warn",
        });
        return false;
      });
    // Chained, not raced: the rows carry a sequence and the reader orders by it,
    // so a later turn resolving first would be fine for ordering but would let
    // finish() proceed while an earlier write is still open. `written` already
    // swallows its own rejection above, so this never rejects and never needs a
    // catch of its own -- a failed write must not wedge the teardown.
    transcriptSettled = transcriptSettled.then(() => written);
    // Resolves true once the rows are written, false if the write failed
    // (never rejects). Only the S4-2 hold-STT path reads it.
    return written;
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
    const written = persistTranscriptRows(rows);
    transcriptTurnsWritten += 1;
    // null when nothing was queued (above); else the write's own settle.
    return written;
  }

  /**
   * Final wave W1 (A26). The rows of a model turn that is being flushed
   * WITHOUT its own close -- the new-caller-turn flush in onMediaFrame. The
   * same heard gate as the turnComplete/interrupted sites: the caller half
   * always, the AI half only when nothing of the still-open generation was
   * discarded; an unheard reply is also cleared before the fold (A22). The
   * write latch is re-armed afterwards: the flush starts a NEW turn, and the
   * next close must be able to write that turn's own rows.
   */
  function persistOpenTurnRows() {
    const heard = !firstLineDroppedThisGeneration();
    persistTurnTranscript(turnUserText.trim(), heard ? turnReplyText.trim() : "");
    transcriptWrittenThisTurn = false;
    if (!heard) turnReplyText = "";
  }

  /**
   * The caller-side half of auditTurn (LVX50 and its language twin), split
   * out in the final wave (W1, A24; F-R2 re-review 2 m7): gating auditTurn on
   * `heard` also dropped these counters for every turn whose REPLY was
   * discarded, though the caller's words are never stale. `notes: false`
   * (the unheard turn) counts and logs exactly as before but sends Live no
   * note -- a note mid-clip is a spoken reply the caller may not hear either.
   * The comments are auditTurn's, moved with the code.
   */
  function auditCallerTurn({ notes }) {
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
        if (notes) sendTurnNote("unusable_transcript", UNUSABLE_TRANSCRIPT_NOTE);
      }

      // THE OTHER HALF OF THE SAME BLIND SPOT. COUNT ONLY, NO NOTE, NO GATE.
      //
      // isUnusableTranscript is a script-range check and its own comment names
      // what it cannot see: "a transcript that is fluent Latin nonsense". On
      // 2026-09-12 that cost two calls -- an English caller asking to book a
      // strategy call arrived as fluent French, full Latin script, so the script
      // check passed it and the assistant answered a different call.
      //
      // Nothing is done about it here because nothing CAN be: the Live API
      // exposes no way to constrain the language of caller transcription
      // (AudioTranscriptionConfig is an empty interface; the only languageCode on
      // the session is in speechConfig, which governs the voice the model
      // SPEAKS). So this measures a rate we currently have four calls of anecdote
      // about, and nothing more.
      //
      // English sessions only. Spanish is supported, and flagging it would make
      // this a bug rather than an instrument.
      if (String(sessionLanguageCode || "").toLowerCase().startsWith("en")) {
        bumpCounter("live_caller_turn_language_checked");
        if (looksNonEnglish(turnUserText)) {
          bumpCounter("live_caller_turn_non_english");
          // Shape only. This is caller speech, and the word that triggered it
          // would be the most disclosive thing in the line.
          log.info("live_caller_turn_non_english", {
            callSid,
            step: state.step,
            chars: turnUserText.length,
          });
        }
      }
    }
  }

  function auditTurn() {
    const replyText = turnReplyText.trim();
    // turnUserText is still populated here: applyTurn() is what clears it and
    // runs AFTER this at the turnComplete site.
    debugTranscript(replyText, turnUserText.trim());
    const S = getStrings(state.config);
    // Checkpoint 2b review, I2 (Controller Ruling, OVERNIGHT). signOffRe is
    // direction-gated: the outbound-only alternation Task 17 wrote ("...for
    // your time...bye for now/take care/speak soon", and a bare end-anchored
    // "speak soon") now lives at OUTBOUND_STRINGS.signOffOutboundRe
    // (lib/voice/strings.js) and ORs in here ONLY when this call actually is
    // one -- state.outboundCall is absent on inbound, so this reduces to
    // `S.signOffRe?.test(text)` there, exactly as at 44e31ba, before Task 17.
    const armsGoodbyeExit = (text) =>
      Boolean(S.signOffRe?.test(text)) ||
      Boolean(state.outboundCall && getOutboundStrings(state.config).signOffOutboundRe?.test(text));

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
    // LVX151. The predicate is a FUNCTION now, not a bare regex: the open head
    // noun it gained needs the per-sentence question guard beside it, or "The
    // phone number the appointment is booked under?" becomes a fabrication
    // alert. `claimsCompletion` is the same narrow regex with that guard and
    // two shapes this tenant's own booking noun kept walking through -- "your
    // free STRATEGY CALL is booked", "That IS all booked".
    const claimedCompletion = Boolean(
      replyText && (S.claimsCompletion?.(replyText) ?? S.completionClaimRe?.test(replyText))
    );
    // The denominator, recorded before any branch can skip it. See claimAudit.
    claimAudit.turns_audited += 1;
    if (!replyText) claimAudit.turns_reply_empty += 1;
    if (claimedCompletion) claimAudit.claimed += 1;
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
    // LVX151: the same locale fallback now lives inside claimsCompletionWide,
    // which is built per locale from that locale's own pair. The `||` chain is
    // kept behind it for the same reason the line below it exists at all -- a
    // consumer holding an older strings table must not evaluate `undefined(...)`
    // and take the ledger down for a whole locale.
    const claimedCompletionWide = Boolean(
      replyText &&
        (S.claimsCompletionWide?.(replyText) ??
          (S.completionClaimWideRe || S.completionClaimRe)?.test(replyText))
    );

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
    // LVX127. THE CONDITION THAT ACTS IS THE ACTION-ONLY ONE.
    //
    // It used to be the any-tool condition, and that was narrow in a way nobody
    // intended: `toolsRanThisTurn()` counts every successful tool, so a READ
    // licensed a claim about a WRITE. On CA41622e81, 2026-09-12, a
    // `set_call_intent` -- pure bookkeeping, incapable of changing anything --
    // vouched for a cancellation that never happened, and the caller was told
    // three separate times that something had been done on a call whose final
    // state was booked_rows 0, changed_rows 0.
    //
    // The any-tool condition is KEPT, as a counter. Its series then stays
    // comparable with every call taken before this change, and the difference
    // between the two counters remains exactly LVX93's population. Only the
    // note moved.
    //
    // LVX93 deferred this pending one measurement, and the measurement exists
    // now: sendTurnNote allows one note per model turn across every mechanism,
    // and on the call that FOUND this the spelling nudge had already spent it,
    // so a guard made to fire correctly might still have said nothing.
    // Measured on CA41622e81 -- MAX_NOTES_PER_CALL is 8, that call sent 3, all
    // before 17:49:39, and both false claims fell on later turns where
    // noteSentThisTurn was clear. The note gets through.
    //
    // WHAT THIS DOES NOT DO, stated so nobody expects more: the caller still
    // hears the false sentence. The note arrives after it and asks for a
    // correction, which is a request and not a guarantee, and it does not make
    // the write happen. Its real value is the circularity on that call -- the
    // model CLAIMED instead of re-asking, so readBackMade stayed false, so the
    // write-order gate refused, so the booking never happened. A model that
    // corrects itself by RE-ASKING gives that gate the read-back it wanted, so
    // the write can then land.
    const unbackedByAnyTool = claimedCompletion && !toolsRanThisTurn() && !toolRanPrevTurn;
    const unbackedByAction =
      claimedCompletion && !actionToolsRanThisTurn() && !actionToolRanPrevTurn;

    if (unbackedByAnyTool) {
      claimAudit.unbacked_any += 1;
      bumpCounter("live_claim_without_action");
      log.error("live_claim_without_action", { callSid, step: state.step, severity: "warn" });
    }

    // A RESTATEMENT AT THE SIGN-OFF IS NOT A NEW CLAIM.
    //
    // CAbef3df47, production, 2026-09-12. A real booking at 22:42:06, confirmed
    // on its own turn, and then restated at the goodbye: "We have Nithin Dodla
    // booked for a strategy call on Monday, September 14th at 1 00 PM Central."
    // True in every word -- postcall_verify said ok with booked_rows 1 -- and
    // the guard told the model to retract it. The look-back is one turn, the
    // write was two turns back, and the only tool on the sign-off turn was
    // end_call, which is not an action tool.
    //
    // live_claim_without_action stayed 0 on that call, so the any-tool condition
    // would have been silent. It counted end_call and was right by accident;
    // moving the note to the action-only condition is what exposed this. Measured
    // exposure: 9 of 64 production calls end on a claim-shaped turn.
    //
    // BOTH HALVES ARE LOAD-BEARING. Exiting alone is not enough: on CA41622e81
    // the sign-off "I've gone ahead and cancelled your strategy call" was a
    // genuine lie, and every write on that call was refused -- so
    // completedToolsThisCall is empty and the guard still speaks. And it is
    // scoped to the EXIT rather than to the whole call on purpose: a call that
    // completes one action and then fabricates a different one mid-conversation
    // is still caught, which "any completed action suppresses" would have given
    // away.
    //
    // What it cannot tell apart is a call that books successfully and then
    // fabricates a CANCELLATION at the sign-off, because the claim ledger records
    // one generic kind. That is LVX118's documented limit, and it is a much
    // narrower hole than the one this closes.
    const signOffRestatement =
      (endCallArmed || exitAfterTurn) && completedToolsThisCall.size > 0;

    // A SENTENCE THAT ASKS IS NOT A SENTENCE THAT ASSERTS.
    //
    // Nine of 34 production firings were turns that also match the read-back
    // detector -- the assistant reading a proposal back and asking the caller to
    // approve it. "I have you down for one p m on September seventeenth" is a
    // phrasing LVX94 added to the claim detector because it was a genuine
    // fabrication, and a read-back uses exactly those words and then asks a
    // question. The claim detector cannot see the difference; this can.
    //
    // It reuses confirmReadBackRe rather than growing a second "is this a
    // question" list, and therefore inherits that detector's gaps -- "is it okay
    // to reschedule that?" is a read-back neither of them recognises. Held as a
    // known miss in tests/confirmReadBackRe.test.js so both symptoms point at
    // one fix.
    const readBackNotClaim = Boolean(replyText && S.confirmReadBackRe?.test(replyText));

    // READING SOMEONE THEIR EXISTING BOOKING IS A REPORT.
    //
    // Seven of 34. Rule 2 of the post-call judge's prompt, which the live guard
    // never had. These turns follow a caller-appointments LOOKUP -- a read -- so
    // nothing is in the action look-back and the guard fires on the assistant
    // correctly answering "what have I got booked?".
    const existingReport = Boolean(replyText && S.existingAppointmentReportRe?.test(replyText));

    if (unbackedByAction) {
      claimAudit.unbacked_action += 1;
      bumpCounter("live_claim_unbacked_by_action");
      log.error("live_claim_unbacked_by_action", {
        callSid,
        step: state.step,
        signoff_restatement: signOffRestatement,
        readback_not_claim: readBackNotClaim,
        existing_report: existingReport,
        severity: "warn",
      });
      // EVERY SUPPRESSION IS COUNTED, and separately, because a guard that
      // quietly declines to speak reads identically to one that never ran --
      // the trap recover_declined exists to close. The wider condition keeps
      // counting above, so the gap between it and the notes actually sent is
      // always attributable to a named reason.
      if (signOffRestatement) {
        claimAudit.suppressed_signoff += 1;
        bumpCounter("live_claim_signoff_restatement");
      } else if (readBackNotClaim) {
        claimAudit.suppressed_readback += 1;
        bumpCounter("live_claim_readback_not_claim");
      } else if (existingReport) {
        claimAudit.suppressed_existing_report += 1;
        bumpCounter("live_claim_existing_report");
      } else if (claimGuardOff) {
        // The kill switch is a DECISION to stay silent like any other, and it
        // was the one branch that left no trace at all -- so a call with the
        // guard switched off and a call the guard cleared reported the same
        // nothing.
        claimAudit.suppressed_guard_off += 1;
      } else if (
        // The RETURN VALUE, not the call. sendTurnNote declines silently when
        // the turn's note is already spent or MAX_NOTES_PER_CALL is reached, so
        // "the guard decided to speak" and "the caller's model was actually
        // told" are different facts and only one of them was ever recorded.
        sendTurnNote("claim", CLAIM_NOTE, {
          // WITHOUT ASKING IT TO SPEAK, as of 2026-09-16, and for the same
          // reason as the spelling note ~90 lines below: this note fires
          // BECAUSE the model has just spoken, so turnComplete:true forces a
          // second consecutive spoken turn with no caller word between them.
          // Measured on a real call: live_claim_unbacked_by_action ->
          // live_turn_note kind="claim" -> live_repeated_phrase, three times in
          // one call. LVX98 is the same channel -- the note produced the right
          // outcome and six escalating apologies delivered to the caller across
          // a third of the call.
          //
          // NO EXIT-AWARE EXCEPTION, which was tried and is wrong twice over.
          // `endCallArmed` leads to armExit("end_call") a few lines after
          // auditTurn returns, so a reply asked for there is cut off by the
          // hang-up it was queued behind; and `exitAfterTurn` is only ever set
          // after speakLine("goodbye") has already put our own goodbye in
          // flight. Anything the model said there would talk over it.
          // signOffRestatement above already covers the exit case that matters.
          //
          // The cost, stated plainly: if the call ends before the model's next
          // natural turn, the correction never happens and the caller leaves
          // believing something false. That is LVX97's shape and it is accepted
          // here deliberately -- the alternative was measured and it was a
          // second wrong turn on every firing, not a correction on any.
          requestReply: false,
        })
      ) {
        claimAudit.note_sent += 1;
      }
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
    //
    // b25 (checkpoint 2b review). Subtracted HERE ONLY, not from
    // `realToolCallsThisTurn` itself (see confirmIdentityCallsThisTurn's own
    // comment): a turn whose only tool call was confirm_identity has done
    // nothing a caller can perceive as the promised action, so it must still
    // trip this guard on outbound. `toolsRanThisTurn()`/the zero-text check
    // are correctly unaffected -- confirm_identity having run means the model
    // did something, which is what those two are actually asking.
    if (
      realToolCallsThisTurn - confirmIdentityCallsThisTurn <= 0 &&
      promisedAction(replyText, S.promiseRe)
    ) {
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
    // S3-1 (spec §19, S3-D1, D5). Ava placed this call, so a caller who
    // volunteers their name mid-conversation is not the "took a name down
    // wrong" risk this nudge exists for the same way an inbound caller is --
    // and the outbound conversation layer has its own confirm_identity gate
    // for who she is speaking to. skipOnOutbound throws on a typo'd name
    // instead of failing open.
    if (
      !spellingNudged &&
      !spellingSettled(state) &&
      nameSeenThisTurn &&
      !nameAlreadyOnFile &&
      !skipOnOutbound("spellingNudge", Boolean(state.outboundCall))
    ) {
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
    // Final wave W1 (A24): moved into auditCallerTurn (defined just above
    // auditTurn), unchanged, so an UNHEARD turn -- which skips auditTurn --
    // still runs these caller-side instruments; only the note is heard-only.
    auditCallerTurn({ notes: true });

    // -------------------------------------------------------------------
    // AND THE SAME QUESTION ASKED OF OURSELVES, which nothing has ever done.
    //
    // Three calls in eighteen have had the assistant answer an English
    // caller in another language, and all three were reported by a human
    // rather than by any counter here. CAdc602f, 2026-09-17, verbatim:
    //
    //   "Sí, es completamente normal. ¿En qué puedo ayudarte hoy?"
    //
    // on a session opened with language_code en-US, language_source tenant,
    // output_language_pinned TRUE. The pin governs the voice, not the words,
    // and this is what that distinction costs.
    //
    // live_caller_turn_non_english cannot see it and never could: it reads
    // the CALLER's turn, and it excludes Spanish by design because a Spanish
    // caller is legitimate. Both halves of that are correct and together they
    // leave the actual defect unwatched.
    //
    // ENGLISH-ONLY TENANTS, decided from languages_spoken rather than from
    // the session's pinned voice. A tenant configured for two languages is
    // told by services/gemini.js to follow the caller's language, so a
    // Spanish turn there is the product working. Here it is a fault.
    // -------------------------------------------------------------------
    const spokenLangs = Array.isArray(state.config?.languagesSpoken)
      ? state.config.languagesSpoken
      : [];
    const englishOnlyTenant =
      spokenLangs.length === 0 ||
      (spokenLangs.length === 1 && String(spokenLangs[0]).toLowerCase().startsWith("en"));
    if (englishOnlyTenant && replyText) {
      bumpCounter("live_assistant_turn_language_checked");
      if (replyLooksNonEnglish(replyText)) {
        bumpCounter("live_assistant_turn_non_english");
        // Shape only, like its caller-side twin. The turn itself is already
        // carried by live_debug_assistant_turn where that is enabled, and
        // this line must be readable on a deployment where it is not.
        log.error("live_assistant_turn_non_english", {
          callSid,
          step: state.step,
          chars: replyText.length,
          severity: "warn",
        });
      }
    }

    // A tool ran and the caller heard nothing. On the cascade this is a
    // fallback LINE read by TTS; here the model is the only voice, so the only
    // way to fill the silence is to ask the model to fill it.
    if (realToolCallsThisTurn && !replyText) {
      bumpCounter("live_zero_text_turns");
      log.info("live_zero_text_turn", { callSid });
      // -----------------------------------------------------------------
      // NOT WHILE THE CALL IS CLOSING. CAaef5bd82, 2026-09-17:
      //
      //   05:05:00.799  end_call        success=true
      //   05:05:01.029  live_turn_note  kind=zero_text  spoken=TRUE
      //   05:05:01.030  live_exit_armed                 <- 1 ms later
      //   05:05:02.618  live_exit_run   trigger=mark
      //
      // The model called end_call and said nothing, which is exactly what
      // this guard is for -- a tool ran and the caller heard silence, and on
      // Live the only way to fill it is to ask the model to. So it asked,
      // one millisecond before the exit armed. The model began a reply it
      // was never going to be allowed to finish and the exit cut it off
      // mid-sentence. The caller heard it start talking and get chopped.
      //
      // Neither mechanism is wrong. They must not both run on one turn, and
      // the exit is the one with the stronger claim: a model that called
      // end_call has said what it intends to say.
      //
      // The COUNTER still fires above. A silent tool turn is a fact about
      // the model's behaviour, and suppressing the record along with the
      // remedy would hide the thing rather than handle it.
      // -----------------------------------------------------------------
      if (endCallArmed || pendingExit || exitAfterTurn) {
        bumpCounter("live_zero_text_note_suppressed_exiting");
      } else {
        sendTurnNote("zero_text", ZERO_TEXT_NOTE);
      }
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

      // -------------------------------------------------------------------
      // LVX137. DID THE ASSISTANT TURN DOWN A TIME THAT IS ACTUALLY OPEN?
      //
      // CA6df19e98, 2026-09-17. One availability call all call, sixteen slots
      // verified, `read_memo_hit: 0`, `point_verified_slots: 0` -- and then:
      //
      //   "I'm sorry, 2:00 PM is not available. We do have 1:00 PM or 4:30 PM
      //    open tomorrow, September 18th."
      //
      // The diary settles it: that Friday had ZERO scheduled appointments, and
      // the tenant is open 09:00-17:00 in thirty-minute slots -- sixteen slots,
      // which is exactly what the guard recorded. 2:00 PM was in the listing
      // the model was holding, and it told the caller otherwise.
      //
      // THIS IS THE MIRROR OF EVERY WRITE GATE IN THIS SYSTEM, and the reason
      // it went unseen for so long. Those gates stop the assistant claiming a
      // booking that does not exist. Nothing stops it claiming a slot is TAKEN
      // when it is free -- and that failure leaves no row, no refusal and no
      // counter, so a caller pushed off their preferred time is invisible.
      // Every instrument here watches writes.
      //
      // A COUNTER, NOT A GATE, and the ladder is this file's own: LVX72
      // counted first, and the one time a refusal shipped on three calls'
      // evidence, call four overturned it. One call proves the class exists
      // and says nothing about the rate.
      //
      // SENTENCE BY SENTENCE, which is load bearing. The real example turns
      // one time down and offers two others in the same reply, so a
      // reply-level test would flag all three.
      //
      // Membership in verifiedSlotList() is the half that carries the meaning:
      // every member got there from an availability response's own output, so
      // a hit means the system contradicted its own record rather than that a
      // regex matched a sentence.
      // -------------------------------------------------------------------
      if (S.deniedAvailabilityRe && replyText) {
        const openSlots = runner?.guards?.verifiedSlotList?.() || [];
        if (openSlots.length) {
          for (const sentence of replyText.split(/(?<=[.!?])\s+/)) {
            if (!S.deniedAvailabilityRe.test(sentence)) continue;
            bumpCounter("availability_denial_spoken");
            // -------------------------------------------------------------
            // LVX148. AND THE CLAUSE, WHEN THE OFFER SHARES THE SENTENCE.
            //
            // The sentence split above stops alternatives offered in a LATER
            // sentence being scored as refusals. CA58bb3640, 2026-09-19, put
            // both in one:
            //
            //   "I'm sorry, 2 PM isn't available on Monday, but we do have
            //    openings at 1:30 PM or 2:30 PM."
            //   -> slots: [13:30, 14:00, 14:30]
            //
            // Three, and two of them were the times being OFFERED. The split
            // cannot reach inside a sentence, so the counter reported double on
            // the very call meant to establish the rate -- and this counter
            // exists to decide whether the underlying defect is worth a gate. A
            // number that over-reports argues for building the wrong thing.
            //
            // The contrast word is where a reply turns from what it cannot do
            // to what it can, so only clauses that still read as a denial are
            // scored. Settled against the real sentence and four others in a
            // throwaway script first: a detector settled by reading is how this
            // guard got its first defect.
            // -------------------------------------------------------------
            const deniedClauses = sentence
              .split(/\b(?:but|however|although|though)\b/i)
              .filter((clause) => S.deniedAvailabilityRe.test(clause));
            const denied = openSlots.filter((slot) =>
              deniedClauses.some((clause) => readBackMentionsSlot(clause, slot))
            );
            if (!denied.length) continue;
            // PER SLOT, not per sentence. Two open times turned down in one
            // breath is two callers' worth of wrong answer, not one.
            //
            // It is also what makes the sentence split above testable: counted
            // per sentence, scoring the whole reply at once gives the same 1
            // and the split has no test at all. scripts/corpus/sabotage.mjs
            // found that by staying green, which is the second time an
            // alternation-shaped fix here has had half of itself untested.
            bumpCounterBy("availability_denied_verified_open", denied.length);
            log.error("availability_denied_verified_open", {
              callSid,
              step: state.step,
              // Times, not caller data -- naive local to the minute, the same
              // shape verifiedSlotList already reports.
              slots: denied,
              verified_slots: openSlots.length,
              // A slot booked EARLIER IN THIS CALL is legitimately unavailable
              // afterwards, and this counter cannot tell that case apart on its
              // own. Carried so a reader can, rather than silently excluded --
              // guessing at it would be the counter quietly editing its own
              // evidence.
              writes_this_call: writesThisCall.length,
              severity: "warn",
            });
          }
        }
      }

      if (S.closingTicRe?.test(replyText)) {
        bumpCounter("live_closing_tic");
        // LVX132. The same match, kept for the whole call rather than counted
        // and dropped. This is the latch the end_call gate reads; see its
        // declaration for what "kept" costs in timing.
        askedAnythingElseThisCall = true;
        // LVX145. HOW MUCH THE CALLER HAD SAID WHEN THE QUESTION WENT OUT.
        //
        // The latch above records that the caller was ASKED and is never reset,
        // so from this instant the hang-up is permitted for the rest of the
        // call -- including before they have had any chance to answer. That is
        // CA06cadea6: asked at 17:28:08, end_call allowed at 17:28:14, line
        // down at 17:28:23, with forty milliseconds of the caller's voice in
        // between. Overwritten on every ask, so it always refers to the most
        // recent one.
        //
        // A LENGTH, not a turn count. callerTurnCount is moved by the VAD
        // closing an utterance and ticked on that 40 ms of voice -- a breath
        // moves it. This only grows when words actually arrive.
        askedAnythingElseAtCallerChars = callerSaidThisCall.length;
        // LVX157, and the same reasoning one step over: an ask is about the work
        // that stands when it is asked. Overwritten on every ask, like the line
        // above, so it always refers to the most recent one.
        askedAnythingElseAtAction = completedActionCount;
        // THE POSITIVE TWIN for the completion note. A note count on its own
        // cannot tell an instruction the model follows from one it reads and
        // ignores -- "at most once" in a prompt does not hold, and this area has
        // six failed wordings on record. Cleared as it is read, so one note can
        // be credited at most once.
        if (completionAskNoteAtAction === completedActionCount) {
          completionAskNoteAtAction = null;
          closingAudit.ask_note_honoured += 1;
          bumpCounter("live_completion_ask_note_honoured");
        }
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
      // -------------------------------------------------------------------
      // LVX157's OWN NUMBER, and it is deliberately not any of the gates'.
      //
      // `end_call_refusals` reads {no_ask: 0} on exactly the calls this item is
      // about, because on most of them end_call is ALLOWED -- the latch was
      // stale, or the refusal had been spent -- and on some of them end_call is
      // never called at all. A defect whose only counters belong to the guards
      // that miss it has no number of its own, and cannot be shown to have got
      // better or worse.
      //
      // Counted on the TURN, not the call, because that is the unit of the
      // defect: a farewell composed over a completed action with no live ask
      // behind it. Bumped before any hold or arm decision, so it says what the
      // model DID regardless of what the guards then managed to do about it.
      //
      // Unconditional on endCallRefusedThisTurn, unlike the two branches below:
      // a farewell the model spoke only because it had just been refused is
      // still a farewell the caller heard.
      // -------------------------------------------------------------------
      if (
        armsGoodbyeExit(replyText) &&
        completedActionCount > 0 &&
        !(askedAnythingElseThisCall && askedAnythingElseAtAction === completedActionCount)
      ) {
        closingAudit.signoff_without_ask += 1;
        bumpCounter("live_completion_signoff_without_ask");
        log.info("live_completion_signoff_without_ask", {
          callSid,
          step: state.step,
          actions: completedActionCount,
          askedAtAction: askedAnythingElseAtAction,
          severity: "warn",
        });
      }
      if (endCallRefusedThisTurn && !pendingExit && !endCallArmed && armsGoodbyeExit(replyText)) {
        bumpCounter("live_goodbye_suppressed_by_refusal");
        log.info("live_goodbye_suppressed_by_refusal", { callSid, step: state.step });
      }
      if (!endCallRefusedThisTurn && !pendingExit && !endCallArmed && armsGoodbyeExit(replyText)) {
        // -----------------------------------------------------------------
        // LVX146. THE OTHER DOOR, and every guard built for closing a call was
        // standing at the first one.
        //
        // CA299f23ce, 2026-09-18: book_appointment refused at 19:04:34, "That
        // is all booked. Thanks for calling Digile Media, and have a great
        // day." at 19:04:42, line down at 19:04:43, booked_rows 0, and the
        // caller never asked whether they needed anything else.
        // `end_call_refusals` read {no_ask: 0} -- nothing refused, because
        // END_CALL WAS NEVER CALLED.
        //
        // LVX132 gates the tool. LVX141 and LVX145 run at the turnComplete exit
        // branch, which only `endCallArmed` reaches, and that is set by the tool
        // too. armExit() is called from right here, inside auditTurn, before any
        // of it. So a model that simply says a farewell out loud walks past all
        // three -- and it did so on the one call where it had just been refused
        // a write and announced success anyway.
        //
        // The same question, asked at this door: is a question to the caller
        // still outstanding? Either they were never asked at all, or they were
        // asked and the transcript has not grown since. The second half is
        // LVX145's marker, and it also covers the turn that asks and signs off
        // in one breath, because the latch above was set by THIS turn and the
        // marker with it.
        //
        // HELD ONCE, NOT REFUSED. The silence ladder and the media watchdog are
        // still the backstops, so a model that says nothing further still closes
        // the call. What this buys is one turn in which the caller can answer. A
        // permanent refusal here would trade a premature hang-up for a line
        // nobody can end, which is CAaef5bd82's defect and the worse of the two.
        // -----------------------------------------------------------------
        // LVX157 adds the third way the question can still be outstanding: it
        // was asked, and answered, about work that has since been replaced.
        const askStillOutstanding =
          !askedAnythingElseThisCall ||
          askedAnythingElseAtAction !== completedActionCount ||
          (askedAnythingElseAtCallerChars >= 0 &&
            callerSaidThisCall.length === askedAnythingElseAtCallerChars);
        if (askStillOutstanding && goodbyeExitHeldAtAction !== completedActionCount) {
          goodbyeExitHeldAtAction = completedActionCount;
          bumpCounter("live_goodbye_exit_held_no_ask");
          log.info("live_goodbye_exit_held_no_ask", {
            callSid,
            step: state.step,
            everAsked: askedAnythingElseThisCall,
            askedAtAction: askedAnythingElseAtAction,
            actions: completedActionCount,
          });
        } else if (armExit("end_call")) {
          // Counted from what armExit actually DID, not from the intention to
          // call it. Bumping first made the counter claim an arming that the
          // barge check had just refused -- a counter lying about the one thing
          // it exists to report.
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
          // -----------------------------------------------------------------
          // THE DISCRIMINATOR THE CUTTER HAS AND THIS DID NOT. LVX102/LVX107.
          //
          // `inspectRepeat`'s across-turns branch requires
          // `!callerSpokeSinceLastReply`, so a caller who asks "when's my
          // appointment?" is never cut -- an answer is not a repeat. This
          // counter had no such condition, so it counted every legitimate
          // answer, and it counted every read-back the write-order gate forces
          // (a confirmation restates the date, the time and the name, which is
          // exactly what the turn before it said). It fired 25+ times in a day
          // and the number was unreadable.
          //
          // SPLIT RATHER THAN REDEFINED. `live_repeated_phrase` keeps counting
          // what it always counted, so a call from before 2026-09-10 is still
          // comparable with one after it -- LVX102 exists precisely because
          // someone reading a rise in this number would call it a regression.
          // The two halves below sum to it, and `_unprompted` is the residue:
          // the assistant restating itself while the caller has said nothing.
          //
          // This is the half that means something. `_responsive` is expected to
          // absorb nearly all of the traffic, including every gate read-back.
          // -----------------------------------------------------------------
          bumpCounter(
            callerSpokeSinceLastReply
              ? "live_repeated_phrase_responsive"
              : "live_repeated_phrase_unprompted"
          );
          // LENGTH ONLY. The sixteen-word instance was the caller's appointment
          // and phone number; logging the run itself would put caller data in
          // the log, which is LVX24 exactly.
          log.error("live_repeated_phrase", {
            callSid,
            step: state.step,
            words: longest,
            // The field a reader needs to know whether the line matters at all.
            prompted: callerSpokeSinceLastReply,
            severity: "warn",
          });
        }
      }
      recentReplies.push(replyText);
      if (recentReplies.length > REPEAT_WINDOW_TURNS) recentReplies.shift();

      // THE AGREEMENT LEDGER, recorded here because this is the only point where
      // both halves of the pair exist: `lastReplyText` is still the PREVIOUS
      // turn's reply and `turnUserText` is the caller text of the turn that just
      // completed -- exactly the pairing services/tools.js gates on. One line
      // later lastReplyText moves and the pair is gone.
      //
      // Same predicates as the gate, deliberately: a different notion of
      // "agreed" here would measure something the gate does not.
      {
        const agreedNow = isAffirmative(turnUserText.trim());
        const S2 = getStrings(state.config);
        const readBackThen = Boolean(lastReplyText && S2.confirmReadBackRe?.test(lastReplyText));
        if (agreedNow && readBackThen) {
          lastAgreement = {
            callerTurn: callerTurnCount,
            readBackKey: textFingerprint(lastReplyText),
            atMs: now(),
          };
          bumpCounter("consent_agreement_recorded");
        }
      }
      // LVX78's cutter compares against the PREVIOUS completed turn only, not
      // the window: a restatement three turns later is a different thing from
      // one the caller has not had a chance to interrupt.
      //
      // LVX120: A CANNED LINE IS NOT A REPLY THE CALLER IS ANSWERING, so a turn
      // speakLine asked for leaves this alone and the read-back underneath it
      // survives. Everything downstream reads this to answer "what was the
      // caller responding to?" -- the agreement ledger directly above, the
      // write-order gate and the LVX117 refusal through turnState -- and for a
      // nudge the honest answer is the read-back, not "I'm still here whenever
      // you're ready."
      //
      // The repeat cutter reads it too, and the collateral runs the right way:
      // it only fires while the caller has NOT spoken, so holding the read-back
      // over makes a repeated READ-BACK catchable (the shape the owner actually
      // complained about) and only stops a repeated canned nudge from counting
      // as the model restating itself, which it is not.
      if (spokenLinePending) bumpCounter("reply_held_over_spoken_line");
      else lastReplyText = replyText;
      // THE READ-BACK THAT IS STILL STANDING, kept apart from lastReplyText.
      //
      // lastReplyText is whatever the model last said, and the write-order gate
      // requires a read-back to be exactly that. So the moment the model says
      // anything else -- "could you spell your full name?" -- the read-back the
      // caller already agreed to becomes unreachable, and the agreement with it.
      // That is the collision CAf1d6447d34 lost a booking to: the spelling gate
      // asks a question, the question costs a turn, and the consent the caller
      // had just given could no longer be found.
      //
      // Keyed by FINGERPRINT rather than by a turn count, and that distinction
      // is the whole reason this is safe. services/tools.js warns against
      // widening the read-back check to a window of turns, because
      // confirmReadBackRe is action-blind and a window would let a read-back for
      // one appointment authorise a write for another. A fingerprint cannot:
      // read back something different and the key changes, so the standing
      // agreement no longer matches and the gate refuses exactly as it does now.
      if (!spokenLinePending) {
        const readBackStrings = getStrings(state.config);
        if (replyText && readBackStrings.confirmReadBackRe?.test(replyText)) {
          lastReadBackKey = textFingerprint(replyText);
          // The TEXT as well as the key, because the latch has to answer a
          // second question the fingerprint cannot: did this read-back actually
          // name the time we are about to write? See lib/voice/slotMention.js.
          lastReadBackText = replyText;
        }
      }
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
  /**
   * Is the turn now generating one this CALL asked for, rather than a reply?
   *
   * LVX120, measured on CAfc89ebd3. speakLine() makes the model say a fixed
   * line by sending it a user-role instruction, so a silence nudge arrives back
   * as an ordinary assistant turn with nothing marking it. It then became
   * `lastReplyText`, and every consumer that asks "what was the caller
   * answering?" got "I'm still here whenever you're ready."
   *
   * On that call the caller said "Yes." three times to a read-back and the
   * agreement ledger recorded NOTHING, because each yes was paired with a nudge
   * two turns after the read-back it actually answered. The write-order gate
   * refused the same booking three times for the same reason, which drove it to
   * its ceiling and released the write unconsented; the LVX117 gate then refused
   * a name correction on a call where the caller had plainly agreed; and the
   * confirmation text the assistant had promised was suppressed as
   * `write_abandoned`. One displaced variable, six consequences.
   *
   * Cleared in applyTurn rather than where it is read, so a nudge the model
   * declines to say cannot leave it set and hold over the next real reply.
   */
  let spokenLinePending = false;
  // ---------------------------------------------------------------------------
  // WHEN DID THE CALLER LAST AGREE, AND TO WHAT. Measured, never gated on.
  //
  // The write-order gate is instantaneous: it pairs the PREVIOUS reply with the
  // CURRENT caller turn (services/tools.js), so a read-back and the yes that
  // answers it have to be adjacent. Two consequences, both now observed on real
  // calls rather than argued about:
  //
  //   A silent caller turn skips the gate ENTIRELY, because the whole block is
  //   nested inside `if (lastCallerText.trim() !== "")`. The nesting is what
  //   keeps the cascade byte-identical, and on Live it means a write goes
  //   through unchecked whenever the caller's turn transcribed as nothing --
  //   which this front-end does, since the model is also the recogniser.
  //
  //   And that hole CANNOT simply be closed by requiring caller text, because a
  //   write one turn after the agreement is legitimate and succeeds today. The
  //   caller did agree; they just are not speaking at the moment the tool runs.
  //   tests/liveWritePathEndToEnd.test.js pins both cases.
  //
  // So a durable record is needed, and the reverted three-turn window
  // (services/tools.js) is what happens when such a record is not scoped to the
  // action it authorised: a booking was allowed on consent given for a
  // cancellation 55 seconds earlier.
  //
  // This records the facts and changes no outcome. The token is keyed by a
  // fingerprint of the READ-BACK THE CALLER HEARD -- not by engine state, which
  // is the trap: scoping a write to values the write is itself built from
  // compares a value to itself and cannot fail. What the caller heard is
  // independent of what we are about to write, so it can disagree.
  // ---------------------------------------------------------------------------
  /** @type {{callerTurn: number, readBackKey: string, atMs: number}|null} */
  let lastAgreement = null;
  /**
   * Fingerprint of the most recent assistant reply that read details back.
   *
   * Compared against lastAgreement.readBackKey to answer the only question the
   * latch asks: is the thing the caller agreed to still the thing on the table?
   * Equal means no new proposal has been made since the yes. Different means
   * the model has read something else back and the old agreement does not
   * reach it.
   *
   * @type {string|null}
   */
  let lastReadBackKey = null;
  /**
   * The text of that same read-back. Assistant speech, never the caller's.
   * @type {string|null}
   */
  let lastReadBackText = null;
  // The language this session resolved to. Held here because it is settled at
  // connect, inside a block auditTurn cannot see, and the wrong-language counter
  // below must only ever run against an English session -- Spanish is a supported
  // locale and its markers are deliberately absent from the check.
  let sessionLanguageCode = null;
  let callerSpokeSinceLastReply = false;
  /**
   * LVX30's latch. A local, not a field on `state` -- see the write site.
   * Whether the caller has ever produced a non-echoed final on this call.
   */
  let sawCallerFinal = false;
  let repeatCutsThisCall = 0;
  /**
   * The configured opening line, memoized for the call.
   *
   * THE CONFIGURED TEXT, NOT THE FIRST TURN THE MODEL SPOKE, and the first
   * attempt at this got it wrong in a way two existing tests caught
   * immediately. Keying on "the first completed assistant turn" means every
   * later restatement of that turn is treated as a re-greet -- which swallowed
   * ordinary repeats the general cutter should handle, and worse, cut a repeat
   * the caller had explicitly asked for. That last one is the single false
   * positive LVX78 was designed around.
   *
   * The configured line cannot make that mistake: an arbitrary first turn does
   * not share ten words with it. The cost is that a re-greet the model has
   * heavily paraphrased will not match, which is the right way round -- this
   * branch cuts audio, so it should fire only on the case actually observed:
   * the opening line repeated verbatim.
   *
   * `null` means "not computed yet"; `""` means "no greeting configured".
   */
  let configuredOpening = null;
  let greetingEchoCuts = 0;
  /** Reset every turn: a turn may be cut at most once. */
  let repeatCutThisTurn = false;
  /** LVX80. Same shape as the repeat cutter's pair, same reasons. */
  let offerCutsThisCall = 0;
  let offerHandledThisTurn = false;
  /**
   * LVX132. Has the assistant ever asked this caller whether they need
   * anything else?
   *
   * WHEN IT IS WRITTEN, because that is the whole of this item. It is set in
   * auditTurn, which runs at turnComplete -- AFTER the tool round. So it is
   * readable from the NEXT turn onward and is false during the turn on which
   * the question is actually asked. That covers the defect measured on ten
   * calls (asked on an earlier turn, or never asked at all) and misses exactly
   * one shape: asked and hung up in the same breath.
   *
   * turnState() covers that shape separately by testing the turn's reply text
   * as it stands at tool time, which is the one moment it exists -- applyTurn()
   * clears it a few lines later, and a guard written to read it after that
   * clear is the most-repeated defect in this file.
   *
   * Never reset. A caller asked once has been asked -- of the work that
   * existed when they were asked. See askedAnythingElseAtAction below: the
   * latch itself still only goes up, but what it is allowed to cover does not
   * extend past the next completed write.
   */
  let askedAnythingElseThisCall = false;
  /**
   * LVX157. HOW MUCH HAD BEEN WRITTEN WHEN THE QUESTION WENT OUT.
   *
   * The latch above answered "was this caller ever asked" and that turned out
   * to be the wrong question. CA0ef8d221:
   *
   *   15:53:04  "I don't see any upcoming appointments ... Is there anything
   *              else I can assist you with today?"     <- latch set, 0 writes
   *   15:55:37  book_appointment  success
   *   15:55:39  end_call          success               <- ALLOWED
   *   15:55:46  "I have successfully booked your strategy call ... Thank you
   *              for calling Digile Media, and have a wonderful day."
   *
   * `end_call_refusals` read {no_ask: 0}. The gate was satisfied by a question
   * asked about an empty diary, two and a half minutes before the booking it
   * ended up covering. CA58bb3640 is the same shape with a cancel in front.
   *
   * An ask is therefore scoped to the action count it was asked at. This is
   * the same move LVX145 made with `askedAnythingElseAtCallerChars` -- an ask
   * the caller has not answered yet does not count -- applied to the other way
   * the question can go stale: the work changed underneath it.
   *
   * -1 means never asked, matching its sibling, so the two read alike.
   */
  let askedAnythingElseAtAction = -1;
  /**
   * LVX157. Completed caller-visible writes so far, mirrored from the tool
   * runner, which is where the count is actually kept.
   *
   * MIRRORED RATHER THAN RECOMPUTED. This file already walks functionResponses
   * for ACTION_TOOL_NAMES and could count them itself, and that second tally is
   * exactly how `actionToolsRanThisTurn` came to disagree with the runner about
   * whether a write had happened (LVX140). One counter, read from the file that
   * owns it.
   */
  let completedActionCount = 0;
  /**
   * LVX157. The action count the last completion note was attached at, or null.
   *
   * Read once, by the positive twin in auditTurn. A note that goes out and an
   * ask that follows it are only the same event if no further write has landed
   * in between.
   */
  let completionAskNoteAtAction = null;
  /**
   * LVX141. WAS THE ASK THAT LET THIS HANG-UP THROUGH ONLY IN THE TURN THAT IS
   * CLOSING?
   *
   * CA94f2b4, production, 2026-09-18:
   *
   *   01:56:22  end_call  success=TRUE
   *   01:56:30  A: "...updated to Monday, September 21st at 1 PM. Is there
   *                 anything else I can help you with today?Thank you for
   *                 calling Digile Media, and have a great day."
   *
   * Asked and signed off in one breath, then hung up. The caller never answered.
   *
   * THE SEAM IS BETWEEN TWO GUARDS, and each behaved exactly as written.
   * LVX132's ask gate asks "was a question asked ANYWHERE?" and the in-turn half
   * of `turnState().askedAnythingElse` saw one, so `end_call_refusals.no_ask`
   * read 0. `live_exit_held_question` asks "does the reply END with one?" and
   * this reply ends with the farewell. A turn that asks mid-sentence and then
   * signs off satisfies the first and evades the second.
   *
   * The distinction the code already had and was not using: an ask carried ONLY
   * by the in-turn read is definitionally one the caller has not answered,
   * because the turn carrying it has not finished. `askedAnythingElseThisCall`
   * is written in auditTurn at turnComplete, so when it is still false at
   * end_call time, every ask this call contains is in the sentence now being
   * spoken.
   *
   * NOT A NEW PHRASE LIST, and not a second refusal either: the hang-up is
   * still ALLOWED. It is queued behind one more turn through the hold that
   * already exists, so the caller gets the beat in which to answer.
   */
  let endCallAskWasInTurnOnly = false;
  /**
   * LVX145. THE ASK WENT OUT AND THE CALLER HAS NOT SPOKEN SINCE.
   *
   * The third closing shape, and the one neither existing guard can see:
   *
   *   never asked at all                      -> LVX132's ask gate
   *   asked only in the turn that is closing  -> LVX141, above
   *   asked LAST turn, caller silent, hang up -> this
   *
   * LVX132 asks whether the question was ASKED. It never asks whether it was
   * ANSWERED, and its latch is permanent, so a model that asks and hangs up six
   * seconds later passes every check. `askedAnythingElseAtCallerChars` is the
   * length of the accumulated caller transcript at the moment the question went
   * out; if it has not grown by the time end_call arrives, nothing has come back.
   *
   * SAFE UNDER TRANSCRIPT LAG, which is why it is a length rather than a flag:
   * a caller who HAS answered but whose words have not landed yet also reads as
   * silent, and the cost of that is one held turn. The failure mode is a pause,
   * not a dropped line.
   *
   * -1 means never asked, which is LVX132's business and not this one.
   */
  let askedAnythingElseAtCallerChars = -1;
  let endCallAskUnanswered = false;
  /**
   * LVX146's one-shot. The sign-off detector may hold the exit once for a
   * question the caller has not answered; after that the farewell closes the
   * call as it always did, and the silence ladder and the media watchdog remain
   * the backstops underneath both.
   *
   * LVX157 scopes it the same way the end_call refusal is scoped: the action
   * count it was spent at, or null for never. A hold spent on one piece of work
   * should not leave the back door unlocked for the next, which is the mirror
   * of the CA84dc64 defect at the door LVX146 was built to cover. Still at most
   * one hold per completed action, so it cannot become a line nobody can end --
   * the failure this one-shot exists to prevent, and CAaef5bd82's.
   */
  let goodbyeExitHeldAtAction = null;
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
    // LVX132. Has this caller been asked whether they need anything else?
    //
    // TWO SOURCES, BECAUSE ONE CANNOT COVER BOTH TURNS, and the whole item is
    // about which of them is written before this is read:
    //
    //   - the latch is set in auditTurn at turnComplete, so it answers for
    //     every turn BEFORE this one;
    //   - the second half tests the reply as it stands RIGHT NOW. On Live the
    //     model composes its speech and its tool call together and the tool
    //     runs first, so this is usually empty -- but when the model speaks
    //     first it is not, and this is the only point in the turn where that
    //     text exists. applyTurn() clears turnReplyText a few lines after the
    //     tool round, and a guard reading it after that clear is present,
    //     plausible and silently dead. That has happened here before.
    //
    // Both halves are sabotaged separately in scripts/corpus/sabotage.mjs: an
    // alternation where only one branch is broken proves nothing if the other
    // still carries the cases.
    // LVX157. The latch half now has to be about THIS work. `askedAtAction`
    // trails `completedActionCount` exactly when a write has landed since the
    // caller was last asked anything, which is the CA0ef8d221 shape -- asked
    // with an empty diary, booked, gone. The in-turn half is untouched: a
    // question being asked right now is about right now by construction.
    askedAnythingElse:
      (askedAnythingElseThisCall && askedAnythingElseAtAction === completedActionCount) ||
      Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")),
    // -------------------------------------------------------------------
    // LVX163. THE SAME FACTS, UNRESOLVED, BECAUSE THIS FILE'S COUNT IS STALE
    // INSIDE A TOOL ROUND.
    //
    // `completedActionCount` here is MIRRORED from the runner and is only
    // written when the round returns. So a batch containing both the write and
    // the hang-up is judged against the count as it stood BEFORE the write --
    // and the line above then reads an ask made at action 0 as still fresh.
    //
    // CA1dfe055f, 2026-09-20:
    //
    //   06:47:33  "...Is there anything else I can help you with today?"  <- 0 actions
    //   06:49:03.326  book_appointment  SUCCESS
    //   06:49:03.330  end_call          ALLOWED, 4 ms later, same batch
    //   06:49:08  "That's all set, and your appointment is booked..."     <- no ask
    //
    // `end_call_refusals` read {no_ask: 0} on the exact shape LVX157 was built
    // for, because the two arrived together. The code comment at Layer A calls
    // this "Layer B's case"; Layer B could not see it either.
    //
    // So the two raw facts go out UNCOMBINED and lib/voice/live/tools.js does
    // the comparison against its own count, which is correct mid-round. The
    // resolved field above stays for the cascade, which supplies neither of
    // these and whose gate no-ops anyway.
    // -------------------------------------------------------------------
    askedAnythingElseEver: askedAnythingElseThisCall,
    askedAnythingElseAtAction,
    askedAnythingElseInTurn: Boolean(
      getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")
    ),
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
    assistantSaidThisCall,
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
    // MEASUREMENT ONLY. See lastAgreement's declaration: services/tools.js logs
    // these beside the decision it already makes and changes nothing on the
    // strength of them, so a rule can be checked against real calls before any
    // write depends on it.
    lastAgreementReadBackKey: lastAgreement?.readBackKey ?? null,
    // NOT measurement. The write-order gate reads these to decide, which is
    // the difference between them and the field above.
    lastReadBackKey,
    lastReadBackText,
    callerTurnsSinceAgreement:
      lastAgreement == null ? null : Math.max(0, callerTurnCount - lastAgreement.callerTurn),
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
        // OUTBOUND CALLING, Task 18 (spec §9.6). null on inbound and on every
        // call before the runner exists -- capabilities/*.js's partyOf(ctx)
        // then falls back to callerNumber above, verified true, exactly as
        // before this field existed. On outbound, the CURRENT verification
        // state: read off the runner rather than duplicated into `state`,
        // because the runner (lib/voice/live/tools.js) is the one place
        // confirm_identity's result actually lands.
        party: runner ? runner.party : null,
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
  function clearAudio(atMs, { fadeMs = 120, barge = false, allowClipClear = false } = {}) {
    // OUTBOUND CALLING (S3-2 fix round 2, item 4). EVERY caller of this
    // function routes through here -- the local barge, the vendor's
    // `interrupted`, and the four TEXT-triggered cutters (greeting-respoken,
    // repeat-cut, offer-unverified, the leak guard). All four judge Live's
    // OWN output transcription, which can belong to a generation whose audio
    // is being discarded while our outbound clip is still on the wire (the
    // cut-window check, `aiAudioPlayingUntil`, counts the clip same as any
    // other assistant audio) -- none of them are judging the CLIP, so none
    // of them may clear it. Only our own barge rule (clipBarge) may, and it
    // says so explicitly (`allowClipClear`). Two callers already skip this
    // function entirely while the clip plays (the local barge path and the
    // vendor `interrupted` handler); this is the backstop for the rest,
    // placed here rather than at each anchored call site so none of them
    // has to change (scripts/corpus/sabotage.mjs's census anchors some of
    // those lines).
    //
    // Return value (S3-2 fix round 3, NB4): true when this call actually
    // cleared something, false when the clip-protection guard silently
    // no-op'd. The four text-triggered cutters use it so their OWN "cut"
    // logging, counters and per-call budgets stay honest -- none of them may
    // claim a cut the clip protection just prevented.
    if (dialFirstSeconds?.clipPlaying?.() && !allowClipClear) return false;
    // fadeMs 0 is a HARD clear, and the difference matters. A tapered clear
    // drops only what audioOut still holds locally and lets Twilio finish
    // playing what it already has; a hard clear also sends Twilio a `clear`
    // event, which discards its buffer too. A barge wants the taper -- it
    // sounds like ducking rather than a cut. A leak wants the hard stop,
    // because the audio Twilio is holding is exactly what must not be heard.
    audioOut?.clear(fadeMs > 0 ? { fadeMs } : {});
    echoGuard.noteAudioStopped(atMs);
    // OUTBOUND CALLING (spec §9.3 step 4). The clear took the backstop's end
    // mark with the queue, so it will never echo: lift the seeded-audio
    // suppression here or Live stays muted for the rest of the call. Every
    // clear passes through this function -- the local barge, the vendor's
    // `interrupted`, the leak and repeat cutters -- so one line covers all.
    dialFirstSeconds?.onAudioCleared();
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
    return true;
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

  /**
   * The number a transfer would dial, or null.
   *
   * OUTBOUND CALLING (spec §9.7, Task 19): the campaign's own `transfer.to`
   * (state.outboundCall.config), never the tenant's transferPhoneNumber --
   * that field describes a completely different scenario (an INBOUND caller
   * asking for a person) and is not even guaranteed to exist for a business a
   * campaign calls out to. Inbound is unchanged: state.outboundCall is absent
   * there.
   */
  function transferNumber() {
    if (state.outboundCall) return state.outboundCall.config?.transfer?.to || null;
    return state.config?.transferPhoneNumber || process.env.TRANSFER_NUMBER || null;
  }

  /**
   * Whether this business can be transferred to right now.
   *
   * BOTH halves, as the cascade has it (`canTransfer = !!transferNumber &&
   * resolveTransferAllowed`). Policy alone says only that a transfer is
   * permitted; without a number there is nothing to dial, and the model would
   * promise one, succeed, and disconnect the caller mid-promise.
   *
   * OUTBOUND CALLING (spec §9.7, Task 19): the tenant's transfer_policy
   * (never / always / business_hours_only) describes the INBOUND scenario and
   * plays no part here -- the campaign's own `transfer.when` is the only rule,
   * evaluated in the BUSINESS timezone (the transfer target is the business's
   * own staff, not the contact). `request_transfer`'s existing refusal
   * ("Transfer is not available right now. Offer to take a message instead.",
   * capabilities/transfer.js) is what the caller hears outside the window --
   * this function is read fresh on every tool call via turnState(), so a
   * window that closes mid-call takes effect on the very next attempt.
   */
  function transferAllowed() {
    if (state.outboundCall) {
      return (
        Boolean(transferNumber()) &&
        isInsideTransferWindow(new Date(), state.outboundCall.config?.transfer?.when, state.config?.timezone)
      );
    }
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
    // LVX120, and cleared HERE rather than where auditTurn reads it, for the
    // reason every other latch in this function is: the model does not always
    // say the line it was asked to. A nudge it declines produces no replyText,
    // auditTurn's reply branch never runs, and a latch cleared only in there
    // would stay set and hold over the NEXT real reply -- turning a one-turn
    // hold into a permanent one. applyTurn runs on every turn, empty or not.
    spokenLinePending = false;
    // Before the early return below, not after: a turn with nothing to fold
    // still ends, and a guard left armed from it would stay armed for the
    // next one.
    leakHandledThisTurn = false;
    offerHandledThisTurn = false;
    // The read memo is per TURN, and this is where a turn ends. Optional-chained
    // because `runner` is null until start() has finished three awaits, and
    // applyTurn is reachable from the media-frame path before then.
    runner?.guards?.resetTurn?.();
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
    confirmIdentityCallsThisTurn = 0;
    actionToolSucceededThisTurn = false;
    calledToolsThisTurn.clear();
    refusedActionCallsThisTurn = 0;
    refusedCallsThisTurn = 0;
    // THE TURN HAS ROLLED. Advanced here and nowhere else, immediately after
    // the look-back is written from it, so a tool round still in flight can
    // tell that its turn is now the previous one. LVX140.
    turnSeq += 1;
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
    // ONCE PER TURN. On a real call this fired three times in 173 milliseconds
    // on a single turn and burned the whole call's cap, leaving everything after
    // it unprotected. Once a cut is made the following fragments still match the
    // head, so without this it keeps firing. The leak guard has had
    // leakHandledThisTurn for the same reason since it was written.
    if (repeatCutThisTurn) return;

    // -----------------------------------------------------------------------
    // THE OPENING GREETING, SPOKEN AGAIN MID-CALL. 2026-09-10.
    //
    // A caller heard the entire greeting, verbatim, spliced onto the end of an
    // ordinary sentence with no space between them:
    //
    //   "I can help with that. What day were you thinking of?Thanks for calling
    //    Brightwork Studio. You're through to our AI receptionist. How can I
    //    help you today?"
    //
    // Nothing in this file re-sent it. The greeting is not sent as a turn at
    // all -- the kick-off message is content-free and the opening line is
    // written into the SYSTEM INSTRUCTION (services/gemini.js, the
    // `greetingSpoken === false` branch). That prompt is frozen at connect
    // (LVX46) and, until today, said "Nothing has been said to the caller yet.
    // Open the call by saying this..." in the present tense for the entire
    // call. The model re-anchored on an instruction that still read as
    // outstanding. Same splice shape as LVX96's pre-written sign-off.
    //
    // The prompt is now reworded to be first-turn-only. THIS IS THE HALF THAT
    // MAKES IT A FACT: a cap written in a prompt is a request, and the standing
    // lesson on this system is that "at most once" in a prompt does not hold.
    //
    // Checked BEFORE the MAX_REPEAT_CUTS budget on purpose -- see
    // MAX_GREETING_ECHO_CUTS. It is also outside the across-turns/within-turn
    // split below because neither can see it: the caller has just spoken (so
    // the across-turns branch is disarmed by design), and the greeting shares
    // no long run with the earlier half of the same turn.
    // -----------------------------------------------------------------------
    const soFarWithGreeting = `${turnReplyText}${fragment}`;
    if (configuredOpening === null) {
      // Checkpoint 2b review, b9. state.config is the TENANT's inbound
      // config on every call, outbound included (the campaign's own config
      // lives on state.outboundCall, never here) -- so without this,
      // configuredOpening would hold the INBOUND greeting on an outbound
      // call, and any of Ava's outbound turns sharing a ten-word run with it
      // (the business name, "AI receptionist"/"AI assistant", "how can I
      // help") would be cut as if it were an echoed greeting nobody sent.
      // There is no outbound greeting for this branch to protect: the
      // opener is the pre-rendered backstop clip (lib/outbound/firstSeconds.js),
      // seeded as Live's own turn already, never re-sent as a fresh one.
      if (state.outboundCall) {
        configuredOpening = "";
      } else {
        try {
          // WITHOUT THE RECORDING DISCLOSURE, deliberately. greetingTextFor
          // prepends it when the tenant has it enabled, and it is the one part of
          // the opening the assistant may have to say again for a good reason --
          // a caller asking "are you recording this?" gets it verbatim, and on a
          // tenant with a long disclosure that alone clears ten words. Cutting a
          // straight answer to a question about recording would be a worse defect
          // than the re-greet, and on the disclosure of all things.
          configuredOpening = state.config
            ? greetingTextFor({ ...state.config, recordingDisclosureEnabled: false }) || ""
            : "";
        } catch {
          configuredOpening = "";
        }
      }
    }
    if (
      configuredOpening &&
      // Not the real greeting. The inverse of the veto further down: that one
      // protects the opening line while it is being spoken for the first time,
      // and this one only ever looks at turns after it.
      (callerTurnCount || lastReplyText) &&
      longestSharedRun(configuredOpening, soFarWithGreeting) >= GREETING_ECHO_RUN_WORDS
    ) {
      repeatCutThisTurn = true;
      bumpCounter("live_greeting_respoken");
      if (greetingEchoCuts < MAX_GREETING_ECHO_CUTS) {
        // NB4 (fix round 3): clearAudio no-ops, silently, while the outbound
        // clip protects itself -- nothing was cut, so the budget spend, the
        // cut counter and the log below must not claim otherwise. Its own
        // return value says which happened.
        if (clearAudio(atMs)) {
          greetingEchoCuts += 1;
          bumpCounter("live_greeting_respoken_cut");
          // Length only, never the text: the opening line carries the business
          // name and, for a tenant with the disclosure enabled, its recording
          // wording. LVX24.
          log.error("live_greeting_respoken", {
            callSid,
            step: state.step,
            chars: soFarWithGreeting.length,
            cuts: greetingEchoCuts,
            severity: "warn",
          });
        }
      }
      return;
    }

    if (repeatCutsThisCall >= MAX_REPEAT_CUTS) return;

    bumpCounter("live_repeat_cut_checked");
    const soFar = soFarWithGreeting;

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
    // TAPERED, unlike the leak guard's hard stop. A leak must not be heard at
    // all, so it takes Twilio's buffer with it; a repeat is merely unwanted, and
    // a hard clear in the middle of ordinary speech sounds like the line
    // dropping rather than like the assistant stopping.
    //
    // NB4 (fix round 3): same reasoning as the greeting cutter above -- only
    // count, log and spend the per-call budget on a cut that actually
    // happened; clearAudio's own return says whether the clip protected it.
    if (clearAudio(atMs)) {
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
    }
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
    const wouldCut = cutWindowMs > 0 && !offerCutOff && offerCutsThisCall < MAX_OFFER_CUTS;
    // HARD, not tapered, on clearAudio's own reasoning: a tapered clear lets
    // Twilio finish playing the ~100 ms it already holds. A time nothing has
    // checked is the leak's category, not the repeat's -- the audio Twilio is
    // holding is exactly what must not be heard.
    //
    // NB4 (fix round 3): clearAudio itself decides whether the outbound clip
    // protects the audio, so `cut` -- what gets logged, counted and spent --
    // is what it ACTUALLY did, not merely what the window said it should do.
    const cut = wouldCut && clearAudio(atMs, { fadeMs: 0 });
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

    if (cut) offerCutsThisCall += 1;

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
    const wouldCut = cutWindowMs > 0;
    // NB4 (fix round 3): same reasoning as the offer guard above -- `cut` is
    // what clearAudio actually did (it no-ops while the outbound clip
    // protects itself), not merely what the window said it should do.
    const cut = wouldCut && clearAudio(atMs, { fadeMs: 0 });
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
    // THE SPELLING QUESTION WAS ANSWERED, whatever the transcript managed to
    // carry. On call CA9e3788 the caller spelled their name into 2,180 ms of
    // audio that transcribed to zero characters, and the gate's escape hatch --
    // which reads the transcript -- could not advance, so the booking was
    // refused forever. The audio is the signal that does not come back empty.
    //
    // Here rather than in the inputTranscription handler on purpose: that
    // handler does not run at all when the vendor sends no transcript, which is
    // exactly the case this exists for. Idempotent per question.
    const voicedMs = u.voicedFrames * 20;
    if (state.spellAskPending && voicedMs >= voicedAnswerMs()) {
      bumpCounter("spelling_voiced_answer_counted");
      log.info("spelling_voiced_answer", { callSid, utterance: u.id, voiced_ms: voicedMs });
    }
    applyCallerVoicedAnswer(state, voicedMs);
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
    // LVX131. FIRST, before anything can throw or return: the watchdog's only
    // input. Everything below it is conditional on VAD, on the half-duplex
    // gate, or on a strategy's verdict; liveness is not.
    if (lastMediaAt != null) {
      const gap = atMs - lastMediaAt;
      if (gap > mediaGapMaxMs) mediaGapMaxMs = gap;
    }
    lastMediaAt = atMs;

    const v = vad.processFrame(mulawFrame, atMs);
    if (v.voiced) lastVoicedMs = atMs;

    // Moved above the dialFirstSeconds block (S3-2): the controller's own
    // clip-barge threshold needs this SAME sustained-run length the ordinary
    // barge gate below computes, and it only depends on `vad`'s state from
    // processFrame just above -- not on `playing` or the gate, so hoisting it
    // changes nothing about what either of those sees.
    const voicedRunMs = vad.voicedRunMs(atMs);
    /** A4: set when the clip barge acted on this frame (outbound only). */
    let clipBargedThisFrame = false;

    // OUTBOUND CALLING (spec §9.3). Twilio's 20 ms frames are the controller's
    // clock -- not audioOut's pump, which stops when its queue is empty and so
    // could never fire the silence backstop. The ungated VAD verdict: speech
    // onset counts whether or not the gate forwards the frame. Before
    // isPlaying() below, so a backstop queued on this frame is already
    // "playing" for the barge gate. voiceActive is the VAD's sustained flag:
    // onset is confirmed speech, not one loud frame (O-6).
    if (dialFirstSeconds) {
      // N1 fix (checkpoint-A re-review): checked BEFORE anything else runs,
      // so a clipPlaying() -> false transition caused by firstSeconds.js's
      // OWN onModelAudio (its own M9 check, between this and the last media
      // frame -- nothing in onMediaFrame would otherwise ever see it) still
      // releases the hold, on the very next frame.
      maybeReleaseClipHold("clip_ended_pre_frame");
      // S3-2: onCallerFrame now also decides the CLIP's own barge threshold
      // (CLIP_BARGE_MIN_MS, higher than the ordinary 300 ms) -- the
      // controller only recommends (`clipBarge`); this is what acts on it,
      // the same way any other barge does (clearAudio + signal "start"),
      // which itself calls dialFirstSeconds.onAudioCleared and re-arms the
      // first-turn check (I1, unchanged).
      const { clipBarge } = dialFirstSeconds.onCallerFrame({ voiced: v.voiced, voiceActive: v.voiceActive, atMs, voicedRunMs });
      dialFirstSeconds.tick(atMs);
      // N1 fix: the same check again, for a transition tick() ITSELF just
      // caused (M9 via checkClipPlayingTimeout) -- or the ordinary mark-echo
      // path, though that one already released via the seed callback below
      // and this is then a no-op (releaseClipHold is idempotent).
      maybeReleaseClipHold("clip_ended");
      if (clipBarge) {
        // Unconditional, NOT maybeReleaseClipHold: a barge abandons the seed
        // for this clip for good (giveUpOnSeed), right now, before
        // clearAudio has actually cleared it -- clipPlaying() still reads
        // true for one more instant, so the guarded helper would wrongly
        // no-op here.
        releaseClipHold("barge");
        summary.recordBarge();
        // allowClipClear: this IS the one barge rule allowed to clear the
        // clip (S3-2 fix round 2, item 4's own exception).
        clearAudio(atMs, { barge: true, allowClipClear: true });
        signal("start");
        clipBargedThisFrame = true;
      }
    }
    // 2026-10-01, live mode: the same 20 ms frame clock drives the Hello cue,
    // the unresponsive deadline and the hold. voiceActive (sustained) is what
    // counts as speech; raw voiced dates its end (ruling R10).
    if (liveFirstLine) {
      // Final review #2: our own audio coming back down the line (no echo
      // cancellation here) is not the person -- while it plays, nothing is
      // counted as their speech, by the controller or the early-audio net.
      const ownAudioPlaying = isPlaying();
      liveFirstLine.onCallerFrame(atMs, v.voiced && !ownAudioPlaying, v.voiceActive && !ownAudioPlaying);
      liveFirstLine.tick(atMs);
      bufferEarlyCallerAudio(mulawFrame, v.voiced && !ownAudioPlaying);
    }

    const playing = isPlaying();
    summary.recordInbound({ rms: v.rms, playing });

    // The ungated verdict, not the gated one below: a caller talking over us
    // has not gone quiet, whether or not we forward the frame to the model.
    checkSilence(atMs, v.voiced, playing);

    // Recorded in every arm, acted on only where the gate opens. It is what
    // tells a genuine interruption from the vendor cutting itself off on our
    // own output -- two things that look identical in an `interrupted` alone.
    if (playing && v.voiceActive && voicedRunMs >= 300) lastBargeAt = atMs;

    // C1 (checkpoint-A review): while the OPENER CLIP's own audio is on the
    // wire, `gate` (halfDuplex.js, above) is bypassed entirely for outbound
    // -- its 500 ms ring is sized for Live's own short reply and drops a
    // caller's whole utterance long before a multi-second clip finishes.
    // routeClipFrame captures/delays the frame instead (F-R2: split between
    // the delay line and the hold -- see its own block comment above `gate`
    // for the full design). Both v.voiced and v.voiceActive now (fix round
    // 2, NB2): a provisional latch on raw voiced, confirmed by a COUNT of
    // voiced frames within a window, not voiceActive's own consecutive rule.
    let forward, barge, held, dropped, released;
    if (dialFirstSeconds?.clipPlaying?.()) {
      routeClipFrame(mulawFrame, v.voiced, v.voiceActive, atMs);
      forward = [];
      barge = false;
      held = 1;
      dropped = 0;
      released = 0;
    } else if (clipTailBypassActive()) {
      // Final wave W1 (A5, checkpoint-A re-review N4): the clip ended (its
      // hold already released) but isPlaying() still reads true for the
      // clip's own tail + grace. Through the half-duplex gate, a short run of
      // caller speech crossing the end mark (~100-180 ms: enough to lose a
      // "not") sat in an EMPTY ring and was dropped as echo. Forwarded
      // directly instead, until the clip's audio is truly off the wire or
      // Live's own audio starts (then the ordinary gate applies again).
      forward = [mulawFrame];
      barge = false;
      held = 0;
      dropped = 0;
      released = 0;
    } else {
      ({ forward, barge, held, dropped, released } = gate.push({
        frame: mulawFrame,
        playing,
        // LVX70: the gate needs the VAD's per-frame verdict, not only the run
        // length, so it can tell speech it withheld from silence it withheld.
        voiced: v.voiced,
        isActive: v.voiceActive,
        voicedRunMs,
      }));
      // Final wave W1 (A4, checkpoint-A re-review N3): the clip barge above
      // already cleared the audio, recorded the barge and opened the turn on
      // THIS frame; the gate sees the same >= 600 ms run with isPlaying()
      // still true and would do all three again. Forwarding is unaffected.
      if (clipBargedThisFrame) barge = false;
    }
    if (released > 0) bumpCounter("live_gate_speech_released");

    // LVX70. Runs on every frame, changes nothing, and is the only place that
    // records what the gate did with the caller's audio.
    utteranceFrame({ atMs, v, playing, forwarded: forward.length, held, dropped, released });

    // S3-2: while the clip is playing, the ordinary (lower) barge threshold
    // is not this call's to act on -- the controller's own clipBarge verdict
    // above, gated on CLIP_BARGE_MIN_MS, is. C1 fix: caller audio during the
    // clip is now HELD (pushClipHold, above), not forwarded, until the seed
    // has gone -- this comment used to say it reached Live regardless, which
    // was the checkpoint-A C1 bug.
    if (barge && !dialFirstSeconds?.clipPlaying?.()) {
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
      // Final wave W1 (A26, F-R2 re-review 2's out-of-scope note): on an
      // OUTBOUND call that flush now writes the turn's rows first -- it used
      // to fold and clear both accumulators without persisting either, so a
      // caller's "Hello?" (or "stop calling me") heard before a clip barge
      // left no row for the post-call opt-out detector. Outbound only, like
      // finish()'s own flush (LVX83, the inbound half, stays parked).
      if (state.outboundCall && !turnApplied && (turnReplyText || turnUserText)) persistOpenTurnRows();
      if (!turnApplied && (turnReplyText || turnUserText)) applyTurn();
      turnApplied = false;
      // UNCONDITIONAL, and the line above is why it has to be. That flush is
      // gated on accumulated text, so a model turn that ran tools, emitted no
      // outputTranscription and never received turnComplete -- the zero-text
      // turn ZERO_TEXT_NOTE exists for -- skips applyTurn entirely and would
      // carry its read memo into the next caller turn. A new caller turn is a
      // new question by definition, so the memo goes either way.
      runner?.guards?.resetTurn?.();
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
    // OUTBOUND CALLING (spec §9.3 step 5). While the seeded backstop plays,
    // Live's own audio is dropped -- the backstop already said it -- until the
    // backstop's end mark echoes or the audio is cleared. Downsampled first so
    // the filter history stays continuous; never handed to the framer.
    if (dialFirstSeconds && !dialFirstSeconds.onModelAudio(now())) return;
    // 2026-10-01, live mode (spec §4): on hold, nothing the model says reaches
    // the line -- it would be talking to hold music. Kept (bounded), not
    // dropped: Live often starts answering the person who comes back before
    // its own transcript of them lands, and a release mid-generation flushes
    // this so that reply is heard from its first word (flushHoldMutedAudio).
    if (liveFirstLine && !liveFirstLine.onModelAudio(now())) {
      if (holdMutedBytes + mulaw.length <= HOLD_MUTED_AUDIO_MAX_BYTES) {
        holdMutedAudio.push(mulaw);
        holdMutedBytes += mulaw.length;
      }
      return;
    }
    // A5: Live's own audio is about to play -- the clip-tail bypass ends
    // here and the ordinary half-duplex gate protects it again.
    clipTailBypassOpen = false;
    enqueueModelMulaw(mulaw);
  }

  /**
   * Live mode's own two ends (spec §2.4, §4): Live never answered
   * (`live_unresponsive`: no recorded fallback, the retry schedule re-dials),
   * or a hold ran past its cap (`hold_timeout`: recorded as outcome `other`,
   * note "hold timeout", before the call closes). Nobody is listening in
   * either case, so there is no goodbye to wait for.
   */
  function endLiveFirstLineCall(reason) {
    if (closed) return;
    if (reason === "hold_timeout" && state.businessId) {
      database
        .withTenantSafe(
          state.businessId,
          async () => {
            await database.setCallOutcomeCode(callSid, "other");
            await database.mergeCallAnswers(callSid, { _outcome_note: "hold timeout" });
          },
          { operation: "holdTimeoutOutcome", callSid, fallback: null }
        )
        .catch(() => {});
    }
    finish(`outbound_${reason}`);
  }

  /**
   * A person is back after a hold. Final review #6: the new person has heard
   * nothing, so the first heard turn is judged for the disclosure again; and
   * if the model's own words were muted on hold (it may have "introduced
   * itself" to the music), it is told so -- appended as context, never a
   * forced turn -- or it would carry on as if the intro had been heard.
   */
  function onLiveHoldRelease({ midGeneration, droppedOnHold }) {
    if (midGeneration) flushHoldMutedAudio();
    else dropHoldMutedAudio();
    liveDisclosureDone = false;
    if (droppedOnHold > 0) {
      sendDialContent("hold_release_note", {
        turns: [
          {
            role: "user",
            parts: [
              {
                text:
                  "(System: you were on hold -- nothing you said while waiting was heard. The person on the line now " +
                  "has not heard who you are: start again with your intro and the name check.)",
              },
            ],
          },
        ],
        turnComplete: false,
      });
    }
  }

  /** Release mid-generation: the muted start of the reply plays now, in order. */
  function flushHoldMutedAudio() {
    const chunks = holdMutedAudio;
    holdMutedAudio = [];
    holdMutedBytes = 0;
    if (!audioOut) return;
    for (const mulaw of chunks) enqueueModelMulaw(mulaw);
  }

  function dropHoldMutedAudio() {
    holdMutedAudio = [];
    holdMutedBytes = 0;
  }

  /**
   * Live mode, at every generation's close (turnComplete or interrupted): a
   * muted generation that ended unreleased was never heard -- its kept audio
   * goes. And a hold the generation asked for (wait_on_hold, ruling R3)
   * engages only now, after its own "Sure, thank you" has been forwarded.
   */
  function closeLiveGeneration(result) {
    dropHoldMutedAudio();
    if (holdRequestedAt !== null) {
      holdRequestedAt = null;
      liveFirstLine.enterHold(now());
      // Spec §4: identity confirmed before a hold stands only if the voice that
      // comes back says so -- the person may hand the phone to someone else.
      // Unverified again, so nothing phone-keyed or reason-bearing unlocks
      // until confirm_identity runs for whoever comes back.
      if (runner) runner.unverifyParty();
    }
    return result;
  }

  function enqueueModelMulaw(mulaw) {
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
  function recordToolOutput(out, seq = turnSeq) {
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
        if (e.type === "booked") {
          writesThisCall.push({
            type: "booked",
            tool: "book_appointment",
            // An ID, not the arguments. Everything else on `data` is caller data
            // and stays out of the ledger; this is what lets the post-call sender
            // tell an appointment already confirmed at booking time from one that
            // was never confirmed at all.
            appointmentId: e.data?.id || null,
          });
        }
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
      else {
        completedToolsThisCall.add(fr.name);
        // LVX140. CREDITED TO THE TURN THE CALL WAS MADE ON, not to whichever
        // turn is current when its answer arrives. `seq` was captured before
        // the await that produced this output; if the turn has rolled since,
        // the fact belongs in the look-back slot the NEXT turn's claim guard
        // reads. A result that arrives two or more turns late is dropped, which
        // is the direction that lets the guard speak rather than the one that
        // silences it.
        if (seq === turnSeq) actionToolSucceededThisTurn = true;
        else if (seq === turnSeq - 1) actionToolRanPrevTurn = true;
      }
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
    // CAPTURED BEFORE THE AWAIT, for the same reason `modelSpokeThisTurn` above
    // it is. This function is launched fire-and-forget from the turnComplete
    // handler and applyTurn runs on the next line, so by the time the retry's
    // answer arrives the turn has usually already rolled. LVX140.
    const seq = turnSeq;
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

    recordToolOutput(out, seq);
    const response = out.functionResponses?.[0]?.response;
    const ok = response?.success === true;
    // READ OFF THE RESPONSE, not out of the message text. The gates already
    // say "NOT A FAILURE" in prose and prose is not a branch -- services/tools.js
    // marks a held write `gated` so this can be a boolean.
    const gated = !ok && response?.gated === true;
    bumpCounter(ok ? "write_retried_after_spelling" : gated ? "write_retry_gated" : "write_retry_refused");
    log.info("live_write_retried", { callSid, tool: pending.name, ok, gated });

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
      gated
        ? WRITE_RETRY_GATED_NOTE
        : !ok
          ? WRITE_RETRY_FAILED_NOTE
          : nameAtStake
            ? WRITE_RETRIED_NAME_NOTE
            : WRITE_RETRIED_NOTE,
      // A FAILED retry always speaks: the caller has been told about a booking
      // that does not exist and only the model can correct that out loud. A
      // SUCCESSFUL one speaks only when the model has left the caller waiting.
      //
      // A GATED one always speaks too, and for a reason particular to this
      // path: retryPendingWrite never sends the retry's tool response to the
      // session -- it calls handleToolCall and records the output. The model
      // therefore never sees the gate's own refusal, and this note is the only
      // channel it has. Silent here is a held booking nobody mentions again,
      // which is the shape of LVX72.
      { requestReply: gated || !ok || !modelSpokeThisTurn }
    );
  }

  async function onToolCall(toolCall) {
    if (!runner || !session) return;
    // 2026-10-01, live mode (ruling R9): a tool call is Live answering --
    // "Nithin speaking" -> confirm_identity before any audio is not a dead
    // session, so it re-arms the unresponsive deadline.
    if (liveFirstLine) liveFirstLine.noteLiveActivity(now());

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
    // b25. OUTBOUND ONLY -- see the declaration's own comment for why the
    // name alone is not the gate.
    if (state.outboundCall) {
      confirmIdentityCallsThisTurn += (toolCall.functionCalls || []).filter(
        (fc) => fc.name === "confirm_identity"
      ).length;
    }

    // WHICH TURN THIS ROUND BELONGS TO, read before the await that can outlive
    // it. LVX140: turnComplete is free to land while handleToolCall is still
    // running, and when it does the result must be credited to the turn the
    // model made the call on rather than to the one that has started since.
    const seq = turnSeq;
    // Final wave W1 (A19; F-R2 re-reviews' parked "tool calls from a
    // discarded generation still execute"). OUTBOUND only: a tool call that
    // arrives while Live's audio would be discarded (clip mode before the
    // decision, the clip itself, a stale generation's wait, or the hang-up
    // drain -- dialFirstSeconds.discardingNow()) comes from a generation the
    // caller will never hear. The CALLER-VISIBLE ones are refused: end_call
    // (hanging up on a goodbye nobody heard), request_transfer, and every
    // action tool (a booking, a message) -- nothing the caller did not hear
    // proposed and could not have agreed to. Everything else still runs, and
    // the suppression writers above all: opt_out / set_call_outcome said
    // during the clip, or heard only in the hang-up drain, are exactly the
    // writes that must land. A no-op on inbound (dialFirstSeconds is null).
    const unheardRefusals = [];
    let toRun = toolCall;
    // 2026-10-01, live mode: on hold nobody is listening -- the model must not
    // hang up on, transfer, or book with the hold music.
    const discardingNow = Boolean(dialFirstSeconds?.discardingNow?.()) || Boolean(liveFirstLine && liveFirstLine.onHold());
    // D-R2-3: see UNHEARD_IDENTITY_TOOLS. Read at the same instant as
    // discardingNow, before the await below can let the generation close.
    const identityUnheard = discardingNow || Boolean(dialFirstSeconds?.abandonedStaleUnheard?.());
    if (discardingNow || identityUnheard) {
      const keep = [];
      for (const fc of toolCall.functionCalls || []) {
        if (discardingNow && (UNHEARD_REFUSED_TOOLS.has(fc.name) || ACTION_TOOL_NAMES.includes(fc.name))) {
          const message = liveFirstLine && liveFirstLine.onHold() ? HOLD_TOOL_REFUSAL : UNHEARD_TOOL_REFUSAL;
          unheardRefusals.push({ id: fc.id, name: fc.name, response: { success: false, message } });
          bumpCounter("outbound_unheard_tool_refused");
          log.info("outbound_unheard_tool_refused", { callSid, tool: fc.name });
        } else if (identityUnheard && UNHEARD_IDENTITY_TOOLS.has(fc.name)) {
          unheardRefusals.push({ id: fc.id, name: fc.name, response: { success: false, message: UNHEARD_IDENTITY_REFUSAL } });
          bumpCounter("outbound_unheard_tool_refused");
          log.info("outbound_unheard_tool_refused", { callSid, tool: fc.name, discarding: discardingNow });
        } else {
          keep.push(fc);
        }
      }
      if (unheardRefusals.length) toRun = { ...toolCall, functionCalls: keep };
    }
    // A3 (2026-09-30): whether the party was verified BEFORE this round, so a
    // confirm_identity that lands in it can advance the step (below).
    const partyVerifiedBefore = Boolean(runner?.party?.verified);
    let out;
    pendingToolCalls += 1;
    try {
      out =
        unheardRefusals.length && !(toRun.functionCalls || []).length
          ? { functionResponses: [] }
          : await runner.handleToolCall(toRun);
      if (unheardRefusals.length) {
        // Answer every call, in the order the model made them: the runner
        // answers the kept calls one-for-one, in order, so they interleave
        // back by position (no reliance on its responses carrying ids).
        const ran = [...(out.functionResponses || [])];
        const refusedById = new Map(unheardRefusals.map((r) => [r.id, r]));
        const merged = [];
        for (const fc of toolCall.functionCalls || []) {
          if (refusedById.has(fc.id)) merged.push(refusedById.get(fc.id));
          else if (ran.length) merged.push(ran.shift());
        }
        merged.push(...ran);
        out = { ...out, functionResponses: merged };
      }
    } finally {
      // In a finally, so a throw cannot leave the silence ladder permanently
      // suppressed -- which would restore the exact 61-second call this exists
      // to end.
      pendingToolCalls -= 1;
    }

    // A3 (owner decision 2026-09-30, the outbound prompt's own plan). The
    // outbound prompt no longer tells the model to call set_call_intent, which
    // is what used to move an outbound call off IDENTIFY_INTENT -- and the step
    // is what picks the silence ladder (SILENCE_THRESHOLDS: 6/12/20 s there,
    // 10/18/28 s in GATHER_DETAILS, where the questions are asked). So the
    // engine advances it itself, once, the moment the person is confirmed.
    // A call where nobody is ever confirmed (silence, a gatekeeper, a wrong
    // number) keeps IDENTIFY_INTENT exactly as before. set_call_intent stays
    // declared and the reducer is untouched: a later intent still promotes
    // the step the normal way.
    if (
      state.outboundCall &&
      !partyVerifiedBefore &&
      runner?.party?.verified === true &&
      state.step === STEPS.IDENTIFY_INTENT
    ) {
      state.step = STEPS.GATHER_DETAILS;
      log.info("live_step_transition", { callSid, toStep: state.step, trigger: "confirm_identity" });
    }

    // Held for the reducer rather than applied here. applyReplyState orders
    // these deliberately -- intent first, then effects (so a completed action
    // wins the step over an intent change in the same turn), then end_call
    // last so it wins over everything -- and reimplementing that ordering is
    // how two drivers drift.
    refusedActionCallsThisTurn += out.refusedActionCalls || 0;
    refusedCallsThisTurn += out.refusedCalls || 0;

    // LVX157. Mirror the runner's action count, and remember where a completion
    // note was attached. Both are read at turnComplete, which is after every
    // tool round of this turn has been through here, so the values auditTurn
    // sees are the ones that stood when the model composed its reply.
    if (typeof out.completedActionCount === "number") {
      completedActionCount = out.completedActionCount;
      closingAudit.actions_completed = completedActionCount;
    }
    if (out.completionAskNotes > 0) {
      completionAskNoteAtAction = completedActionCount;
      // ONE PER ROUND, NOT ONE PER NOTE, and the difference is not cosmetic.
      //
      // CAad88df4a cancelled two appointments in a single tool round. Two notes
      // went out, the model reported both and asked once -- exactly right -- and
      // the ledger read sent=2 honoured=1, which reads as an instruction obeyed
      // half the time. Two writes in one round can only ever produce ONE ask, so
      // counting the notes made the twin an unreadable ratio on its first
      // multi-write call.
      //
      // The twin only means anything if both sides count the same event, and the
      // event is "a turn that should end in a question", not "a row that landed".
      closingAudit.ask_note_sent += 1;
    }
    // Read off the runner's own running total rather than recomputed here. A
    // second tally of the same fact is how actionToolsRanThisTurn came to
    // disagree with the runner about whether a write had happened (LVX140).
    if (typeof out.anythingElseRearms === "number") {
      closingAudit.ask_rearmed_by_action = out.anythingElseRearms;
    }

    if (out.intentArgs) pendingIntentArgs = out.intentArgs;
    if (out.endCallArgs) {
      pendingEndCallArgs = out.endCallArgs;
      endCallArmed = true;
      // LVX141. READ HERE, and here is the only place it can be read.
      //
      // Both facts exist at this instant and neither survives to the exit site:
      // `askedAnythingElseThisCall` is written by auditTurn at turnComplete, so
      // it still answers for the turns BEFORE this one; and `turnReplyText`
      // still holds the sentence the model is in the middle of, which applyTurn
      // clears about twenty lines below the exit decision. A guard written to
      // read that text after the clear is the most-repeated defect in this file
      // and it is present, plausible and permanently silent.
      //
      // Computed from the SAME detector the ask gate itself used, so the two
      // cannot disagree about what counts as asking.
      endCallAskWasInTurnOnly =
        !askedAnythingElseThisCall &&
        Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || ""));
      // LVX145, read at the same instant and for the same reason: this is the
      // moment the hang-up is decided. Naturally exclusive of the line above --
      // when the ask is in THIS turn the latch has not been written yet, so the
      // marker is still -1 and this cannot fire.
      endCallAskUnanswered =
        askedAnythingElseAtCallerChars >= 0 &&
        callerSaidThisCall.length === askedAnythingElseAtCallerChars;
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
      // LVX157. WHICH refusals exist only because the ask went stale.
      //
      // Read here because this is the one place that knows both that the gate
      // refused and what the latch looked like when it did. Without it,
      // `end_call_refusals.no_ask` going up after this ships cannot be told
      // apart from the model simply asking less often -- and the second would
      // mean the note in Layer A had made things worse.
      if (
        out.endCallRefusal === "no_ask" &&
        askedAnythingElseThisCall &&
        askedAnythingElseAtAction !== completedActionCount
      ) {
        closingAudit.ask_latch_stale += 1;
        bumpCounter("live_ask_latch_stale_at_action");
      }
    }
    recordToolOutput(out, seq);

    if (out.transferRequested) pendingTransfer = out.transferRequested;
    // 2026-10-01 (spec §4; ruling R3): the hold engages at this generation's
    // close (closeLiveGeneration), not now -- its "Sure, thank you." plays.
    if (out.holdRequested && liveFirstLine && !liveFirstLine.onHold()) holdRequestedAt = now();

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
      // Final wave W1 (A16): text that arrives while Live's audio would be
      // discarded marks its generation dropped BEFORE the guards below read
      // droppedThisGeneration() -- a stale generation whose transcript runs
      // ahead of its first audio chunk no longer slips through them. A no-op
      // on inbound (dialFirstSeconds is null).
      dialFirstSeconds?.noteAssistantText?.();
      if (liveFirstLine) liveFirstLine.noteAssistantText(atMs);
      // F-R2 fix round 1 (opus review, I2). These three guards can each send
      // Live a spoken note (outbound_topic_to_unverified and friends firing,
      // or a leak/repeat/offer note queued) on text that belongs to a
      // generation whose audio dialFirstSeconds has ALREADY discarded whole
      // -- the stale hello reply, or any other suppressed generation, none
      // of which the caller ever heard. droppedThisGeneration(), NOT
      // suppressing(): clipPlaying() alone is true for the WHOLE clip
      // regardless of whether THIS generation's audio was ever actually
      // touched by it -- NB4's own scenario (a text-only push, no audio
      // chunk ever sent) proved gating on suppressing() there silently broke
      // its already-established "the guard still logs, just does not cut"
      // contract. A no-op on inbound, where dialFirstSeconds is always null.
      if (!firstLineDroppedThisGeneration()) {
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
      }
      turnReplyText += sc.outputTranscription.text;
    }

    if (sc.inputTranscription?.text) {
      // LVX70, before the echo gate on purpose: an echoed transcript is still
      // evidence about WHEN the vendor emitted words for a given episode, and
      // suppressing it here would leave the episode looking untranscribed.
      noteUtteranceTranscript(sc.inputTranscription.text, atMs);
      // 2026-10-01, live mode: words are half of a hold release (spec §4).
      // Before the echo gate too -- on hold nothing of ours is playing.
      if (liveFirstLine) liveFirstLine.onCallerTranscript(sc.inputTranscription.text, atMs);
      // Live heard them: the early-audio safety net is no longer needed (a
      // whitespace-only fragment is not a transcript -- the M1 rule).
      if (liveFirstLine && !liveEarlyTranscribed && sc.inputTranscription.text.trim()) {
        liveEarlyTranscribed = true;
        liveEarlyAudio = [];
      }
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
        // Final wave W1 (I2): a no-op unless finish() is draining the clip
        // hold after a hang-up -- then this is the held speech's transcript
        // arriving, and the drain waits for it to settle.
        noteClipDrainTranscript(sc.inputTranscription.text);
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
      // OR THE CALLER AGREED, which is the other reason a write sits refused.
      //
      // The spelling gate refuses for a missing spelling; the write-order gate
      // refuses for a missing yes. Only the first had a trigger, so a booking
      // held up by the second waited on the model to re-propose it — and on
      // CA6b662e the model asked "Is that correct?" and called the tool sixteen
      // milliseconds later, so the answer it was refused for not having was one
      // it had never waited for. The caller then confirmed the same booking
      // twice and was told in between that it had failed.
      //
      // The gate stashes only when a read-back actually happened, so a "yes"
      // here is always agreement to something the caller was read. And the
      // retry goes back through handleToolCall: if the gate would still refuse,
      // it still refuses.
      // ONLY a write the write-order gate held. A spelling-gate stash carries
      // the unspelled name, and re-issuing that on a "yes" would write the
      // mis-heard name into the row — the defect the spelling gate exists to
      // stop, and the one an existing test caught the moment this trigger was
      // written too broadly.
      // LVX160 adds "in_addition", and it is named rather than folded into a
      // truthy check for the reason written above: the set of stashes safe to
      // release on a bare "yes" is a whitelist, and the spelling stash must
      // never be in it. This one carries the SAME args the caller was just read
      // back, plus the flag the pack asked for and the model did not set, so a
      // "yes" releases exactly the booking the caller just agreed to.
      const retryReason = runner ? runner.peekPendingWrite()?.reason : null;
      const heldForAgreement =
        (retryReason === "write_order" || retryReason === "in_addition") &&
        isAffirmative(turnUserText);
      // -----------------------------------------------------------------
      // A GUARD THAT WAS WRITTEN HERE AND REMOVED, 2026-09-20, RECORDED SO IT
      // IS NOT WRITTEN AGAIN.
      //
      // The first version of LVX160 excluded an `in_addition` stash from the
      // `spellingSettled` half of this condition, reasoning that such a stash is
      // created the instant the pack refuses -- before the caller has answered
      // anything -- and carries "book a second appointment", so releasing it on
      // a spelling answer would write something nobody agreed to.
      //
      // IT CANNOT. retryPendingWrite re-enters handleToolCall, so the released
      // write goes through the write-order gate exactly like any other. The
      // consent latch it checks requires the agreement to match the STANDING
      // read-back, and after the model asks "shall I book this additional one?"
      // the standing read-back is that question, unanswered -- so the gate
      // refuses. The only way the write lands is if consent is genuinely
      // standing, and then it is the booking the caller agreed to.
      //
      // scripts/corpus/sabotage.mjs said so before this reasoning did: with the
      // guard removed the suite stayed GREEN, and no scenario could be built in
      // which it changed an outcome. Same shape as the supersession disjunct
      // removed in the corpus-replay round -- a clause whose condition is
      // already implied by the gate downstream of it.
      //
      // What made the first attempt LOOK necessary was a test asserting that a
      // booking must not land after the caller said "No, move the first one
      // instead." It landed, correctly: the caller had agreed two turns earlier
      // and the row was the one they asked for. The premise was wrong, not the
      // code.
      // -----------------------------------------------------------------
      if (spellingSettled(state) || heldForAgreement) {
        retryPendingWrite().catch((err) =>
          log.error("live_write_retry_error", { callSid, reason: err?.message, severity: "warn" })
        );
      }

      // F-R2 fix round 1 (opus review, I2). Must run BEFORE persistTurnTranscript
      // and detectOutboundTurn below, not after: its return value (heard) gates
      // both, so it cannot wait for applyTurn() to run first the way the OLD
      // single call site (after applyTurn, using replyAtTurnEnd) did. Reads
      // turnReplyText directly -- the SAME value replyAtTurnEnd captures a few
      // lines down, before applyTurn clears it, since nothing between here and
      // there can change it. `?? true` because dialFirstSeconds is always null
      // on inbound: every existing inbound row/detector call stays exactly as
      // unconditional as before.
      // 2026-10-01, live mode: heard unless the generation was muted on hold
      // and never released; `firstAnswer` marks the turn the disclosure check
      // reads (ruling R4). The clip controller is not built in live mode.
      const liveTurn = liveFirstLine ? closeLiveGeneration(liveFirstLine.onTurnComplete(atMs)) : null;
      const heardThisTurn = liveTurn
        ? liveTurn.heard
        : dialFirstSeconds?.onAssistantTurnText(turnReplyText.trim(), true) ?? true;
      checkLiveFirstReplyDisclosure(liveTurn, turnReplyText.trim(), { complete: true });
      noteAssistantSaid(heardThisTurn, turnReplyText);
      // F-R2 fix round 2 (opus re-review, I2 residual/out-of-scope note): the
      // claim ledger, the promise-only-turn guard (both inside auditTurn) and
      // the sign-off exit arming all read turnReplyText too -- I2's own class
      // of defect, through a sink the first review did not cite. A stale
      // "One moment, let me check that for you." produced live_promise_only_turn
      // and a spoken PROMISE note mid-clip, on text nobody heard. `?? true`
      // above already makes this unconditional on inbound.
      if (heardThisTurn) auditTurn();
      // Final wave W1 (A24): the caller-side instruments still run on an
      // unheard turn -- counts and logs only, no note.
      else auditCallerTurn({ notes: false });
      // LVX83, between the guards and the fold. applyTurn() is what clears the
      // two accumulators, so this is the last moment a whole turn exists.
      // F-R2 I2: a generation dialFirstSeconds discarded whole leaves no more
      // of a transcript row than it left of an audible reply.
      // F-R2 fix round 2 (opus re-review, NB1): gate ONLY the AI half now, not
      // the whole call. The caller's own words are never stale -- they came
      // from the caller's own microphone, not a suppressed generation -- and
      // dropping them here (as gating the whole call did) silenced the
      // post-call opt-out detector (lib/outbound/detectors.js's detectOptOut,
      // read by lib/outbound/postCall.js) on exactly the calls this fix made
      // routine: every hello-end hello, every backstop_slow greeting.
      persistTurnTranscript(turnUserText.trim(), heardThisTurn ? turnReplyText.trim() : "");
      // Final wave W1 (A22, F-R2 re-review 2 m4): the reducer fold below is a
      // sink too -- applyTurn() pushes the reply into state.history and
      // counts a spell request in it toward spellAskCap. An unheard reply
      // must not be folded as something Ava said; the caller's own half
      // still is. Cleared HERE, ahead of the anchored replyAtTurnEnd/applyTurn
      // pair, so the exit guards below read the same (empty) reply too.
      // Inbound: heardThisTurn is always true, so this never runs there.
      if (!heardThisTurn) turnReplyText = "";
      turnApplied = true;
      const transfer = pendingTransfer;
      // CAPTURED BEFORE applyTurn(), for the reason the line above it already
      // states: applyTurn clears the accumulators, so by the time the exit is
      // armed twenty lines down `turnReplyText` is empty. The question guard
      // read it there first and silently never fired -- a fix that looked
      // applied and did nothing, which is this file's own most-repeated defect.
      const replyAtTurnEnd = String(turnReplyText || "").trim();
      applyTurn();
      // S3-1 (spec §19, S3-D1): per-assistant-turn habits that must never
      // leak onto a call Ava placed (lib/outbound/detectors.js
      // detectOutboundTurn), counted so a leak is visible without anyone
      // listening to a live call -- the same reasoning as every other
      // count-first guard in this file. Inbound never reaches this:
      // state.outboundCall is absent there, exactly like every other
      // outbound-only branch. F-R2 I2: `&& heardThisTurn` -- an unheard
      // (fully suppressed) turn must not trip outbound_topic_to_unverified
      // or the other turn-habit counters on words nobody heard.
      if (state.outboundCall && heardThisTurn) {
        const outboundTurnFlags = detectOutboundTurn({
          assistantText: replyAtTurnEnd,
          partyVerified: Boolean(runner?.party?.verified),
          topic: state.outboundCall?.config?.topic || "",
        });
        if (outboundTurnFlags.askedContactNumber) {
          bumpCounter("outbound_asked_contact_number");
          log.info("outbound_asked_contact_number", { callSid, step: state.step });
        }
        if (outboundTurnFlags.inboundClosing) {
          bumpCounter("outbound_inbound_closing_phrase");
          log.info("outbound_inbound_closing_phrase", { callSid, step: state.step });
        }
        if (outboundTurnFlags.topicToUnverified) {
          bumpCounter("outbound_topic_to_unverified");
          log.info("outbound_topic_to_unverified", { callSid, step: state.step });
        }
      }
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
        // -----------------------------------------------------------------
        // A QUESTION OUTRANKS A HANG-UP. CA2556d43d, 2026-09-17:
        //
        //   05:06:02.069  cancel_appointment_db  success=true
        //   05:06:04.788  end_call               success=true  <- allowed
        //   05:06:09.300  "...is now cancelled. Is there anything else I can
        //                  help you with today?"
        //   05:06:10.888  live_exit_run
        //
        // The caller was asked a question and the line dropped 1.6 s later.
        //
        // The end_call gate cannot prevent this and it is not its fault: on
        // Live the model composes the speech and the tool call together and
        // the tool runs FIRST, so at gate time the reply does not exist. The
        // gate can only check state -- wrapping up, did something, had a
        // conversation, was the last caller word a hesitation -- and on that
        // call all four were satisfied. Correctly.
        //
        // Here the reply DOES exist. This is the first moment it does.
        //
        // The shape is already in this file's record: armExit's own comment
        // describes call 7aef50 closing "on a turn that ended in a fresh
        // question to the caller", and concluded that the barge guard had
        // delayed a hang-up rather than prevented one. LVX96 then closed the
        // route where a REFUSED end_call produced a stray farewell. This is
        // the route where end_call is allowed, and it stayed open.
        //
        // NOT APPLIED TO exitAfterTurn. That is the silence ladder's last
        // rung and it is the backstop for every call that would otherwise
        // stay open -- including this one. A rule that could block it would
        // trade a premature hang-up for a line nobody can close, which is the
        // defect on the other call of the same night.
        //
        // `endCallArmed` is never lowered, so this is a HOLD and not a
        // cancel: the retry re-asks at the end of the next turn, and once the
        // caller has answered and the model stops asking, the exit arms. The
        // cost is one turn.
        // -----------------------------------------------------------------
        // -----------------------------------------------------------------
        // LVX141, CA94f2b4, 2026-09-18. THE SECOND WAY A QUESTION OUTRANKS A
        // HANG-UP, and it is the same rule read from the other end.
        //
        // The test above is POSITIONAL: does the reply end with a question
        // mark? That is what caught CA2556d43d. CA94f2b4 asked "Is there
        // anything else I can help you with today?" and then, in the same
        // breath and the same turn, "Thank you for calling Digile Media, and
        // have a great day." The reply ends with the farewell, so the
        // positional test says no -- and LVX132's ask gate had already let the
        // hang-up through on the strength of that very question.
        //
        // One guard asks whether a question was asked anywhere; the other asks
        // whether the reply ends with one. A turn that asks mid-sentence and
        // then signs off satisfies the first and evades the second, and the
        // caller gets 1.5 seconds of dial tone in which to answer.
        //
        // `endCallAskWasInTurnOnly` closes that seam with state rather than
        // with a phrase list: it is true only when the ask that satisfied the
        // gate exists nowhere but the turn now ending, which is by definition a
        // question the caller has not had the chance to answer. See its
        // declaration for why it can only be computed at end_call time.
        //
        // SPENT WHEN IT FIRES. The hold is one turn, exactly as the positional
        // one is: `endCallArmed` is never lowered, so the exit re-offers itself
        // at the end of the next turn, and by then askedAnythingElseThisCall is
        // set and this flag is clear. Without the spend it would hold the exit
        // on every subsequent turn, which is a line nobody can close -- the
        // defect on the other call of that night.
        //
        // KNOWN COST, and it is LVX136's: a held turn gives the model another
        // chance to sign off, so the caller is more likely to hear the goodbye
        // twice. That trade was already accepted when LVX132 shipped -- being
        // hung up on mid-question is worse -- and the rate is readable from
        // live_repeated_phrase.
        // -----------------------------------------------------------------
        const heldForInTurnAsk = endCallArmed && !exitAfterTurn && endCallAskWasInTurnOnly;
        // LVX145's half. Its own binding rather than a third disjunct inside
        // the line below, so each of the three reasons to hold has a name, a
        // counter and a sabotage row of its own.
        const heldForUnansweredAsk = endCallArmed && !exitAfterTurn && endCallAskUnanswered;
        const askedTheCaller =
          (endCallArmed && !exitAfterTurn && /\?['")\]\s]*$/.test(replyAtTurnEnd)) ||
          heldForInTurnAsk ||
          heldForUnansweredAsk;
        if (askedTheCaller) {
          // COUNTED SEPARATELY from the positional hold, because the two have
          // different causes and a single counter could not say which one is
          // firing on real calls. Both are bumped when both apply: the
          // positional series keeps the meaning it has carried since
          // 2026-09-17, and the new one is exactly what this seam added.
          if (/\?['")\]\s]*$/.test(replyAtTurnEnd)) {
            bumpCounter("live_exit_held_question");
            log.info("live_exit_held_question", { callSid, step: state.step });
          }
          if (heldForInTurnAsk) {
            bumpCounter("live_exit_held_in_turn_ask");
            log.info("live_exit_held_in_turn_ask", { callSid, step: state.step });
          }
          if (heldForUnansweredAsk) {
            bumpCounter("live_exit_held_unanswered_ask");
            log.info("live_exit_held_unanswered_ask", { callSid, step: state.step });
          }
          endCallAskWasInTurnOnly = false;
          // SPENT, exactly like the one above it. The caller may still say
          // nothing, and a hold that re-arms on every turn is a line nobody can
          // end -- which is the defect on the other call of 2026-09-17, and
          // worse than the hang-up this prevents. The silence ladder is the
          // backstop from here.
          endCallAskUnanswered = false;
        } else {
          // exitAfterTurn is the silence ladder's last rung: the goodbye has
          // now been generated, so the exit can queue behind the audio
          // carrying it.
          //
          // Cleared here too. The only way to reach this branch with the flag
          // still set is the silence ladder overriding the hold, and the call
          // is ending regardless -- but a latch left standing after the
          // decision it informed is how a one-shot becomes a trap.
          endCallAskWasInTurnOnly = false;
          endCallAskUnanswered = false;
          armExit("end_call");
        }
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
      //
      // OUTBOUND CALLING (G3). A first turn cut short is judged on what was
      // said of it: an intro interrupted before the disclosure did not
      // disclose. A no-op on inbound. I5 (checkpoint 2b review): `false`
      // here -- an interrupted turn never satisfies the check on its text
      // alone, whatever it says; it only re-arms. F-R2 fix round 1 (opus
      // review, I2): moved BEFORE persistTurnTranscript (was after) so its
      // return value (heard) can gate the row -- an interrupted turn whose
      // audio dialFirstSeconds discarded whole leaves no more of a
      // transcript entry than a fully-suppressed turnComplete one does.
      const liveInterruptedTurn = liveFirstLine ? closeLiveGeneration(liveFirstLine.onInterrupted(atMs)) : null;
      const heardThisInterruptedTurn = liveInterruptedTurn
        ? liveInterruptedTurn.heard
        : dialFirstSeconds?.onAssistantTurnText(turnReplyText.trim(), false) ?? true;
      checkLiveFirstReplyDisclosure(liveInterruptedTurn, turnReplyText.trim(), { complete: false });
      noteAssistantSaid(heardThisInterruptedTurn, turnReplyText);
      // F-R2 fix round 2 (NB1): the AI half only, same as the turnComplete
      // site -- the caller's own words are never stale.
      persistTurnTranscript(turnUserText.trim(), heardThisInterruptedTurn ? turnReplyText.trim() : "");
      turnReplyText = "";
      turnUserText = "";
      transcriptWrittenThisTurn = false;
      turnApplied = false;
      leakHandledThisTurn = false;
      offerHandledThisTurn = false;
      // Cleared here too, and not only in applyTurn, which an interrupted turn
      // never reaches. A barge ends the turn; the next question is a new one.
      runner?.guards?.resetTurn?.();
      noteSentThisTurn = false;
      // The turn was abandoned, so its refusal cannot suppress a sign-off on
      // the NEXT turn -- the model will generate that one fresh, and a stale
      // suppression is the permanent one this is scoped to avoid.
      endCallRefusedThisTurn = false;
      nameInToolArgsThisTurn = false;
      toolRoundsThisTurn = 0;
      realToolCallsThisTurn = 0;
      // Cleared HERE too, and not only in applyTurn, which an interrupted turn
      // never reaches. Without this the action count survived into the next
      // turn and actionToolsRanThisTurn() read high -- which, now that the
      // claim guard ACTS on that condition, is the guard going quiet on barged
      // turns specifically.
      //
      // This matches what the any-tool side already does: an interrupted turn's
      // tools leave no look-back behind them either, because toolRanPrevTurn is
      // only ever written by applyTurn. The alternative -- writing
      // actionToolRanPrevTurn here so a barged turn's real action tool still
      // backs a trailing claim -- is arguably more correct and changes the
      // any-tool behaviour too, so it is not taken here. A note asks; it does
      // not act, so the loose direction is the safe one.
      actionToolCallsThisTurn = 0;
      confirmIdentityCallsThisTurn = 0;
      // LVX140's flag, cleared alongside the tally it replaced, so a barged
      // turn still leaves no look-back behind it. `turnSeq` is deliberately NOT
      // advanced here: an interrupt resets a turn's accumulators without ENDING
      // the turn, and advancing it would push an in-flight result into the
      // look-back slot -- which is exactly the alternative the paragraph above
      // declines to take.
      actionToolSucceededThisTurn = false;
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
      // I1 (S3-2 fix round 1): NOT while the outbound clip is playing. Live
      // reports `interrupted` whenever ITS OWN detector decided the caller
      // interrupted -- which fires on the seed's own arrival (S3-2 defers
      // that where it can, but not every case is avoidable) and on speech
      // our gate held below its 300 ms barge threshold, neither of which is
      // evidence the CLIP should stop. Clearing on this signal defeated
      // CLIP_BARGE_MIN_MS outright: a barge under 600 ms still reached Live
      // (the gate forwards it independently of what we act on), Live still
      // called it an interruption, and the clip died anyway. Our own barge
      // (clipBarge, above) is the only thing allowed to stop the clip now;
      // onAssistantTurnText (already called above) still closes the
      // generation either way, which is all the discard's condition (i)
      // needs.
      if (!dialFirstSeconds?.clipPlaying?.()) clearAudio(atMs, { barge: true });
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
   *
   * OUTBOUND CALLING (spec §9.7, correction C9, Task 19). state.outboundCall
   * present selects a COMPLETELY DIFFERENT TwiML shape and REST client below;
   * absent, this function is byte-for-byte what it was before this task --
   * same client resolution, same TwiML string, asserted in
   * tests/outboundTransfer.test.js against a captured copy of today's string.
   */
  async function redialForTransfer(transferNumber, trigger) {
    if (!transferNumber) {
      finish("transfer_no_number");
      return;
    }
    const dial = state.outboundCall;
    // C17 seam (Carried, Task 13): every outbound Twilio REST call goes
    // through twilioClientFor(callerId), never a client built ad hoc here --
    // account selection by caller_id is Task 22's job, not this one's, but the
    // seam has to be used now so that day's change does not have to find and
    // fix this call site too. Inbound's client resolution is UNCHANGED: the
    // injectable twilioClient test seam, then the same ad hoc import.
    const client = twilioClient
      ? twilioClient
      : dial
        ? await twilioClientFor(dial.config?.caller_id)
        : (await import("twilio")).default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    let twiml;
    if (dial) {
      // callerId is the CAMPAIGN's own caller_id, never state.callerNumber --
      // on outbound that is the CONTACT's number (spec §6.2, Ruling P-3), and
      // presenting it as our caller ID would have the transfer target dial the
      // contact back on a number that was never actually calling them. That is
      // exactly the defect this task exists to fix (Carried from Task 14).
      const base = outboundBaseUrl(env);
      const attemptId = encodeURIComponent(state.attemptId || "");
      const resultUrl = `${base}${OUTBOUND_TRANSFER_RESULT_PATH}?attempt=${attemptId}`;
      // transfer.whisper === false: no url attribute at all, so Twilio bridges
      // the call with no spoken introduction to the person who answers.
      const whisperUrl = `${base}${OUTBOUND_WHISPER_PATH}?attempt=${attemptId}`;
      const numberUrlAttr = dial.config?.transfer?.whisper === false ? "" : ` url="${escapeXml(whisperUrl)}"`;
      // OWNER O-14 (fix round 1): the same ringback the inbound branch below
      // already gives, resolved from the BUSINESS config exactly the same
      // way -- so the staff member being transferred to hears ringing even
      // when their own carrier supplies no early media, same as an inbound
      // transfer target does.
      twiml =
        `<Response><Dial ringTone="${resolveRingTone(state.config)}" timeout="20" callerId="${escapeXml(dial.config?.caller_id || "")}" action="${escapeXml(resultUrl)}">` +
        `<Number${numberUrlAttr}>${escapeXml(transferNumber)}</Number></Dial></Response>`;
    } else {
      // Resolved per business, as the cascade does. Hardcoding "uk" was right
      // for the tenant in front of me and would have given every US business a
      // British ringback -- which is exactly why it would have survived.
      const callerIdAttr = state.callerNumber ? ` callerId="${escapeXml(state.callerNumber)}"` : "";
      twiml = `<Response><Dial ringTone="${resolveRingTone(state.config)}"${callerIdAttr}>${escapeXml(transferNumber)}</Dial></Response>`;
    }

    await client.calls(callSid).update({ twiml });
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
    // OUTBOUND CALLING (spec §9.2). `direction` only SELECTS the branch -- it
    // grants nothing. An outbound session's identity is the CallSid the signed
    // token bound, resolved to an attempt this service placed; a forged
    // `direction` on an inbound call's stream finds no attempt and is closed.
    // So on outbound neither stream parameter below is read at all, nor the
    // LIVE_BUSINESS_PHONE developer override. Absent `direction` = inbound,
    // and both lines evaluate exactly as they always have.
    const outboundDial = custom.direction === "outbound";
    const businessPhone = outboundDial ? "" : env.LIVE_BUSINESS_PHONE || custom.businessPhone || "";
    const callerPhone = outboundDial ? "" : custom.callerPhone || "";

    log.info("live_stream_start", {
      callSid,
      streamSid: startData.streamSid,
      businessPhone,
      arm: strategy.name,
      // undefined on inbound, which JSON drops: the inbound line is unchanged.
      direction: outboundDial ? "outbound" : undefined,
    });

    // LVX131. Before the tenant lookup and before the vendor connect, both of
    // which are awaited and either of which can hang. From here on this call
    // tears down on a wall clock whatever else stops happening.
    startMediaWatchdog();

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
    /** OUTBOUND CALLING: the attempt's context, resolved by CallSid (spec §9.2). Null on inbound. */
    let dialCtx = null;
    if (outboundDial) {
      // THE TOKEN'S CallSid, and nothing the stream says. server.js binds
      // ws.authorizedCallSid from the signed media-stream token, and the check
      // above has already refused a start frame naming a different call. Only
      // when token enforcement is explicitly off (TWILIO_VALIDATE_SIGNATURE=
      // false, a local rig) is there no bound CallSid, and then the start
      // frame's is as trusted as anything else on that socket. With
      // enforcement on and nothing bound, refuse.
      const boundCallSid = ws.authorizedCallSid || (mediaStreamTokenRequired(env) ? null : callSid);
      let reason = boundCallSid ? "no_attempt" : "unbound";
      // ONE fast retry after a THROW (fix round 1, M11): a database blip at
      // pickup would otherwise be a silent call and a hang-up. A clean miss is
      // an answer, not a blip -- it is not an attempt this service placed --
      // and is not retried.
      for (let attempt = 0; boundCallSid && attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, DIAL_CONTEXT_RETRY_MS));
          if (closed) return;
        }
        try {
          dialCtx = await resolveOutboundContext(boundCallSid, { db: database });
          reason = "no_attempt";
          break;
        } catch (err) {
          reason = err?.message || "resolve_failed";
        }
      }
      if (!dialCtx) {
        log.error("outbound_context_missing", { callSid, reason });
        ws.close(1008, "no outbound context");
        return;
      }
      business = dialCtx.business;
    } else if (database.isEnabled()) {
      try {
        business = await database.lookupBusinessByPhone(businessPhone);
      } catch (err) {
        log.error("live_business_lookup_failed", { callSid, reason: err?.message, severity: "warn" });
      }
      if (!business) log.error("live_no_business_found", { callSid, businessPhone, severity: "warn" });
    }
    tLookup = now() - tStart;
    // The BUSINESS config on both paths: the same row shape (b.* +
    // business_capabilities) through the same loadConfig. On outbound the
    // campaign's own config lives on state.outboundCall, never here.
    const config = database.loadConfig(business);
    state.config = config;
    state.businessId = business?.id || null;
    state.callerNumber = callerPhone;
    state.twilioNumber = businessPhone;
    if (dialCtx) {
      // OUTBOUND CALLING (spec §6.2, §9.2). `callerNumber` keeps meaning "the
      // other party" -- here the contact, the number we dialled -- and
      // `twilioNumber` "our number", the campaign's caller_id. direction and
      // attemptId are SHARED_FIELDS (lib/callStateStore.js): writeCallState
      // below carries them to /twilio/status and post-call on any instance.
      const { business: _businessRow, ...outboundCall } = dialCtx;
      state.direction = "outbound";
      state.attemptId = dialCtx.attemptId;
      state.outboundCall = outboundCall;
      state.callerNumber = dialCtx.contact.phone;
      state.twilioNumber = dialCtx.config.caller_id;
      // I6 (fix wave, checkpoint 2b, = b37): stamp `answered_at` the moment
      // the outbound context resolves -- the stream only starts after
      // pickup, so this is the SAME semantics as Twilio's own "in-progress"
      // callback (services/db.js's stampAttemptAnswered has the full
      // rationale). Fire-and-forget, the same shape as the transfer path's
      // own markCallTransferred write below: a slow or failed stamp must
      // never delay or fail connecting the call, and post-call's own I6
      // fallback (ctx.callId != null) covers the write itself being lost.
      database
        .withTenantSafe(dialCtx.businessId, () => database.stampAttemptAnswered(dialCtx.attemptId), {
          operation: "liveStampAttemptAnswered",
          callSid,
          fallback: null,
        })
        .catch((err) => log.error("outbound_answered_stamp_failed", { callSid, attemptId: dialCtx.attemptId, message: err?.message, severity: "warn" }));
    }

    const extras = {
      integrations: [],
      // THE TOOL LAYER HAD NO callSid. ctx carried `callId` -- the database row
      // -- and nothing else, so every log line written from inside a tool call
      // was unattributable to a call in Cloud Logging, which filters on callSid.
      // Adding the field to tool_duration alone would have logged null forever;
      // the wire has to exist first. The cascade now carries it too on a recognised callback (buildExtras) and is
      // unchanged by this.
      callSid,
      // Never fetched at all before the review: the KNOWLEDGE BASE section of
      // the prompt was absent on every Live call, so the assistant could
      // answer no FAQ.
      knowledge: [],
      businessId: business?.id || null,
      // OUTBOUND CALLING, Ruling P-3: EMPTY on outbound (callerPhone is "" on
      // that branch, above), although state.callerNumber is the contact's
      // number for the calls row. With it empty the "THIS CALLER'S NUMBER"
      // prompt block emits nothing (D-b), and the phone-keyed tools --
      // phone_on_file, lookupByCaller, clientPhone -- fail CLOSED until Task 18
      // gives them ctx.party. Inbound: the caller's number, as always.
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
      // Test seam only; undefined in production. See the deps destructure above.
      ...(capabilityDeps ? { capabilityDeps } : {}),
      // OUTBOUND CALLING (spec §9.2): the call context the prompt builders and
      // tool declarations read (Tasks 16/18). The key is ABSENT on inbound, so
      // nothing that iterates extras sees a difference there.
      ...(dialCtx ? { outboundCall: state.outboundCall } : {}),
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
      let callbackOutreach = null;
      const [callRes, integrationsRes, knowledgeRes, callerRes] = await database.withTenantSafe(
        business.id,
        async () => {
          const settled = await Promise.allSettled([
            // OUTBOUND CALLING (spec §6.2): the contact as the other party, our
            // caller_id, and the link columns. Inbound: the four-argument call,
            // unchanged.
            dialCtx
              ? database.createCall(business.id, callSid, state.callerNumber, state.twilioNumber, {
                  direction: "outbound",
                  campaignId: dialCtx.campaignId,
                  campaignVersion: dialCtx.campaignVersion,
                  outreachId: dialCtx.outreachId,
                  attemptId: dialCtx.attemptId,
                  contactId: dialCtx.contactId,
                })
              : database.createCall(business.id, callSid, callerPhone, businessPhone),
            database.listIntegrationsForBusiness(business.id, { enabledOnly: true }),
            database.fetchBusinessKnowledge(business.id),
            // D-b (owner decision): outbound skips caller history. Explicit, not
            // left to callerPhone being empty there.
            !dialCtx && callerPhone ? database.fetchCallerContext(business.id, callerPhone) : Promise.resolve(null),
          ]);
          // S4-1 (spec §12.3): is this a lead we called, ringing back? INBOUND
          // ONLY, and LAST: the four fetches above have settled, so a no-outreach
          // call did exactly the work it always did, and the lookup's savepoints
          // have nothing else in flight on the shared client to interleave with.
          // Bounded, never throws; any failure leaves the call untouched.
          if (!dialCtx) {
            const created = settled[0].status === "fulfilled" ? settled[0].value : null;
            callbackOutreach = await recognizeCallback({ database, businessId: business.id, callerPhone, callSid, callId: created });
          }
          return settled;
        },
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
      // S4-1: the key exists ONLY on a recognised callback, so every other
      // inbound call's extras (and prompt, and declarations) is unchanged.
      // The minimal-prompt bisect arm builds no callback tail, so it must not
      // declare record_answer either: tail and declaration share this one gate.
      // A scope that failed (withTenantSafe returned its fallback: the link and
      // the close rolled back with it) leaves callRes rejected, so the context
      // is not kept over an unlinked row.
      if (callbackOutreach && callRes.status === "fulfilled" && callRes.value && env.LIVE_PROMPT !== "minimal") {
        extras.callbackOutreach = callbackOutreach;
      }

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

    // OUTBOUND CALLING (spec §9.3): listen first, then -- only if needed --
    // play the backstop and seed it. Built HERE, once audioOut exists and
    // before the vendor connect: the silence deadline must hold even when Live
    // is slow to open (anything it has to send Live waits for the connect).
    // 2026-10-01 (spec 2026-10-01-outbound-live-first-line §2): `live` is the
    // default -- no recorded opener; `clip` (S3-2, below, unchanged) is the
    // one-setting rollback. An unrecognised value still fails to `clip`, the
    // path that has taken real calls, with a WARN log (resolveFirstSpeaker).
    const firstSpeaker = dialCtx ? resolveFirstSpeaker(env.OUTBOUND_FIRST_SPEAKER, log, { callSid }) : null;
    // The prompt (lib/outbound/prompt.js FIRST REPLY / hold row) and the tool
    // list (services/gemini.js wait_on_hold) read the mode from here --
    // extras.outboundCall is this same object. Absent reads as live, so the
    // clip rollback must say so explicitly.
    if (state.outboundCall) state.outboundCall.firstSpeaker = firstSpeaker;
    if (firstSpeaker === "live") {
      liveBusinessName = business?.name || config.businessName;
      liveFirstLine = createLiveFirstLine({
        streamStartAtMs: tStart,
        // Live itself says it (no recording, owner 2026-10-01), cued early
        // enough to be heard at ~3 s. speakLine marks the turn as a line the
        // CALL asked for (LVX120), not the reply the person is answering.
        speakHello: () => speakLine("silence_hello", getOutboundStrings(config).silenceHelloOutbound),
        endCall: (reason) => endLiveFirstLineCall(reason),
        onRelease: ({ midGeneration, droppedOnHold }) => onLiveHoldRelease({ midGeneration, droppedOnHold }),
        log,
        bumpCounter,
        logFields: { callSid, attemptId: dialCtx.attemptId },
      });
      // Test seam, like ws.liveDialFirstSeconds.
      ws.liveFirstLine = liveFirstLine;
    }
    if (firstSpeaker === "clip") {
      dialFirstSeconds = createFirstSecondsController({
        now,
        firstSpeaker,
        bumpCounter,
        // Final review I1: heard-ness is scoped to the GENERATION. When the
        // idle/cap bound abandons a stale generation that never reported its
        // close, the reply text accumulated so far is its own -- text the
        // caller never heard -- and must not reach the transcript row, the
        // guards, the detectors or the history fold of whatever plays next.
        // Only the REPLY accumulator: the caller's own words are never stale.
        discardReplyText: () => {
          turnReplyText = "";
        },
        backstopAudio: dialCtx.openerAudio,
        backstopText: dialCtx.openerText,
        // THE NORMAL AUDIO PATH (§9.3 step 4, correction C8 superseded): the
        // backstop plays through the same audioOut path as any assistant
        // audio. hasEnqueuedAudio is what makes isPlaying() -- and so the
        // barge gate -- see it at all. M6/I1 (fix round 1): stopping it is
        // NOT symmetric with ordinary assistant audio any more -- only OUR
        // OWN barge (clipBarge, CLIP_BARGE_MIN_MS) does; the vendor's own
        // `interrupted` is deliberately skipped while dialFirstSeconds.
        // clipPlaying() is true (see the sc.interrupted handler below).
        audioOut: {
          enqueue: (buf) => {
            audioOut.enqueue(buf);
            hasEnqueuedAudio = true;
          },
        },
        sendMark: (name) => audioOut.sendMark(name),
        // S1, the shape spike A proved 6/6 (spec §9.8): a lone model turn,
        // turnComplete false, so Live treats the line as already said.
        seed: (text) => {
          sendDialContent("seed", { turns: [{ role: "model", parts: [{ text }] }], turnComplete: false });
          // N2 fix (checkpoint-A re-review): maybeReleaseClipHold, not an
          // unconditional release. On the hello-end/slow paths the seed is
          // sent AT the clip's own end-mark echo, so clipPlaying() is
          // already false here and this releases immediately, same as
          // round 1. On the SILENCE path the seed goes out at fire, while
          // the clip is still playing -- releasing right then forwarded the
          // caller's mid-clip speech to Live in real time, and Live's own
          // reply to it (generated before the clip's audio had finished)
          // was then discarded as a generation "opened during the clip".
          // Holding until the clip is ALSO done (see the clip-hold block
          // comment above `gate`) means any reply Live generates starts
          // after both the seed and the clip, so nothing downstream mistakes
          // it for stale.
          maybeReleaseClipHold("seed_sent");
          // b7 (checkpoint 2b review). `seed` fires exactly when the person
          // heard the backstop's WHOLE line -- at fire time on the silence
          // path, at BACKSTOP_END_MARK's echo on the slow path (O-8) -- so
          // this is also exactly when the tenant's own transcript should gain
          // the row proving the AI disclosure was said. persistTranscriptRows
          // directly, NOT persistTurnTranscript: that sets
          // transcriptWrittenThisTurn and would drop the real first turn's
          // own row when it lands moments later. Its own sequence number
          // (not shared with a turn's caller/assistant pair) so ordering
          // survives regardless of when the first real turn ends.
          if (state.dbCallId && !hipaa) {
            const seq = transcriptSeq;
            transcriptSeq += 1;
            persistTranscriptRows([["ai", text, seq]]);
          }
        },
        noteToModel: (text) =>
          sendDialContent("first_turn_note", { turns: [{ role: "user", parts: [{ text: `(System: ${text})` }] }], turnComplete: true }),
        promptModel: (text) =>
          sendDialContent("backstop_prompt", { turns: [{ role: "user", parts: [{ text: `(System: ${text})` }] }], turnComplete: true }),
        noteSpoken: (text, atMs) => echoGuard.noteSpoken(text, atMs),
        // No clip at stream start: the render may still be finishing (a
        // voicemail attempt renders two lines). One scoped read shortly before
        // the deadline -- never when the call-time re-render refused the clip
        // (O-4), which must not be let back in by the side door.
        refetchBackstopAudio:
          dialCtx.openerAudio || dialCtx.openerRefused
            ? null
            : () =>
                database.withTenant(dialCtx.businessId, () => database.fetchAttemptOpenerAudio(dialCtx.attemptId), {
                  actor: { type: "voice", id: callSid },
                  callSid,
                }),
        streamStartAtMs: tStart,
        // The name the opener was rendered with (business.name), not the
        // config's "our office" fallback.
        businessName: business?.name || config.businessName,
        personaName: dialCtx.config?.persona_name || "",
        logFields: { callSid, attemptId: dialCtx.attemptId },
      });
      // Test seam, like ws.liveAudioOut; Task 20 reads firstAudio() at finish.
      ws.liveDialFirstSeconds = dialFirstSeconds;
    }

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
    // OUTBOUND CALLING, mechanical ruling (spec §9.5). LIVE_PROMPT=minimal is
    // the LVX23 bisect arm's ten-line stand-in (lib/voice/live/minimalPrompt.js)
    // -- it carries no AI disclosure, no first-turn rule and no OUTBOUND CALL
    // block, because it was written before outbound calling existed and is not
    // a candidate prompt for it. An outbound call must never run without those
    // (spec §13.2), so direction wins over the bisect flag outright, and the
    // flag being ignored is logged once so whoever is running that experiment
    // sees it happened rather than silently getting inbound-shaped data back
    // for a call that was never inbound.
    const requestedMinimalPrompt = env.LIVE_PROMPT === "minimal";
    const minimalPrompt = requestedMinimalPrompt && !outboundDial;
    if (requestedMinimalPrompt && outboundDial) {
      log.info("live_outbound_minimal_prompt_ignored", { callSid });
    }
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
    // S3-6: state.outboundCall is set (above) before this line runs, and is
    // undefined on inbound, so the campaign rung is a no-op there.
    const language = resolveLiveLanguage(config, state.twilioNumber, env, state.outboundCall?.config?.language);
    sessionLanguageCode = language.code;
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
      // `env` threaded, not left to process.env: this session reads every other
      // switch off the injected env, and a tool-behaviour flag that only worked
      // in production would be untestable exactly where it matters.
      tools: noTools ? [] : buildLiveTools(config, extras, env),
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
            // Final wave W1 (I2): Live closing ends a hang-up drain at once
            // (nothing more can arrive). A no-op when none is running.
            endClipHoldDrain("live_closed");
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
        // NOT "the transcription language is pinned". This is speechConfig's
        // languageCode, which governs the voice the model SPEAKS. See
        // lib/voice/live/client.js: the API has no input-language control at all,
        // and reading this field as though it did cost a wrong diagnosis.
        output_language_pinned: connected.languagePinned,
      });
    } catch (err) {
      log.error("live_connect_failed", { callSid, reason: err?.message });
      finish("connect_failed");
      return;
    }

    // OUTBOUND CALLING (spec §9.3 step 2): NO KICK. The person picked up and
    // is about to say "Hello?" -- the session listens first, and the model
    // speaks when they do (or the backstop does, if they never do). Anything
    // the controller already asked for while Live was connecting goes now.
    // 2026-10-01: live mode too, explicitly (census trap) -- with only
    // dialFirstSeconds tested here, a live-mode call fell through to the
    // INBOUND greeting kick below and the AI spoke first.
    if (dialFirstSeconds || liveFirstLine) {
      for (const { kind, content } of dialPendingContent.splice(0)) sendDialContent(kind, content);
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
    // Final wave W1 (I2): caller SPEECH still held by the clip hold goes to
    // Live now, for a bounded drain, instead of being dropped (see
    // beginClipHoldDrain). BEFORE `closed = true`: sendAudio refuses a closed
    // session. null -- nothing to drain -- on every inbound call and on every
    // outbound call not holding speech at the hang-up.
    clipDrain = beginClipHoldDrain() ?? beginLiveEarlyAudioStt();
    closed = true;

    // I4 (checkpoint 2b review, = b43 for outbound; G7). The most typical
    // opt-out shape: the person says "stop calling me" and hangs up before
    // Ava's turn completes. persistTurnTranscript only ever ran at
    // turnComplete/interrupted, and finish() never flushed what was still
    // pending, so that turn left NO caller row -- the caller-side detector
    // cannot fire on a row that does not exist, and the retry schedule then
    // calls them again. Outbound only: LVX83, the inbound half of the same
    // gap, stays parked (no compliance stake there). Ahead of
    // transcriptSettled/finishAttemptSession/the post-call claim, all below
    // -- persistTurnTranscript's own transcriptWrittenThisTurn latch makes
    // this a no-op if the turn already completed normally.
    // LIMITATION, stated rather than silently accepted: input transcription
    // arriving AFTER Twilio's `stop` event is still lost -- nothing else
    // reaches this socket once the call is over.
    // Final wave W1 (A17, F-R2 re-review 1 m6): the AI half is gated like
    // the turnComplete/interrupted sites' -- a generation whose audio was
    // discarded (the stale hello reply mid-clip, typically) leaves no AI row
    // on a mid-clip hang-up either. The caller half is never gated.
    if (state.outboundCall) {
      persistTurnTranscript(turnUserText.trim(), firstLineDroppedThisGeneration() ? "" : turnReplyText.trim());
      // I2: the drained speech is a turn of its own -- a fresh accumulator,
      // so its row is written by the drain (or by Live's own turn close
      // during it), never merged into, or blocked by, the row just written.
      if (clipDrain) {
        clipDrainSeqFloor = transcriptSeq;
        turnUserText = "";
        turnReplyText = "";
        transcriptWrittenThisTurn = false;
      }
    }

    // OUTBOUND CALLING (O-7): a first audio whose playout mark never echoed is
    // logged from its queue time, flagged measured:"enqueue". A no-op on
    // inbound.
    dialFirstSeconds?.onSessionEnd();
    // Live mode: timers stop; a call that ended before any reply still logs
    // its outbound_first_reply (path "none").
    if (liveFirstLine) liveFirstLine.onSessionEnd(now());
    dropHoldMutedAudio();
    // N1 fix (checkpoint-A re-review): if any caller audio is still held
    // (the clip never finished by any measure before the line dropped),
    // drop it, counted -- see teardownClipHold's own doc comment. A no-op
    // for inbound and for any outbound call that never held anything.
    teardownClipHold();

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
    // LVX131. The watchdog outlives every other timer by design -- it is the
    // one that fires when nothing else can -- so it is cleared here, in the one
    // place every teardown route passes through.
    clearInterval(mediaWatchdog);
    mediaWatchdog = null;
    audioOut?.stop();
    // I2: a hang-up drain closes the Live session itself, when it ends.
    // Live mode's early-audio STT is not a Live drain: nothing to wait for on Live.
    if (!clipDrain || liveEarlySttStarted) closeLiveSession();
    const record = summary.build();
    log.info("live_call_summary", {
      callSid,
      durationMs: Math.round(now() - t0),
      // OUTBOUND CALLING (spec §14, session 2b, Task 21). `direction` gets an
      // explicit VALUE on inbound too ("inbound") -- the one field this
      // change is required to add to every call, same shape either
      // direction. `attempt_id`/`campaign_id` stay ABSENT on inbound instead
      // (Ruling: `undefined`, which JSON drops -- the same device
      // `live_stream_start`'s own `direction` field already uses a few
      // hundred lines up, for the same reason: "no other change" on inbound
      // means the inbound record gains exactly one key, not three).
      // `state.direction`/`state.attemptId` are set ONLY on the outbound
      // branch of onStart; `state.outboundCall` mirrors dialCtx minus the
      // business row, so `.campaignId` is the campaign this attempt belongs
      // to (lib/outbound/callContext.js resolveOutboundContext).
      direction: state.direction || "inbound",
      attempt_id: state.attemptId || undefined,
      campaign_id: state.outboundCall?.campaignId || undefined,
      // verified_slots alongside the counts, because it is the discriminator
      // the offer guard judges on and nothing in the record showed it. Without
      // it, a call where the guard stayed silent cannot be distinguished after
      // the fact from one where it had nothing to judge -- which is exactly
      // the ambiguity that made an earlier round's echo numbers unreadable.
      guards: runner?.guards
        ? {
            ...runner.guards.counts(),
            verified_slots: runner.guards.verifiedCount(),
            // Apart from verified_slots, which conflates the two sources. A call
            // that confirmed ONE time for the time actually asked about and a
            // call that listed a whole day's sixteen openings both report a
            // number here, and they are not the same evidence.
            point_verified_slots: runner.guards.pointVerifiedCount(),
          }
        : null,
      // What the claim guard did on THIS call, for the reason the block above
      // exists: the live_claim_* family is process-global, so on 2026-09-17 a
      // model claimed a cancellation it had been refused and the call record
      // could not say whether the guard had evaluated that turn at all.
      // `turns_audited` is the denominator and is the point of the whole block.
      claim_audit: { ...claimAudit },
      closing: { ...closingAudit },
      // LVX83's positive half. live_transcript_write_failed reads zero for a
      // clean call AND for a call that never reached the write, so the count
      // of turns that DID issue rows is the one that can tell them apart.
      // `refused` distinguishes a hipaa deployment from a broken one.
      transcript_turns_written: transcriptTurnsWritten,
      transcript_refused: transcriptRefusalLogged || null,
      // LVX131's headroom, on every call rather than only on a timed-out one.
      // The threshold beside it, because a gap is only readable against the
      // number it was judged by, and that number is an env var.
      media_gap_max_ms: Math.round(mediaGapMaxMs),
      media_timeout_ms: MEDIA_TIMEOUT_MS,
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
      const abandonedTools = [...refusedToolsThisCall].filter(
        (n) => !completedToolsThisCall.has(n)
      );
      // WHAT ACTUALLY RAN, for a reader whose only other evidence is a
      // transcript the audited model wrote. Built once and shared by the judge
      // and the recovery's internal judge, so the two can never be told
      // different stories about the same call.
      //
      // Shapes only -- integers, booleans, and tool names from a closed list.
      // No datetime, no name, no appointment id, no slot list: this reader
      // answers WHETHER, never WHICH, and a time here would put it one
      // inference from being an author.
      const guardCounts = runner?.guards?.counts?.() ?? null;
      const toolTraffic = {
        bookingWrites: writesThisCall.filter((w) => w.type === "booked").length,
        changeWrites: writesThisCall.filter((w) => w.type === "changed").length,
        availabilityPointOpen: guardCounts?.availability_point_open ?? 0,
        availabilityPointTaken: guardCounts?.availability_point_taken ?? 0,
        availabilityDayListed: guardCounts?.availability_day_listed ?? 0,
        abandoned: abandonedTools,
        completionClaims: claimsThisCall.length,
        completionClaimsToolBacked: claimsThisCall.filter((c) => c.toolBacked).length,
        callerAffirmedReadBack: lastAgreement != null,
      };
      // OWNER I3 (D-c, post-call). state.callerNumber is the CONTACT's number
      // on outbound (spec §6.2) -- unconditionally passing it here would let
      // verifyCall text an unverified party (appointment_request_pending,
      // "act" mode) and let recoverOwedBooking write a booking for one. Read
      // at call END, from the runner's own live party (Task 18) -- there is
      // no stamped snapshot to prefer here, unlike the per-effect gate below,
      // because this is a one-shot check at teardown, not a dispatch of
      // something produced earlier in the call. Inbound is unchanged:
      // state.outboundCall is absent there, so this is always true.
      const outboundPartyVerified = state.outboundCall ? Boolean(runner?.party?.verified) : true;
      const verifiedCallerNumber = outboundPartyVerified ? state.callerNumber : null;
      const runVerify = (judgeClaimedDone) => verify({
        // LVX147. The second reader's answer, or undefined when it did not run,
        // failed or timed out. verifyCall unions it with the phrase matcher and
        // can never be made quieter by it, so undefined is a safe default and
        // not a degraded one.
        judgeClaimedDone,
        businessId: state.businessId,
        callId: state.dbCallId,
        config: state.config,
        callerNumber: verifiedCallerNumber,
        writes: writesThisCall,
        claims: claimsThisCall,
        // Refused and never completed. See LVX72 and the two sets above.
        abandoned: abandonedTools,
        // WAS A BOOKING OWED. Structural facts, no prose, no datetime, no name.
        //
        // reconcile() cannot answer this. It is organised around a CLAIM, and the
        // claim ledger records a single generic kind -- `kind: "claim"` -- with no
        // notion of what was claimed. So on call CA422f58 the caller agreed to a
        // booking, no booking row existed, and the verdict came back `ok`:
        // `claims` was 2 and `wroteAnything` was true BECAUSE OF THE CANCELLATION
        // that also happened on that call, so the fabrication test never fired and
        // nobody was told. Verified from that call's own postcall_verify line.
        //
        // a4a0dc0 fixed it by kind-matching claims against writes and was reverted
        // with everything else; restoring it needs per-capability claim vocabulary,
        // which is prose classification and the phrasing treadmill this work exists
        // to get off. These two facts need none of it: a point availability check
        // came back OPEN for a time the caller was actually asked about, and the
        // caller affirmed a read-back. Both are tool traffic and caller audio.
        bookingOwed: {
          agreed: lastAgreement != null,
          pointVerified: runner?.guards?.pointVerifiedCount?.() ?? 0,
          // LISTED slots as well as point-checked ones, because on the call
          // this was written for there were fifteen of the first and none of
          // the second. CA03558d: booking_owed read FALSE while six attempts
          // wrote nothing and the caller was told it was confirmed. See
          // lib/postCallVerify.js, where the two are combined.
          verified: runner?.guards?.verifiedCount?.() ?? 0,
        },
        mode: postCall,
        callSid,
      });

      // -------------------------------------------------------------------
      // RECOVER THE BOOKING FIRST, THEN VERIFY. The ordering IS the design.
      //
      // Every other net in this system ends by telling a human. That is the
      // right fallback and the wrong default: the caller was told they were
      // booked, so the truthful outcome is that they ARE booked.
      //
      // Running recovery first means verifyCall then reads a call that HAS a
      // row: it reports clean, and it sends the caller their confirmation off
      // that row by the one path that already builds messages from the
      // database (LVX29) and already dedupes against a confirmation the call
      // itself sent. The escalation verifyCall would otherwise raise becomes
      // the fallback for a recovery that could not fire -- with no branch
      // anywhere having to say so, because the row's presence is the branch.
      //
      // The slot list is the only thing here that cannot be had later: it
      // lives in this call's guards closure, which is why this runs at
      // teardown and not in the status webhook where the shadow judge does.
      //
      // `runner` and `guards` may legitimately be absent on a call that never
      // got that far, so those are optional -- but verifiedSlotList is called
      // DIRECTLY. A `?.()` on the method is how peekPendingWrite read
      // undefined for a whole build while looking like a working feature.
      //
      // AND IT STARTS FROM transcriptSettled. Both readers below read the
      // transcript, and the last turn's rows are still in flight at this
      // moment -- the turn carrying the agreement and the claim. Without this
      // the recovery can decline `no_transcript`, or judge a truncated one, on
      // a call that had everything it needed. ws.close() below is unaffected
      // and stays immediate; nothing about the socket waits on a database.
      // -------------------------------------------------------------------
      // -------------------------------------------------------------------
      // THE SHADOW JUDGE, WHICH USED TO LIVE IN /twilio/status.
      //
      // It moved here because the evidence it needs is in this closure and
      // cannot get out of it: writesThisCall, the abandoned set,
      // guards.counts(). The status handler could only have them via a
      // migration, and it could not tell which calls to judge anyway -- the
      // `calls` table has no front-end column, `call_state` refuses a fourth
      // shared field in SQL, and /twilio/live-voice falls back to the cascade
      // on any throw, so a per-tenant inference would be wrong on exactly the
      // fallback calls and would silently skip their judge.
      //
      // Deleting the status copy costs nothing real, and that is the argument
      // rather than an apology for it. verifyCall and recoverOwedBooking are
      // invoked from THIS FILE and nowhere else, so postcall_verify is never
      // emitted for a cascade call -- and this judge exists to log its verdict
      // BESIDE the structural check's so the disagreements can be read. A
      // cascade verdict has no other half; it was one model call per cascade
      // call producing an unpairable line.
      //
      // SHADOW ONLY here. In `act` the recovery calls the judge itself, with
      // the same traffic, and running both would bill twice for one answer --
      // the property that makes `act` a replacement for shadow rather than an
      // addition to it. postcall_judge_ran is the denominator, so if this stops
      // firing it reads as zero rather than as normal.
      // -------------------------------------------------------------------
      // -------------------------------------------------------------------
      // LVX147. HELD, NOT DROPPED. Until 2026-09-18 this chain's value went
      // nowhere: the judge answered, the answer was logged, and verifyCall
      // decided on the phrase matcher alone. The matcher then lost three times
      // on three consecutive calls with the judge right each time.
      //
      // `judged` resolves to the judge's verdict or to null, NEVER rejects, and
      // is raced against a timeout below so a slow judge can delay the
      // verification but can never prevent it.
      // -------------------------------------------------------------------
      let judged = Promise.resolve(null);
      if (judgeMode(env) === "shadow") {
        judged = whenTranscriptSettled()
          .then(async () => {
            const rows = await database.withTenantSafe(
              state.businessId,
              () => database.listAppointmentsByCallId(state.dbCallId, state.businessId),
              { operation: "listAppointmentsByCallId", callSid, fallback: null }
            );
            // null is a FAILED READ, not an empty call. Judging it as zero rows
            // would manufacture a booking_missing on a call that booked fine.
            if (rows == null) {
              bumpCounter("postcall_judge_skipped");
              log.error("postcall_judge_skipped", {
                callSid,
                reason: "row_read_failed",
                severity: "warn",
              });
              return null;
            }
            const transcript = await database.withTenantSafe(
              state.businessId,
              () => database.fetchCallTranscript(state.dbCallId),
              { operation: "fetchCallTranscript", callSid, fallback: [] }
            );
            return judge({
              transcript: transcript || [],
              callSid,
              bookedRowCount: rows.filter((r) => r?.status === "scheduled").length,
              toolTraffic,
              mode: "shadow",
            });
          })
          .catch((err) => {
            log.error("postcall_judge_failed", {
              callSid,
              reason: err?.message,
              severity: "warn",
            });
            // null, not a rethrow. A judge that failed must leave the
            // verification running on the matcher alone, which is what this
            // module did for its whole life before today.
            return null;
          });
      }

      whenTranscriptSettled()
        .then(() =>
          // OWNER I3: recoverOwedBooking writes a booking (createAppointmentIfAvailable)
          // regardless of whether callerNumber is present -- only the NAME
          // lookup inside it is gated on the number. Nulling callerNumber
          // alone would still let it book an unverified outbound party with
          // clientPhone: null, which is exactly the write Task 18 exists to
          // prevent. So this is skipped outright, not merely de-identified.
          state.outboundCall && !outboundPartyVerified
            ? null
            : recover({
                businessId: state.businessId,
                callId: state.dbCallId,
                callSid,
                callerNumber: verifiedCallerNumber,
                config: state.config,
                slots: runner && runner.guards ? runner.guards.verifiedSlotList() : [],
                // The same structural fact verifyCall's bookingOwed carries: did the
                // caller affirm a read-back at any point. The recovery reads it ONLY
                // to refuse, exactly as the LVX117 gate does -- its absence means
                // nothing was ever agreed, and no reader's verdict may override that.
                agreed: lastAgreement != null,
                // The same object the shadow judge gets, so the two readers can
                // never be told different stories about the same call.
                toolTraffic,
                mode: judgeMode(env),
              })
        )
        // Never throws by construction; this is the belt to that brace, and it
        // must not stop the verify that follows -- a recovery that failed is
        // exactly when the escalation matters most.
        .catch((err) => {
          log.error("postcall_recover_failed", { callSid, reason: err?.message, severity: "warn" });
          return null;
        })
        // -----------------------------------------------------------------
        // WAIT FOR THE JUDGE, BUT NOT FOREVER. LVX147.
        //
        // The verification is the last thing that can tell anyone a caller was
        // lied to, so nothing may be allowed to stop it -- and "await an LLM
        // call at teardown" is exactly the shape that hangs. The race means a
        // judge that never answers costs the verdict its second reader and
        // nothing else.
        //
        // Counted when the timeout wins, because a silently degraded reader is
        // indistinguishable from a reader that agreed.
        // -----------------------------------------------------------------
        .then(() =>
          Promise.race([
            judged,
            new Promise((resolve) =>
              setTimeout(() => resolve(JUDGE_TIMED_OUT), POSTCALL_JUDGE_WAIT_MS)
            ),
          ])
        )
        .then((j) => {
          if (j === JUDGE_TIMED_OUT) {
            bumpCounter("postcall_judge_wait_timeout");
            log.error("postcall_judge_wait_timeout", {
              callSid,
              waitedMs: POSTCALL_JUDGE_WAIT_MS,
              severity: "warn",
            });
            return runVerify(undefined);
          }
          // `claimedDone`, NOT `claimed_done`. judgeCall returns camelCase and
          // LOGS snake_case, and the first version of this line read the log's
          // name off the object -- so it was undefined on every call and the
          // union silently never happened. Caught on CA5b7e359 because the
          // postcall_verify line carries both readers now:
          //
          //     postcall_judge   claimed_done: true
          //     postcall_verify  claimed_by_judge: FALSE
          //
          // The test that was supposed to prove this wire stubbed the judge with
          // { claimed_done: true } -- a shape invented from the log line rather
          // than taken from the return value -- so it passed against a wire that
          // did nothing. tests/postCallJudge.test.js pins the real key.
          return runVerify(j?.claimedDone === true ? true : undefined);
        })
        .catch((err) =>
          log.error("postcall_verify_failed", { callSid, reason: err?.message, severity: "warn" })
        );
    }

    // OUTBOUND CALLING (Task 20, spec §11). Runs for outbound ONLY --
    // state.outboundCall/state.attemptId are both absent on inbound, so this
    // block is never reached there, and inbound's finish() stays byte-
    // identical (tests/liveOutboundFinish.test.js proves it makes no
    // outbound calls and emits the same summary).
    //
    // Fire-and-forget, exactly like the postcall_verify chain above: finish()
    // runs with the socket already closing, and nothing downstream awaits
    // this. `dialFirstSeconds` is ALWAYS non-null when state.outboundCall is
    // set (built together in onStart).
    //
    // CHAINED AFTER transcriptSettled (fix round 1, item 5): the verify/
    // recover readers below already wait for it before reading the
    // transcript, and this hook did not -- so post-call could run BEFORE the
    // final turn's row was written, and miss exactly the turn most likely to
    // carry "we won't call you again" (the sign-off). Stamping session_
    // finished_at (and so claiming post-call) now waits for the same
    // settling the other readers already trust.
    if (state.outboundCall && state.attemptId) {
      // 2026-10-01, live mode (census trap; ruling R8): dialFirstSeconds is
      // null there, which read as "no first audio, not silent" -- the §13.4
      // record (and its 72 h hold) silently lost. The live controller owns
      // both numbers, on the spec's end-of-speech reading.
      const liveFirst = liveFirstLine ? liveFirstLine.firstReply() : null;
      const firstAudio = liveFirstLine
        ? liveFirst && { from_answer_ms: liveFirst.from_answer_ms, measured: "enqueue" }
        : dialFirstSeconds?.firstAudio() ?? null;
      // Fix round 1, item 3: `isSessionSilent` is only accurate for a
      // CONFIRMED playout. When nothing was ever queued, or a clip was
      // queued but its mark never echoed, a playout echo is now
      // (definitionally, at finish()) never coming -- bound the silence by
      // the session's own end instead of trusting an enqueue time, which
      // understates how long the person actually waited.
      const sessionSilent = liveFirstLine
        ? liveFirstLine.sessionSilent(now())
        : firstAudio?.measured === "playout"
          ? isSessionSilent(firstAudio)
          : dialFirstSeconds
            ? sessionEndSilent({ ...dialFirstSeconds.rawState(), atMs: now() })
            : false;
      const firstAudioMs = typeof firstAudio?.from_answer_ms === "number" ? firstAudio.from_answer_ms : null;
      // Final wave W1 (I2): after the hang-up drain when there was one -- the
      // drained speech's caller row (an opt-out said mid-clip) must exist
      // before the post-call claim reads the transcript.
      whenTranscriptSettled()
        .then(() =>
          database.withTenantSafe(
            state.businessId,
            () => database.finishAttemptSession(state.attemptId, { firstAudioMs, silent: sessionSilent }),
            { operation: "finishAttemptSession", callSid, fallback: null }
          )
        )
        .then(async () => {
          if (!optoutUnverifiedHint) return outboundPostCall.tryClaimByAttempt(state.attemptId, state.businessId);
          // r1: the hint helps only if THIS claim is the one that runs.
          let claimed = false;
          let claimErr = null;
          try {
            claimed = await outboundPostCall.tryClaimByAttempt(state.attemptId, state.businessId, { optoutUnverified: true });
          } catch (err) {
            claimErr = err;
          }
          if (claimed !== true) await retryMarkerAfterLostClaim(claimErr ? "threw" : "not_claimed");
          if (claimErr) throw claimErr;
          return claimed;
        })
        .catch((err) =>
          log.error("outbound_finish_postcall_failed", { callSid, attemptId: state.attemptId, reason: err?.message, severity: "warn" })
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
      // OUTBOUND CALLING (spec §9.3 steps 5-6): the backstop finished playing,
      // so Live's own audio may play again (and a slow-path clip is seeded
      // now, O-8); the first-audio mark's echo is the playout time the G2
      // metric is taken at (O-7). A no-op on inbound.
      dialFirstSeconds?.onMark(msg.mark.name, now());
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
