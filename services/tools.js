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
} from "./supabase.js";
import { executeIntegration } from "./integrations.js";
import { packForTool } from "../capabilities/index.js";
import { unknownToolResult } from "../lib/capabilities/results.js";
import { checkRequirements, capabilityConfig } from "../lib/capabilities/requirements.js";

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
// surface through ctx.deps, assembled below. Two reasons: services/supabase.js
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
 * services/supabase.js: vitest's mock throws on access to an export the mock
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
 *     toolCallEvent?: {name: string, args: object}|null,
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
      if (wrappingUp || didSomething || hadConversation) {
        const endCallArgs = fc.args ?? {};
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
          stateEffects: {
            endCallArgs,
            toolResult: { name: fc.name, success: true, message: "Goodbye!", callerSafe: true },
            toolCallEvent: { name: fc.name, args: fc.args },
          },
        };
      }
      const message =
        "Don't end the call yet. First confirm you've helped with their request and ask if there's anything else they need.";
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
        // Configured requirements are enforced HERE, before the pack runs, so
        // every capability inherits them and no pack author can forget to
        // check. A refusal is returned to the model as an instruction; the
        // action does not happen.
        //
        // Only caller-visible writes are gated. Gating a lookup would stop the
        // receptionist finding the record it needs in order to ask the caller
        // about it — locking the door and the key inside.
        if ((pack.actionTools || []).includes(fc.name)) {
          const cfg = capabilityConfig(ctx?.config, pack.id);
          const check = checkRequirements(cfg, fc.args || {}, { ...ctx, toolName: fc.name });
          if (!check.ok) {
            return {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: false, message: check.message },
              },
              stateEffects: {
                toolResult: { name: fc.name, success: false, message: check.message },
                toolCallEvent: { name: fc.name, args: fc.args },
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
