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
import { stripFillers } from "../lib/transcriptUtils.js";

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
      const lastCallerText = typeof ctx?.lastCallerText === "string" ? ctx.lastCallerText : "";
      const heardOnlyHesitation = lastCallerText.trim() !== "" && stripFillers(lastCallerText) === "";

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
      if (heardOnlyHesitation) bumpCounter("end_call_refused_hesitation");
      const message = heardOnlyHesitation
        ? "[not caller speech] The caller has not answered yet — all they said was a hesitation " +
          "(\"um\", \"uh\"). That is someone thinking, not someone saying no. Do not end the call. " +
          "Wait, or ask again gently."
        : "Don't end the call yet. First confirm you've helped with their request and ask if there's anything else they need.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
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
          const pendingName = CONFIRM_HARD_NAMES ? callerNameFromArgs(fc.args) : null;
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
          if (
            pendingName &&
            gateRefusals < spellMissCap() &&
            shouldConfirmSpelling({
              name: pendingName,
              callerContext: ctx?.callerContext,
              spellingSettled: ctx?.spellingSettled,
              policy: spellPolicy(),
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
              `spell it, and read the letters back. Do not tell the caller anything went wrong, do not ` +
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
                    // The backstop above. Counted once per caller turn, so a
                    // detector that never recognises this caller's phrasing
                    // still runs out of refusals rather than looping forever —
                    // without the model being able to spend the whole budget
                    // on its own retries inside a single turn.
                    spellingGateRefusals: refusalIsNew ? gateRefusals + 1 : gateRefusals,
                    spellingGateRefusedTurn: callerTurn,
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
