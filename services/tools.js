import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import {
  listAppointmentsByCaller,
  updateAppointmentStatus,
  updateAppointment,
  createAppointment,
  createAppointmentIfAvailable,
  countScheduledOverlapping,
  listScheduledBetween,
  getAppointmentById,
  recordSmsConsent,
  withTenantSafe,
} from "./db.js";
import { executeIntegration } from "./integrations.js";
import { packForTool } from "../capabilities/index.js";
import { unknownToolResult } from "../lib/capabilities/results.js";
import { bumpCounter } from "../lib/voice/metrics.js";
import { checkRequirements, capabilityConfig } from "../lib/capabilities/requirements.js";
import { shouldConfirmSpelling, spellPolicy } from "../lib/nameQuality.js";
import { spellMissCap } from "../lib/voice/replyState.js";
import { getStrings } from "../lib/voice/strings.js";
import {
  stripFillers,
  isHesitationOnly,
  isUnusableTranscript,
  isAffirmative,
} from "../lib/transcriptUtils.js";

/**
 * Ask for a spelling before writing a name into a record.
 *
 * ON by default: the cost is one refused tool call per call at most (the gate
 * opens once the call's single spelling request is spent), and the thing it
 * protects is the row the business keeps. `false` turns it off without a
 * deploy if it proves more friction than it is worth.
 *
 * Since 2026-08-29 this is also the ONLY thing that can request a spelling.
 * Three separate prompt sections used to ask as well, each with its own
 * uncoordinated "at most once" caveat, and none of them counted — which is how
 * a caller came to be asked to spell their name three times in one call. Prose
 * cannot hold a budget; a counter can.
 */
const CONFIRM_HARD_NAMES = process.env.VOICE_CONFIRM_HARD_NAMES !== "false";

/**
 * LVX95's write-order gate, and its off switch. Every guard on this path has one.
 *
 * Read per call rather than captured at module load so a revision can be turned
 * off by an env change without a rebuild -- the same reason LIVE_CLAIM_GUARD
 * and LIVE_REPEAT_CUT are read the way they are.
 */
const writeOrderGateOff = () => process.env.LIVE_WRITE_ORDER_GATE === "off";

/**
 * How many times the write-order gate may refuse the same pack in one call.
 *
 * A CEILING, not a policy, and it is what stops a phrasing list becoming a
 * livelock. confirmReadBackRe cannot be completed -- the model can always ask
 * in words nobody listed -- and an unrecognised read-back means refuse, ask,
 * get a yes, refuse again, forever. The spelling gate has exactly this shape
 * and solved it exactly this way; `write_order_gate_ceiling` is the number that
 * says the list is too narrow.
 *
 * Two, because one refusal is the intended cost of a write with no read-back
 * and the second covers a model that rephrased into something unrecognised.
 * Past that the caller has been asked twice and is being made to wait on our
 * vocabulary rather than on their own decision.
 */
const WRITE_ORDER_MAX_REFUSALS = 2;

/**
 * How many times ONE ATTEMPTED WRITE may be refused, counting every gate.
 *
 * ---------------------------------------------------------------------------
 * Why a second ceiling, when both gates already have one
 * ---------------------------------------------------------------------------
 *
 * Call CA9e3788, 2026-09-10. Four `book_appointment` attempts, all refused, no
 * row created, and the caller told "that's all set":
 *
 *   19:13:25  write-order refused
 *   19:13:52  spelling gate refused
 *   19:14:43  write-order refused
 *   19:14:51  spelling gate refused        ...and the model gave up.
 *
 * WRITE_ORDER_MAX_REFUSALS is 2 and spellMissCap() is 2, so on paper the caller
 * could be asked at most twice. In practice each gate SAW only two of the four
 * attempts, counted to two, and the caller sat through all four. Every escape
 * hatch here is keyed to its own gate's refusals; nothing was counting the
 * thing the caller actually experiences.
 *
 * LVX104's rule one level up: an escape hatch has a population, and this
 * population spans two gates that cannot see each other.
 *
 * Three, not two: it must not fire BEFORE either gate's own ceiling in the
 * ordinary single-gate case, or it would silently replace them and weaken the
 * guard. It exists only for the alternating case, where it is the sole bound.
 */
function writeAttemptMaxRefusals() {
  const v = Number.parseInt(process.env.VOICE_WRITE_ATTEMPT_MAX_REFUSALS, 10);
  return Number.isFinite(v) && v >= 1 && v <= 10 ? v : 3;
}


// ---------------------------------------------------------------------------
// tools.js — Gemini tool-call executor.
//
// Two tools are engine-owned and handled here: set_call_intent and end_call
// drive the step machine itself rather than doing anything for a business, so
// they exist on every call regardless of configuration.
//
// Exception: under VOICE_INTENT_MARKER, set_call_intent is not declared to the
// model at all — the intent arrives in the reply text instead
// (lib/intentMarker.js), and services/gemini.js synthesizes the same
// stateEffects shape. The case below stays as a defensive fallback; the model
// simply has no way to reach it in that mode.
//
// Everything else dispatches to the capability pack that owns the tool name
// (capabilities/index.js), falling back to the business's own webhook
// integrations for names no pack claims.
//
// Packs deliberately import nothing from services/. They receive their data
// surface through ctx.deps, assembled below. Two reasons: services/db.js
// imports the capability registry for its reserved-name list, so a pack
// importing supabase back would be a load-order-dependent cycle; and injection
// lets a pack's execution paths be tested without mocking modules.
// ---------------------------------------------------------------------------

/**
 * The data surface handed to capability packs. Kept explicit — a pack can only
 * reach what is listed here, so widening a capability's blast radius is a
 * visible edit rather than a new import inside a pack.
 *
 * Exposed as getters, not plain properties, so each binding is resolved when a
 * pack actually uses it. A plain object literal would resolve all of them while
 * this module is evaluated, which breaks every test that partially mocks
 * services/db.js: vitest's mock throws on access to an export the mock
 * does not define, so a suite that never books an appointment would still fail
 * at import time on createAppointment. Lazy access mirrors the original switch,
 * where each branch referenced only what that branch needed.
 */
const CAPABILITY_DEPS = {
  get createAppointment() {
    return createAppointment;
  },
  get createAppointmentIfAvailable() {
    return createAppointmentIfAvailable;
  },
  get countScheduledOverlapping() {
    return countScheduledOverlapping;
  },
  get listScheduledBetween() {
    return listScheduledBetween;
  },
  get listAppointmentsByCaller() {
    return listAppointmentsByCaller;
  },
  get getAppointmentById() {
    return getAppointmentById;
  },
  get updateAppointmentStatus() {
    return updateAppointmentStatus;
  },
  get updateAppointment() {
    return updateAppointment;
  },
  get recordSmsConsent() {
    return recordSmsConsent;
  },
  get executeIntegration() {
    return executeIntegration;
  },
  get captureException() {
    return captureException;
  },
  get log() {
    return log;
  },
};

/**
 * Execute a single Gemini function call and report the state effects the
 * caller (getReplyStreaming) should apply to its turn accumulators.
 *
 * @param {{id: string, name: string, args: object}} fc - one entry from response.functionCalls
 * @param {object} ctx - turn/call context
 * @param {string|null} [ctx.businessId]
 * @param {string|null} [ctx.callerPhone]
 * @param {string|null} [ctx.callId]
 * @param {Array} [ctx.integrations]
 * @param {object} [ctx.capabilityState] - per-capability scratchpad, keyed by pack id
 * @param {string} [ctx.step] - current call step (e.g. "confirm", "ending") — gates end_call
 * @param {boolean} [ctx.transferAllowed] - gates request_transfer
 * @param {object} [ctx.config] - normalised business config
 * @param {object} [ctx.depsOverride] - when present, replaces CAPABILITY_DEPS as the
 *   data surface handed to a capability pack's execute (e.g. an eval/benchmark
 *   harness supplying fakes). Ignored by the engine-owned set_call_intent/end_call
 *   branches and by executeWebhookTool, neither of which read ctx.deps.
 * @returns {Promise<{
 *   functionResponse: {id: string, name: string, response: object},
 *   stateEffects: {
 *     intentArgs?: object|null,
 *     endCallArgs?: object|null,
 *     endCallRefusal?: "hesitation"|"generic"|null,
 *     transferRequested?: {reason: string|null}|null,
 *     toolResult?: {name: string, success: boolean, message: string},
 *     toolCallEvent?: {name: string, args: object, silent?: boolean}|null,
 *     capabilityEffects?: Array<{capability: string, type: string, data?: object}>,
 *     capabilityState?: Record<string, object|null>,
 *   }
 * }>}
 */
export async function executeToolCall(fc, ctx) {
  switch (fc.name) {
    case "set_call_intent": {
      const intentArgs = fc.args ?? null;
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          intentArgs,
          toolResult: { name: fc.name, success: true, message: "How can I help you with that?", callerSafe: true },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    case "end_call": {
      // This gate exists to stop the assistant hanging up before the caller has
      // had a chance to say they don't need anything else. It was doing that
      // job far too well: it was unreachable for most calls.
      //
      // step reaches "confirm" from exactly three places — the appointments and
      // quotes packs. A message-taking call never got there, and an
      // informational call ("what are your hours?") ran no tools at all, so
      // neither the step nor the action flag could ever unlock this. The model
      // said goodbye (already spoken to the caller by then), called end_call,
      // was refused, and nothing armed a close. That is the ~90% of goodbyes
      // that left the line open until the silence ladder fired half a minute
      // later.
      //
      // Four ways in, each a genuine "the assistant has done its job" signal:
      //   - confirm/ending: the step machine says we are wrapping up.
      //   - completedActionThisTurn: an earlier FC round of THIS turn already
      //     booked/cancelled/rescheduled/recorded. The step machine only
      //     advances after the whole turn, so without this the model could
      //     never wrap up cleanly in the same turn as the action.
      //   - completedActionThisCall: it did so on an EARLIER turn. A caller who
      //     books and then chats for a turn before saying goodbye is the
      //     ordinary case, not an edge case.
      //   - callerTurnCount >= 2: a real back-and-forth happened. Covers the
      //     informational call, where no tool will ever run. The prompt already
      //     requires asking "is there anything else?" and hearing a no before
      //     calling this, so the model is not reaching here on turn one — and
      //     the threshold keeps a mis-fired end_call on the opening turn from
      //     dropping a caller who has not been helped yet.
      const wrappingUp = ctx?.step === "confirm" || ctx?.step === "ending";
      const didSomething = ctx?.completedActionThisTurn || ctx?.completedActionThisCall;
      const hadConversation = Number(ctx?.callerTurnCount) >= 2;

      // A HESITATION IS NOT AN ANSWER, and it outranks all three gates above.
      //
      // Observed on a real call, 2026-09-03: the assistant asked "is there
      // anything else?", the caller said "umm", and the line closed while they
      // were still thinking. From the caller's side the call was hung up on
      // them mid-word.
      //
      // The cascade cannot reach this state. Deepgram's text goes through
      // cleanTranscript, which strips "um"/"uh"/"hmm", so a pure hesitation
      // arrives as an empty turn and never becomes an answer. On the Live path
      // the MODEL is the ASR and there is no text stage, so the filler arrives
      // verbatim and gets interpreted. Same guard, same word list, applied
      // where the pipeline no longer applies it for us.
      //
      // Deliberately narrow: it fires only when the caller said something that
      // is ENTIRELY filler. Silence is not covered -- an empty lastCallerText
      // means the caller said nothing at all, which the silence ladder owns,
      // and treating it here would stop a legitimate close after a goodbye.
      //
      // stripFillers here, and isHesitationOnly for WRITES below. The two gates
      // want different predicates and the difference is not an oversight.
      //
      // stripFillers' list is wider than "hesitation": it also swallows "Okay",
      // "Right", "So", "Mm-hmm". For a write that is wrong -- "Okay" is the
      // commonest way anyone agrees to anything on a phone call, and refusing
      // to book on it would be its own defect. For a HANG-UP it is right, and
      // for a reason worth stating: the question this gate follows is "is there
      // anything else I can help you with?", so an affirmative grunt means
      // there IS something else, and a vague "okay" is not a no. Being
      // conservative here costs one turn and asks again; being wrong ends the
      // call on someone who was still talking.
      //
      // NOTE this gate only became reachable on 2026-09-04, when the Live tool
      // context was finally wired to carry lastCallerText. Its behaviour on
      // "Okay." is therefore new in practice though old in the code, and is on
      // the rig call plan to be heard rather than assumed.
      const lastCallerText = typeof ctx?.lastCallerText === "string" ? ctx.lastCallerText : "";
      const heardOnlyHesitation = lastCallerText.trim() !== "" && stripFillers(lastCallerText) === "";

      // ---------------------------------------------------------------------
      // LVX72, COUNT ONLY. This refuses nothing, and that is the decision.
      //
      // The defect: a write is refused, the caller answers the refusal, the
      // model never retries and announces the change as done. postcall_verify
      // now DETECTS it -- verdict write_abandoned, seen both firing and staying
      // silent on real calls -- but detection happens after the caller has hung
      // up believing something happened. The clean prevention is to refuse the
      // hang-up once while an abandoned write is outstanding.
      //
      // Not built yet, on purpose. That gate carries a real hair-trigger risk:
      // a caller who genuinely changed their mind mid-change would be held on
      // the line, and this codebase has already paid for a guard with a hair
      // trigger -- LVX21 delivered 0.5 s of audio in 25 seconds. The question
      // that decides whether refusing is safe is "how often would a real call
      // have been held?", and nothing could answer it. Now something can.
      //
      // Count first, act once the counter says how often it fires when nothing
      // is wrong. Same ladder live_claim_without_action climbed.
      //
      // Shared with the cascade, which passes no abandonedWrites at all: the
      // field is undefined there, the check no-ops, and
      // end_call_abandoned_check_ran stays 0 -- which is the honest reading,
      // not a silent pass.
      // ---------------------------------------------------------------------
      if (Array.isArray(ctx?.abandonedWrites)) {
        // The positive twin. Distinguishes "no abandoned write" from "the
        // check never ran", which is the whole reason this file's other
        // fault-only counters were unreadable.
        bumpCounter("end_call_abandoned_check_ran");
        if (ctx.abandonedWrites.length > 0) {
          bumpCounter("end_call_would_refuse_abandoned");
          log.error("end_call_abandoned_write_outstanding", {
            callId: ctx?.callId ?? null,
            // Tool names only. Nothing here is caller data.
            tools: ctx.abandonedWrites,
            severity: "warn",
          });

          // -----------------------------------------------------------------
          // IT REFUSED FOR ONE CALL, AND THE CALL GOT WORSE. Reverted to
          // counting on 2026-09-04, same day it shipped.
          //
          // The evidence that justified shipping it was 0, 0, 1 across three
          // calls -- two true negatives and one true positive. The evidence
          // from USING it, on call 4, overturned that. The mechanics were
          // perfect: end_call_refused_abandoned 1, would_refuse 2, the latch
          // held and allowed the second attempt. What the caller heard was:
          //
          //   caller> No, that's everything. Thanks.
          //   asst  > You're all set then. Thanks for calling Brightwork
          //           Family Dental, and have a great weekend.
          //           [refused -- and the model then said nothing]
          //           [~6 s of dead air]
          //   asst  > I'm still here whenever you're ready.     <- a nudge
          //
          // booked_rows was 0. So the caller was told "you're all set", was
          // held on the line anyway, and got dead air and a nudge on top. That
          // is strictly worse than letting them hang up, which is at least
          // brief.
          //
          // WHY IT COULD NEVER HAVE WORKED, and this is the part worth keeping:
          // end_call's own declaration says "You MUST write your warm sign-off
          // in the SAME response as this call." THE GOODBYE IS ALREADY SPOKEN
          // BEFORE THIS FUNCTION RUNS. No refusal can retract it, and no
          // instruction in a refusal can stop it -- the same call proved it
          // twice, because the hesitation branch's "do NOT say goodbye" was
          // ignored for exactly the same reason.
          //
          // A refusal message is a request. Preventing a caller being told
          // something untrue needs something that does not require the model's
          // cooperation, which is why the retry is being made OURS -- see the
          // spelling-gate stash below.
          //
          // The counters stay. They are what made this decidable in both
          // directions, and they are what will show whether the retry works.
          // -----------------------------------------------------------------
        }
      }

      if (!heardOnlyHesitation && (wrappingUp || didSomething || hadConversation)) {
        const endCallArgs = fc.args ?? {};
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
          stateEffects: {
            endCallArgs,
            // Spoken ONLY when the model ended the call without writing its
            // own goodbye — see the zero-text fallback in services/gemini.js.
            // It used to be a bare "Goodbye!", which is what a caller heard on
            // 2026-08-30 after the post-end_call round was removed: that round
            // was where a warm ending used to (sometimes) come from, and it was
            // also where the DUPLICATE goodbye came from. Removing it was right;
            // leaving the floor at one cold word was not.
            toolResult: {
              name: fc.name,
              success: true,
              message: getStrings(ctx?.config).signOff(ctx?.config?.businessName || "us"),
              callerSafe: true,
            },
            toolCallEvent: { name: fc.name, args: fc.args },
          },
        };
      }
      // WHICH gate refused, recorded as a fact rather than inferred later.
      //
      // Until now only the hesitation branch had a counter. The generic branch
      // -- no wrapping-up step, no completed action, fewer than two caller
      // turns -- had none, so on 2026-09-09 two refusals left no trace anywhere
      // except `tool_duration success=false`, which is a per-tool timing line
      // and not a decision record. LVX96 was found by reading a twenty-five
      // second call by hand for exactly that reason.
      //
      // `refusalKind` is also handed back in stateEffects so the Live front-end
      // can put it in the per-call summary: bumpCounter writes to process
      // memory that every call on the instance shares and the next deploy
      // zeroes, so a counter alone cannot answer "why did the gate refuse on
      // THAT call".
      const refusalKind = heardOnlyHesitation ? "hesitation" : "generic";
      bumpCounter(heardOnlyHesitation ? "end_call_refused_hesitation" : "end_call_refused_generic");
      // LVX76. This text produced the worst twenty seconds of the 2026-09-04
      // call, and both faults are in the wording rather than in the decision.
      //
      // THE REFUSAL WAS RIGHT. The caller said "Okay" meaning "go on", and they
      // went on to book an appointment. What the model was handed was:
      //
      //   "The caller has not answered yet — all they said was a hesitation
      //    ("um", "uh") ... Do not end the call. Wait, or ask again gently."
      //
      // 1. IT IS FALSE. stripFillers swallows "Okay" as well as "um" and "uh",
      //    which the note above says in as many words and which is CORRECT for a
      //    hang-up. But it means this message describes an acknowledgement as a
      //    hesitation, and a model handed a false description of its input
      //    reasons onward from it.
      // 2. "ASK AGAIN" NAMES NO OBJECT. The previous turn had ended in a
      //    question, so "ask again" was read as "deliver that turn again": it
      //    re-read a forty-word answer verbatim. The owner, asked directly,
      //    confirmed hearing it twice in full.
      //
      // And having been told the call was not ending, it said goodbye anyway --
      // "Brightwork Family Dental wishes you well", which is not our signOff and
      // appears nowhere in this repository. The gate held the line open while
      // the model closed it in the caller's ears.
      //
      // The rewrite follows LVX34's shape, the house pattern for a refusal: say
      // it is not a failure, say what is actually true, say exactly what to do,
      // and bound it. It describes what was heard without claiming to know what
      // it meant, and it names the two things that must not happen, because on
      // a real call both of them did.
      // SECOND REVISION, after call 2. The first one removed the farewell and the
      // forty-word re-read, and the owner confirmed both were gone. What it did
      // NOT remove was the caller hearing the same question twice, and that
      // turned out to be structural rather than phrasing.
      //
      // THE MODEL HAS ALREADY SPOKEN BY THE TIME THIS ARRIVES. end_call's own
      // declaration requires it: "You MUST write your warm sign-off in the SAME
      // response as this call." So a refused end_call always follows a turn the
      // caller has already heard. Telling the model to "say one short sentence
      // asking whether there is anything else" then asks it to say a thing it
      // usually just said -- and on call 2 it said it twice, rephrased:
      //
      //   "Great. Is there anything else I can help you with in terms of our
      //    opening hours or services?"
      //   "Great. Is there anything else I can help you with regarding our
      //    opening hours or services?"
      //
      // Two generations concatenated into one turn, both heard. Call 1 did the
      // same thing under the old wording, hidden behind the louder farewell.
      //
      // So the instruction is now CONDITIONAL on what it has already said, and
      // silence is an allowed outcome. The cost of getting that wrong is bounded
      // by the silence ladder, which nudges at 6-10 s; the cost of the other
      // error is a caller asked the same question twice on every refusal.
      const alreadyAsked =
        "If you have ALREADY asked in this turn whether there is anything else, say NOTHING " +
        "further — just wait for their answer. Only if you have not asked yet, say ONE short " +
        "sentence asking, then stop and wait.";
      const message = heardOnlyHesitation
        ? "[not caller speech] NOT A FAILURE — the caller is still on the line and the call is " +
          "still open. What they said was brief (\"okay\", \"mm\", \"uh\") and does not settle " +
          "whether they are finished. Do NOT say goodbye, do NOT sign off, and do NOT repeat " +
          "anything you have already said. " + alreadyAsked
        : "[not caller speech] NOT A FAILURE — the call is still open and the caller is still " +
          "on the line. Do NOT say goodbye and do NOT repeat anything you have already said. " +
          alreadyAsked;
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
          // Which gate said no. The cascade ignores this field; the Live
          // front-end folds it into live_call_summary.
          endCallRefusal: refusalKind,
          toolResult: {
            name: fc.name,
            success: false,
            // Note the split: `message` above is the refusal shown to the
            // MODEL, this is the line meant for the caller. Only the latter is
            // ever spoken.
            message: "Is there anything else I can help you with?",
            callerSafe: true,
          },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    default: {
      const pack = packForTool(fc.name);
      if (pack && typeof pack.execute === "function") {
        // Was the answer already sitting in the call-start snapshot?
        //
        // Counted, not acted on. The tool still runs and still returns live
        // data — this only records how often it need not have, because the
        // fix (serve the lookup from ctx.callerContext, or teach the model it
        // already has the answer) is worth an extra model round-trip per
        // occurrence and nobody knows what that rate is. Decide from the
        // counters, not from the intuition that it must be high.
        if ((pack.callerLookupTools || []).includes(fc.name)) {
          const warm = (ctx?.callerContext?.upcomingAppointments || []).length > 0;
          bumpCounter(warm ? "lookup_tool_context_warm" : "lookup_tool_context_cold");
        }
        // Configured requirements are enforced HERE, before the pack runs, so
        // every capability inherits them and no pack author can forget to
        // check. A refusal is returned to the model as an instruction; the
        // action does not happen.
        //
        // Only caller-visible writes are gated. Gating a lookup would stop the
        // receptionist finding the record it needs in order to ask the caller
        // about it — locking the door and the key inside.
        if ((pack.actionTools || []).includes(fc.name)) {
          // DID THE CALLER ACTUALLY AGREE TO THIS, AND DID WE HEAR THEM?
          //
          // Above every other gate, because both questions are about whether
          // there is anything to act on at all. A spelling gate on a write the
          // caller never authorised is checking the spelling of a decision
          // nobody made.
          //
          // Two failures from the same evening, both on the Live front-end and
          // both structurally impossible on the cascade, where Deepgram text
          // passes through cleanTranscript before the model ever sees it:
          //
          //   LVX56 — the caller said "Ah!" and a reschedule AND a name change
          //   were executed and announced as done. The LVX45 fix threaded the
          //   caller's last utterance into the end_call gate ONLY, so the
          //   hang-up was protected and every write was not.
          //
          //   LVX50 — an English turn was transcribed as "에레는", answered
          //   "Great, 8 AM on Tuesday, September 8th, is available", and booked
          //   from. The danger is specific to this seam: a misheard time gives a
          //   wrong row, an invented reading of noise gives a row nobody asked
          //   for.
          //
          // No per-tool exception list. The exception is lexical and lives in
          // isHesitationOnly, which knows that "Okay" and "Mm-hmm" are answers
          // and "Ah!" is not -- stripFillers does not, and a gate built on it
          // would refuse a booking on the commonest confirmation in English.
          //
          // Cost when it fires is one turn: the refusal is model-facing, with a
          // caller-safe line beside it, so the assistant asks a plain question
          // instead of writing. Never dead air.
          //
          // The cascade never sets lastCallerText, so both predicates see "" and
          // neither branch can fire there -- the same construction that keeps
          // this file byte-identical for tier 3 today.
          const lastCallerText = typeof ctx?.lastCallerText === "string" ? ctx.lastCallerText : "";
          if (lastCallerText.trim() !== "") {
            const consentRefusal =
              isHesitationOnly(lastCallerText)
                ? {
                    counter: "write_refused_hesitation",
                    message:
                      "[not caller speech] The caller has not agreed to this yet — all they said was a " +
                      'hesitation ("um", "uh", "ah"). That is someone thinking, not someone saying yes. ' +
                      "Do not write anything. Ask them plainly whether you should go ahead, and wait for a " +
                      "real answer.",
                    callerLine: "Sorry — did you want me to go ahead with that?",
                  }
                : isUnusableTranscript(lastCallerText)
                  ? {
                      counter: "live_unusable_transcript",
                      message:
                        "[not caller speech] The caller's last turn did not transcribe as usable speech, so " +
                        "you do not know what they said. Do not write anything and do not guess at what they " +
                        "meant. Tell them you did not catch that and ask them to say it again.",
                      callerLine: "Sorry, I didn't catch that — could you say it again?",
                    }
                  : null;
            if (consentRefusal) {
              bumpCounter(consentRefusal.counter);
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { success: false, message: consentRefusal.message },
                },
                stateEffects: {
                  // silent, for the same reason the spelling gate's event is:
                  // nothing ran, so the session must not narrate work that was
                  // declined. The event still goes out so metrics and the
                  // transcript record that the model tried.
                  toolResult: {
                    name: fc.name,
                    success: false,
                    message: consentRefusal.callerLine,
                    callerSafe: true,
                  },
                  toolCallEvent: { name: fc.name, args: fc.args, silent: true },
                },
              };
            }
            // The positive half. Without it a clean call and a call that never
            // attempted a write both read zero on the refusal counters, which
            // is precisely how LVX45 sat in the tree looking fixed.
            bumpCounter("write_consent_checked");

            // ---------------------------------------------------------------
            // DID THE CONFIRMATION COME BEFORE THE WRITE? LVX95.
            //
            // Call be9bd6, 2026-09-09, the first Live call able to cancel
            // anything. Three cancellations committed at 04:53:13; the
            // confirmation was asked at 04:53:27 and end_call came six seconds
            // later, without waiting for the answer:
            //
            //   04:53:13  cancel_appointment_db  success=true   x3
            //   04:53:27  "Just to confirm, you'd like to cancel all three?"
            //   04:53:33  end_call
            //
            // Every claim on that call was TRUE. Three tools ran, three rows
            // changed, tool_duration.success was true on all three. The defect
            // is ordering: the caller heard a safeguard being applied that had
            // already been overtaken by the write. Had they answered no, there
            // was nothing left to stop -- cancel_appointment_db is an UPDATE
            // that had already returned three rows, and a cancellation is not
            // recoverable by the caller.
            //
            // WHY NOT confirmBeforeWrite. That requirement exists and defaults
            // off, and turning it on does not fix this: enforcement is a tool
            // ARGUMENT the model sets about itself
            // (lib/capabilities/requirements.js:402), so nothing verifies that
            // a read-back happened, that the caller answered, or that the
            // answer was yes. It is an honour system, and this call is the
            // evidence about the honour -- a model that will narrate a
            // confirmation after the fact is a model that will set the flag
            // before it.
            //
            // BOTH HALVES ARE OBSERVED, NEITHER IS ASSERTED:
            //   - the assistant's PREVIOUS completed turn put the action to the
            //     caller (ctx.lastReplyText, threaded from the engine), and
            //   - the caller's answer reads as agreement (isAffirmative, built
            //     from their own transcribed words).
            // The model cannot set either one by choosing an argument.
            //
            // SCOPE: every action tool, on every tenant, regardless of
            // configuration. The owner's decision, 2026-09-09. The cost is a
            // two-turn exchange on tenants that never asked for one, and the
            // three bounds below are what make that survivable: a per-call
            // ceiling, an env off switch, and a would-refuse counter shipped
            // beside the refusal so its firing rate is readable from the first
            // call rather than reconstructed afterwards.
            //
            // The cascade never sets lastCallerText, so this whole block is
            // unreachable there and tier 3 is byte-identical -- the same
            // construction the consent gate above relies on.
            // ---------------------------------------------------------------
            // A CHANGE TOOL WITH NOTHING TO CHANGE IS NOT A CONSENT PROBLEM.
            //
            // Call CA0c8ce7, 2026-09-10: the model claimed a booking that had
            // not happened, believed itself, and called correct_appointment_name
            // twice on a row that did not exist. This gate refused both -- and
            // its refusal says "read the details back and ask whether to go
            // ahead", which is advice for a write that could succeed. The model
            // asked again, was refused again, and ended up telling the caller
            // "I'm not sure why it's not updating" and offering a callback.
            //
            // The pack already knows the operation is impossible and has the
            // words for it. Skipping the consent question here lets it say so.
            // Nothing is released by this: the tool still refuses, with a reason
            // the model can act on.
            const hasTarget = typeof pack.hasWriteTarget === "function" ? pack.hasWriteTarget(fc, ctx) : true;
            if (!hasTarget) bumpCounter("write_skipped_no_target");
            const lastReplyText = typeof ctx?.lastReplyText === "string" ? ctx.lastReplyText : "";
            const S = getStrings(ctx?.config);
            const readBackMade = Boolean(lastReplyText && S.confirmReadBackRe?.test(lastReplyText));
            const callerAgreed = isAffirmative(lastCallerText);

            // The measurement, always, whatever the gate then does. Read
            // against write_consent_checked: this is how often a write arrives
            // with a read-back behind it and how often it does not, and it
            // keeps reporting after the gate is turned off.
            bumpCounter(readBackMade ? "write_confirm_readback_prev_turn" : "write_confirm_readback_missing");

            const orderScratch = ctx?.capabilityState?.[pack.id] || {};
            // Every gate below shares this. See writeAttemptMaxRefusals.
            const attemptBudget = writeAttemptBudget(ctx, pack.id, fc);
            // ---------------------------------------------------------------
            // THE CEILING COUNTS ATTEMPTS AT ONE PROPOSAL, NOT REFUSALS IN A
            // CALL. Corrected 2026-09-09, on the call that first spent it.
            //
            // The ceiling exists for a LIVELOCK: the model keeps proposing the
            // same thing, we keep failing to recognise consent, and the caller
            // repeats themselves forever. That is a real risk and it needs an
            // escape.
            //
            // What it actually fired on was a caller in mid-negotiation:
            //
            //   A: "...you're booking a second appointment? Who is it for?"
            //   C: "You can use the same name. I actually do Nitin Dodla."
            //      -> refused: read-back recognised, no agreement. CORRECT.
            //   A: "You're booking another for Nithin Dodla... Shall I confirm?"
            //   C: "Yeah, actually, could you change the name to <...>?"
            //      -> refused: same reason. ALSO CORRECT.
            //   ...ceiling spent, third write released with no agreement at all.
            //
            // Two correct refusals burned the whole budget, and the write that
            // followed landed on a turn whose only content was the caller
            // spelling a name. The guarantee the gate exists for -- the caller
            // said yes to THIS action, immediately before it -- was not met.
            //
            // Keying the budget to the PROPOSAL fixes all three cases at once:
            //
            //   read-back not recognised  -> key is null every time, so the
            //     budget depletes and the escape still works.
            //   consent not recognised (a mis-transcribed "yes" -- and today
            //     proved the transcript can drop a caller turn entirely) -> the
            //     model re-reads the SAME proposal, same key, budget depletes,
            //     escape still works.
            //   caller changing their mind -> every read-back is a NEW
            //     proposal, the budget resets, and the gate keeps its teeth for
            //     as long as the caller keeps moving. Which is correct: there
            //     is no livelock when the caller is the one changing things.
            //
            // A HASH, not the sentence. This lands in capabilityState, which is
            // per-call memory rather than a log, but the read-back carries the
            // caller's name and appointment time and there is no reason to keep
            // it once a number will do.
            const readBackKey = readBackMade ? textFingerprint(lastReplyText) : "none";
            const sameProposal = orderScratch.writeOrderReadBackKey === readBackKey;
            const orderRefusals = sameProposal ? Number(orderScratch.writeOrderRefusals) || 0 : 0;
            // Per CALLER TURN, not per tool round, for the reason written on
            // the spelling gate below: gemini.js rebuilds ctx from merged
            // capabilityState after every round, so a model calling the same
            // tool three times inside one turn would burn the whole budget
            // without the caller ever being asked anything.
            const orderCallerTurn = Number(ctx?.callerTurnCount) || 0;
            const orderRefusalIsNew = orderScratch.writeOrderRefusedTurn !== orderCallerTurn;

            if (hasTarget && (!readBackMade || !callerAgreed)) {
              bumpCounter("write_order_would_refuse");
              if (orderRefusals >= WRITE_ORDER_MAX_REFUSALS) {
                // THE CEILING RELEASES THE WRITE, and says so. A gate that can
                // refuse forever holds a caller on the line over our own
                // vocabulary; LVX21 is what a hair trigger on this path costs.
                bumpCounter("write_order_gate_ceiling");
                log.error("write_order_gate_ceiling", {
                  callId: ctx?.callId ?? null,
                  tool: fc.name,
                  refusals: orderRefusals,
                  severity: "warn",
                });
              } else if (attemptBudget.spent) {
                // NOT this gate's own ceiling -- the caller has now been
                // refused three times for this one booking, by whichever gates
                // happened to be looking. See writeAttemptMaxRefusals.
                bumpCounter("write_attempt_budget_released");
                log.error("write_attempt_budget_released", {
                  callId: ctx?.callId || null,
                  tool: fc.name,
                  gate: "write_order",
                  refusals: attemptBudget.refusals,
                  severity: "warn",
                });
              } else if (!writeOrderGateOff()) {
                bumpCounter("write_order_refused");
                // Tool name and which half failed. Nothing here is caller data:
                // the two booleans say whether a read-back was recognised and
                // whether the answer parsed as agreement, never what was said.
                log.error("write_order_refused", {
                  callId: ctx?.callId ?? null,
                  tool: fc.name,
                  readBackMade,
                  callerAgreed,
                  severity: "warn",
                });
                // Worded as an unfinished step, following LVX34's shape: say it
                // is not a failure, say what is true, say exactly what to do,
                // and bound it. A refusal that reads as "this cannot be done"
                // is how the model came to offer a callback instead of asking
                // the one question it had been asked to ask.
                // TWO REFUSALS, NOT ONE, because they need opposite things.
                //
                // On call CA6b662e the model asked "Is that correct?" and called
                // book_appointment SIXTEEN MILLISECONDS later, in the same turn.
                // The caller had not been given a chance to agree, so the gate
                // refused — correctly — and this message then told it to read
                // the details back and ask, which it did a second time. The
                // caller confirmed the same booking twice and was told in
                // between that the booking had not gone through.
                //
                // When the read-back HAS happened and only the yes is missing,
                // asking for another read-back is the defect. Say what is
                // actually missing instead: the caller's answer, which nobody
                // has waited for.
                const message = readBackMade
                  ? `[not caller speech] NOT A FAILURE — nothing is wrong and nothing needs redoing. ` +
                    `You have ALREADY read these details back to the caller; do not read them back ` +
                    `again and do not ask them to confirm a second time. You called this before they ` +
                    `had answered. WAIT for their reply, and when they agree, call this again with the ` +
                    `same details. Do not tell the caller anything went wrong, do not say the booking ` +
                    `failed, and do not offer a callback or a message.`
                  : `[not caller speech] NOT A FAILURE — this is still going ahead, it just needs the ` +
                    `caller's go-ahead first. Read the details back to them in one short sentence — what ` +
                    `you are about to do, and when — and ask whether to go ahead. Wait for their answer. ` +
                    `If they say yes, call this again with the same details. Do not tell the caller ` +
                    `anything went wrong and do not offer a callback.`;
                return {
                  functionResponse: {
                    id: fc.id,
                    name: fc.name,
                    response: { success: false, message },
                  },
                  stateEffects: {
                    // silent, like the spelling gate's: nothing ran, so the
                    // session must not narrate work that was declined.
                    toolResult: {
                      name: fc.name,
                      success: false,
                      message: "Just to confirm before I do that — shall I go ahead?",
                      callerSafe: true,
                    },
                    toolCallEvent: { name: fc.name, args: fc.args, silent: true },
                    capabilityState: {
                      [pack.id]: {
                        // The key is written on EVERY refusal, even one that
                        // does not spend a turn's budget: it is what tells the
                        // next attempt whether this is the same proposal or a
                        // new one, and that question is independent of whose
                        // turn it is.
                        writeOrderReadBackKey: readBackKey,
                        // The shared count, so the spelling gate's
                        // refusals and this one land in the same total.
                        ...writeAttemptPatch(attemptBudget),
                        // THE WRITE ITSELF, so it can be re-issued in code the
                        // moment the caller agrees — through retryPendingWrite
                        // and back into handleToolCall, where this gate and
                        // every other one still apply. A retry of a refused
                        // call, not a bypass of the refusal.
                        //
                        // ONLY WHEN A READ-BACK HAPPENED. With nothing read
                        // back, a later "yes" is agreement to something the
                        // caller never heard, and re-issuing on it would write
                        // exactly what this gate exists to stop. LVX77 is the
                        // standing warning: a booking retry once wrote a name
                        // the caller never said.
                        // `reason` matters: a write stashed by the SPELLING
                        // gate must never be re-issued on a caller's "yes",
                        // because its args carry the UNSPELLED name and that
                        // is the row's identity (LVX72, and LVX77's "Jane
                        // Doe"). Agreement only releases a write that was
                        // held for agreement.
                        ...(readBackMade
                          ? { pendingWrite: { name: fc.name, args: fc.args || {}, reason: "write_order" } }
                          : {}),
                        ...(orderRefusalIsNew
                          ? {
                              writeOrderRefusals: orderRefusals + 1,
                              writeOrderRefusedTurn: orderCallerTurn,
                            }
                          : {}),
                      },
                    },
                  },
                };
              }
            }
          }

          // Confirm the spelling of a hard name BEFORE it becomes a record.
          //
          // A live call stored "Venkateshwaria Ayalavarapu" as "Venkateshwaria
          // Ayalla Varpu". The assistant DID say the surname back — and it made
          // no difference, because a spoken read-back cannot convey spelling:
          // the two sound nearly identical. Only letters catch a letter error,
          // and the business keeps that row.
          //
          // Blocked until answered, not until asked. Until 2026-08-31 this gate
          // opened the moment the call had SPOKEN a spelling request, so a
          // caller who was asked and simply carried on talking had their
          // mis-heard name written anyway — the reported defect. It now stays
          // shut until lib/voice/replyState.js sees letters, a refusal, or the
          // agreed number of unanswered attempts. Same fail-closed,
          // one-reason-at-a-time shape as checkRequirements below.
          // ctx.lastChance means: the call is ending and this write was refused
          // earlier and never re-issued. Refusing again would lose it for good.
          //
          // Deliberately narrow. It is set in exactly one place -- the end-of-call
          // sweep in lib/voice/live/index.js -- and only for a message, never a
          // booking. The name goes in exactly as heard, which is the trade being
          // made rather than an oversight: a callback from "Nathan Dasler" on the
          // right number reaches the right person, and a callback that does not
          // exist reaches nobody.
          const pendingName =
            CONFIRM_HARD_NAMES && ctx?.lastChance !== true ? callerNameFromArgs(fc.args) : null;
          // How many times has this gate refused on this call?
          //
          // A phrasing-independent backstop for the shared counter, which only
          // moves once lib/voice/strings.js's spellRequestRe matches what the
          // assistant said. That regex can be widened but never completed — the
          // model can always ask in words nobody listed — and an unrecognised
          // ask means refuse, ask, get an answer, refuse again. That is the
          // livelock, and the gate fires for every unknown name rather than
          // only hard ones, so the exposure is large.
          //
          // A COUNTER, not the boolean it replaced. The boolean gave the gate
          // exactly one refusal per pack per call, which is what made "asked
          // once" and "answered" indistinguishable: the second attempt always
          // went through regardless of what the caller had said. The ceiling is
          // the same escape hatch the reducer's miss cap provides, expressed
          // where it survives a detector that never fires at all.
          //
          // Recorded in the pack's own scratchpad, which the engine threads
          // through the turn and the session persists across turns.
          const gateScratch = ctx?.capabilityState?.[pack.id] || {};
          const gateRefusals = Number(gateScratch.spellingGateRefusals) || 0;
          // Which caller turn the last refusal belonged to.
          //
          // The budget is per TURN, not per tool round, and the difference is
          // the whole safety of it. services/gemini.js merges capabilityState
          // back after every round and rebuilds ctx from it, so a model that
          // re-calls book_appointment three times inside one turn would burn
          // 0->1->2 and write the mis-heard name on the third — in a single
          // turn, with zero spelling questions ever spoken to the caller. The
          // refusal only means something once the caller has had a chance to
          // answer it, so only a NEW turn spends one. The in-turn loop is
          // bounded separately, by MAX_FC_ROUNDS.
          const callerTurn = Number(ctx?.callerTurnCount) || 0;
          const refusalIsNew = gateScratch.spellingGateRefusedTurn !== callerTurn;
          // THE SHARED CEILING, recomputed here rather than shared through a
          // variable: the write-order gate sits in a deeper scope, and both
          // gates reading it from ctx is what keeps them honest about counting
          // the same thing. See writeAttemptMaxRefusals.
          const spellAttemptBudget = writeAttemptBudget(ctx, pack.id, fc);
          if (
            spellAttemptBudget.spent &&
            pendingName &&
            gateRefusals < spellMissCap() &&
            shouldConfirmSpelling({
              name: pendingName,
              callerContext: ctx?.callerContext,
              spellingSettled: ctx?.spellingSettled,
              policy: spellPolicy(),
              callerSaidThisCall: ctx?.callerSaidThisCall ?? null,
            })
          ) {
            // This gate would have refused, and on its own count it still had
            // room to. The caller has been refused three times for this one
            // write already, by whichever gates were looking, so the booking
            // goes through with the name as heard -- which is the trade the
            // spelling gate's own cap already makes, one level up.
            bumpCounter("write_attempt_budget_released");
            log.error("write_attempt_budget_released", {
              callId: ctx?.callId || null,
              tool: fc.name,
              gate: "spelling",
              refusals: spellAttemptBudget.refusals,
              severity: "warn",
            });
          } else if (
            pendingName &&
            gateRefusals < spellMissCap() &&
            shouldConfirmSpelling({
              name: pendingName,
              callerContext: ctx?.callerContext,
              spellingSettled: ctx?.spellingSettled,
              policy: spellPolicy(),
              // LVX53: an on-file name only silences the gate when the CALLER
              // said it on this call. Absent on the cascade, which threads no
              // transcript, so the bypass there is unchanged.
              callerSaidThisCall: ctx?.callerSaidThisCall ?? null,
            })
          ) {
            // Worded as an unfinished step, not a failure. LVX34: the model
            // read `success: false` as "this cannot be done" and told the
            // caller someone would ring them back -- twice -- rather than
            // asking the one question it had just been asked to ask. Nothing
            // in the old text said the request was still live, so the model
            // supplied its own conclusion, and take-a-message is the fallback
            // the prompt gives it everywhere else.
            //
            // Every constraint the old wording carried is kept: not caller
            // speech, the name quoted, one attempt per caller turn, and the
            // decline escape hatch that stops a caller being asked forever.
            const message =
              `[not caller speech] NOT A FAILURE — this booking is still going ahead, it just needs one ` +
              `more thing first. Before recording "${pendingName}", get the spelling: ask the caller to ` +
              // "spell it" was read as "spell the first name". On 2026-09-05 the
              // model asked "could you spell that first name for me?", the caller
              // did, and the surname went into the row exactly as the vendor had
              // misheard it -- "Nithin Dadla" for Nithin Dodla. The gate was
              // satisfied because SOME letters arrived; it cannot tell which part
              // of the name they spelled, and assembling them to find out is what
              // LVX62 rules out. So the ask is made explicit instead.
              `spell their FULL name, first name and surname, and read the letters back. Do not tell ` +
              `the caller anything went wrong, do not ` +
              `offer a callback, and do not take a message instead — they are on the line and the only ` +
              `thing missing is the spelling. Ask them now and wait for their answer; do not call this ` +
              `function again until they have replied, then call it again with the same details. If they ` +
              `decline or tell you it is spelled how it sounds, accept that and record the name exactly ` +
              `as you heard it.`;
            // Counted, because until now this gate's entire accounting lived in
            // per-call capabilityState and no call could report how often it
            // fired or how often it ran out. The cap is the interesting half:
            // the refusal AFTER the last one writes the name as heard.
            bumpCounter("spelling_gate_refusals");
            if (refusalIsNew && gateRefusals + 1 >= spellMissCap()) {
              bumpCounter("spelling_gate_cap_reached");
            }
            // Keep the name, exactly as the requirements refusal below does.
            // A refusal throws fc.args away, and this one now fires for every
            // caller whose name is not already on file — so without this the
            // very gate meant to get the name RIGHT would be the one that made
            // the model forget it and ask for it again. That is the re-asking
            // loop this whole area exists to close.
            const priorSpellFacts = ctx?.capabilityState?.[pack.id]?.callerFacts || {};
            return {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: false, message },
              },
              stateEffects: {
                // refused: nothing ran. The voice session uses this to stay
                // quiet — announcing "Getting that scheduled now." a moment
                // before asking the caller to spell their name describes work
                // that was declined, not work in progress. The event itself
                // still goes out, because metrics and the transcript both want
                // to know the model tried.
                toolResult: { name: fc.name, success: false, message },
                toolCallEvent: { name: fc.name, args: fc.args, silent: true },
                capabilityState: {
                  [pack.id]: {
                    // THE WRITE THIS GATE JUST REFUSED, kept so it can be
                    // re-issued in code once the caller answers.
                    //
                    // Four calls have now lost a booking on this exact path:
                    // the gate refuses pending a spelling, the caller spells
                    // it, and the model never calls the tool again -- it just
                    // announces the booking. LVX34 rewrote this refusal's text
                    // to say the request is still live and to call again with
                    // the same details, and call 4 ignored it, exactly as call
                    // 6 of the previous round did.
                    //
                    // A refusal message is a REQUEST. The caller was told "I
                    // have you down for a cleaning on Monday" with booked_rows
                    // 0, so the thing that must not depend on the model's
                    // cooperation is the write itself.
                    //
                    // Nothing here reaches a caller: it is the model's own
                    // arguments, held in memory for the rest of the call, and
                    // it is never logged.
                    pendingWrite: { name: fc.name, args: fc.args || {} },
                    // The backstop above. Counted once per caller turn, so a
                    // detector that never recognises this caller's phrasing
                    // still runs out of refusals rather than looping forever —
                    // without the model being able to spend the whole budget
                    // on its own retries inside a single turn.
                    spellingGateRefusals: refusalIsNew ? gateRefusals + 1 : gateRefusals,
                    spellingGateRefusedTurn: callerTurn,
                    // The SHARED count, so this refusal and the write-order
                    // gate's land in one total. Four attempts refused by two
                    // gates used to read as two-and-two, under two separate
                    // ceilings, while the caller experienced four.
                    ...writeAttemptPatch(spellAttemptBudget),
                    ...(priorSpellFacts.Name
                      ? {}
                      : { callerFacts: { ...priorSpellFacts, Name: pendingName } }),
                  },
                },
              },
            };
          }
          const cfg = capabilityConfig(ctx?.config, pack.id);
          const check = checkRequirements(cfg, fc.args || {}, { ...ctx, toolName: fc.name });
          if (!check.ok) {
            // The refusal throws fc.args away — including a name the caller
            // already said out loud and the model already had. Keeping it is
            // half the cure for the re-asking loops: a booking refused for a
            // missing DOB must not also cost us the name, or the next turn
            // asks for the name again (and then asks it to be spelled again).
            //
            // Merged with whatever the pack already recorded, because the
            // capabilityState merge in lib/capabilities/effects.js is shallow
            // AT THE CAPABILITY LEVEL: writing `callerFacts` replaces the
            // whole map rather than adding to it.
            const heardName = callerNameFromArgs(fc.args);
            const priorFacts = ctx?.capabilityState?.[pack.id]?.callerFacts || {};
            return {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: false, message: check.message },
              },
              stateEffects: {
                // refused before execution — see the spelling gate above.
                toolResult: { name: fc.name, success: false, message: check.message },
                toolCallEvent: { name: fc.name, args: fc.args, silent: true },
                ...(heardName && !priorFacts.Name
                  ? {
                      capabilityState: {
                        [pack.id]: { callerFacts: { ...priorFacts, Name: heardName } },
                      },
                    }
                  : {}),
              },
            };
          }
        }
        return pack.execute(fc, { ...ctx, deps: ctx.depsOverride || CAPABILITY_DEPS });
      }
      return executeWebhookTool(fc, ctx);
    }
  }
}

/**
 * The caller's name as the model supplied it on a write tool, whatever that
 * tool calls the parameter.
 *
 * Two spellings exist across the packs and are not going to be unified: the
 * appointment tools carry `client_name` (it is the client of the business),
 * the message/quote/EHR tools carry `caller_name`. lib/capabilities/requirements.js
 * bridges them for the `name` requirement via paramAliases; this is the same
 * bridge for the refusal path.
 *
 * @param {object} [args] - the model's tool arguments
 * @returns {string|null} trimmed name, or null when absent/blank/not a string
 */
/**
 * A stable number for a sentence, so the write-order gate can tell "the model
 * is re-proposing the same thing" from "the caller changed what they want"
 * without keeping the sentence itself.
 *
 * djb2. Not a security hash and not trying to be: a collision costs one
 * proposal sharing another's refusal budget, which is the same outcome the
 * budget already allows.
 */
/**
 * Which write is being attempted — the proposal, WITHOUT the name.
 *
 * Excluding the name is the load-bearing decision. A spelling exchange retries
 * the same booking with a corrected `client_name` every time; that is the whole
 * point of the exchange. A fingerprint that included it would call every
 * correction a new proposal, reset the budget, and rebuild the exact livelock
 * this exists to end.
 *
 * A different TIME, or a different appointment, IS a new proposal and does
 * reset it — which is what LVX104 requires, because a caller changing their
 * mind is the opposite of a trap.
 */
function writeAttemptFingerprint(fc) {
  const a = fc?.args || {};
  return textFingerprint(
    [fc?.name, a.scheduled_at, a.new_scheduled_at, a.appointment_id].map((v) => v || "").join("|")
  );
}

/**
 * The shared budget's view of this attempt. Read from ctx only, so both gates
 * can compute it independently without sharing a scope.
 */
function writeAttemptBudget(ctx, packId, fc) {
  const scratch = ctx?.capabilityState?.[packId] || {};
  const key = writeAttemptFingerprint(fc);
  const sameAttempt = scratch.writeAttemptKey === key;
  const refusals = sameAttempt ? Number(scratch.writeAttemptRefusals) || 0 : 0;
  const callerTurn = Number(ctx?.callerTurnCount) || 0;
  return {
    key,
    refusals,
    spent: refusals >= writeAttemptMaxRefusals(),
    // Per CALLER TURN, for the reason both gates already document: a model
    // calling the same tool three times inside one turn must not burn a budget
    // the caller was never asked to spend.
    isNewTurn: scratch.writeAttemptRefusedTurn !== callerTurn,
    callerTurn,
  };
}

/** The capabilityState patch every refusal must carry, from either gate. */
function writeAttemptPatch(budget) {
  return {
    writeAttemptKey: budget.key,
    ...(budget.isNewTurn
      ? { writeAttemptRefusals: budget.refusals + 1, writeAttemptRefusedTurn: budget.callerTurn }
      : {}),
  };
}

function textFingerprint(text) {
  let h = 5381;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `k${h}`;
}

function callerNameFromArgs(args) {
  const raw = args?.client_name ?? args?.caller_name;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * A tool no capability claims: the business defined it itself as a webhook
 * integration. This is the generic escape hatch — the long tail no capability
 * will ever anticipate — so it is engine-owned rather than pack-owned.
 */
async function executeWebhookTool(fc, ctx) {
  const integrations = ctx?.integrations || [];
  const integration = integrations.find((i) => i.name === fc.name);

  if (!integration || !integration.enabled) return unknownToolResult(fc);

  const execResult = await executeIntegration(integration, {
    tool: fc.name,
    arguments: fc.args || {},
    business_id: ctx?.businessId || null,
    call_id: ctx?.callId || null,
    caller_phone: ctx?.callerPhone || null,
  });
  const success = execResult.success === true;

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: success
        ? { success: true, message: execResult.message }
        : { success: false, error: execResult.error },
    },
    stateEffects: {
      toolResult: {
        name: fc.name,
        success,
        message: success ? execResult.message : execResult.error || "Something went wrong.",
      },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

// ---------------------------------------------------------------------------
// Tool execution guard.
//
// NOT the cause of the 2026-08-04 incident — that was the model writing its
// function call into the text channel. This is the neighbouring defect the
// investigation turned up: nothing anywhere bounded a tool. getReplyStreaming
// awaited executeToolCall bare, this module added no timeout of its own, and
// the Supabase client was constructed with no AbortSignal. A hung query hung
// until the LLM deadline fired — and then kept running, so a reschedule could
// still land in the database AFTER the caller had been told it failed.
//
// The guard lives here rather than in services/gemini.js for three reasons: it
// owns the {functionResponse, stateEffects} contract, so the synthesised
// failure sits beside the shape it has to satisfy; it is the single choke point
// every tool passes through, pack and webhook alike, so no author can forget
// it; and it is testable without mocking the model client.
// ---------------------------------------------------------------------------

/**
 * Deliberately above WEBHOOK_TIMEOUT_MS (6s) and the Athena timeout, so those
 * vendor-specific bounds still fire first and produce their better-worded
 * messages. This is the backstop for everything they do not cover — Supabase,
 * pack logic, an adapter that forgets to bound itself. It must stay comfortably
 * inside VOICE_LLM_HARD_TIMEOUT_MS (20s) or it can never fire at all.
 */
const TOOL_TIMEOUT_MS = (() => {
  const v = Number.parseInt(process.env.TOOL_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 1_000 && v <= 30_000 ? v : 8_000;
})();

/**
 * Model-facing text per failure reason. Closed set on purpose: the alternative
 * is passing an upstream error string through, and a vendor's error body is
 * arbitrary text that has already been observed carrying implementation detail
 * — and can carry a patient's name.
 */
const REASON_TEXT = {
  TIMEOUT:
    "That took too long and did not complete. Tell the caller you can't get it done right now and offer to take their details. Do not explain why, and do not name anything.",
  UNAVAILABLE:
    "That did not work. Tell the caller you can't get it done right now and offer to take their details. Do not explain why, and do not name anything.",
};

/**
 * Run a tool with a deadline and an error boundary.
 *
 * A timed-out promise is ABANDONED, not cancelled — Promise.race cannot cancel
 * anything, and the only thing that actually stops a late database write is the
 * transport-level AbortSignal in services/db.js. What this adds is that
 * the CALLER stops waiting, and that a late completion is visible
 * (tool_late_completion) rather than silent.
 *
 * @param {object} fc - the model's function call
 * @param {object} ctx - executeToolCall's context
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{functionResponse: object, stateEffects: object}>}
 */
export async function executeToolCallGuarded(fc, ctx, { timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  let settled = false;
  let timer = null;

  const failure = (reasonCode) => ({
    functionResponse: {
      id: fc?.id,
      name: fc?.name,
      response: { success: false, reason_code: reasonCode },
    },
    stateEffects: {
      toolResult: {
        name: fc?.name,
        success: false,
        message: REASON_TEXT[reasonCode] || REASON_TEXT.UNAVAILABLE,
        // A directive to the model, never a line for the caller.
        callerSafe: false,
      },
    },
  });

  // Tenant scope for the whole tool call.
  //
  // THE RIGHT BOUNDARY for the per-turn path: one tool call is one unit of
  // work — it books an appointment, records a request, cancels something — and
  // every database write a capability makes happens inside it. Scoping here
  // covers all of them at once, including the ones reached through
  // ctx.deps several frames down, without any capability needing to know.
  //
  // It is also short. A tool call is bounded by TOOL_TIMEOUT_MS, so the
  // connection and transaction this holds are released on a timescale the pool
  // can absorb, which is the property withTenant depends on.
  //
  // Safe, not strict: a scope that fails must not take the turn with it. The
  // caller is on the phone, and executeToolCall already returns a failure shape
  // the model can explain.
  const work = (async () =>
    ctx?.businessId
      ? withTenantSafe(ctx.businessId, () => executeToolCall(fc, ctx), {
          operation: "executeToolCall",
          callSid: ctx?.callSid ?? null,
          fallback: failure("UNAVAILABLE"),
        })
      : executeToolCall(fc, ctx))();

  // Watch the abandoned promise: this is the evidence that a write landed after
  // the caller was told otherwise, which is otherwise invisible.
  work.then(
    () => {
      if (settled) {
        log.error("tool_late_completion", {
          tool: fc?.name,
          ms: Date.now() - startedAt,
          severity: "warn",
        });
      }
    },
    () => {}
  );

  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(Symbol.for("tool.timeout")), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([work, timeout]);
    if (result === Symbol.for("tool.timeout")) {
      settled = true;
      bumpCounter("tool_timeouts");
      log.error("tool_timeout", { tool: fc?.name, ms: timeoutMs, severity: "warn" });
      return failure("TIMEOUT");
    }
    // PER-TOOL timing. `llm_tool_ms` is first-write-wins across a turn, so it
    // describes only the first tool and never says WHICH tool was slow. The
    // integrations already log this shape (athena_tool, webhook duration_ms);
    // the Supabase-backed pack tools — including check_appointment_availability,
    // which sits on the booking hot path and can make two round trips — emitted
    // nothing at all. "It takes 4-5 seconds when a tool runs" needs a name
    // attached to be actionable.
    log.info("tool_duration", {
      tool: fc?.name,
      ms: Date.now() - startedAt,
      success: result?.functionResponse?.response?.success !== false,
    });
    return result;
  } catch (err) {
    // The vendor's own words stop here. They reach the log, never the model.
    log.error("tool_threw", { tool: fc?.name, reason: err?.message, severity: "warn" });
    bumpCounter("tool_errors");
    return failure("UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}
