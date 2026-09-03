import { buildAllDeclarations, intentMarkerEnabled, ACTION_TOOL_NAMES } from "../../../services/gemini.js";
import { executeToolCallGuarded } from "../../../services/tools.js";
import { createToolGuards } from "./guards.js";
import { log } from "../../logger.js";

// ---------------------------------------------------------------------------
// Tool declarations and the tool loop for the Live front-end.
//
// Two rules from docs/speech-to-speech-handoff.md section 6, both of them paid
// for already:
//
//   1. Declare all TEN tools, from production's own union. Rounds 1 and 2
//      declared six and measured a receptionist with no calendar.
//   2. Execute through services/tools.js, not a reimplementation. That file
//      carries the end_call gate, the hard-name spelling gate, the booking
//      idempotency anchor and the tool timeout -- every one of which was added
//      because of a real call.
// ---------------------------------------------------------------------------

/**
 * The tools for one call, in the shape a Live session config takes.
 *
 * @param {object} config - normalised business config
 * @param {object} [extras] - { integrations, ... }
 * @returns {Array<{functionDeclarations: object[]}>}
 */
export function buildLiveTools(config, extras = {}) {
  return [{ functionDeclarations: buildAllDeclarations(config, extras, intentMarkerEnabled(extras)) }];
}

/**
 * Run the tool calls a Live session asks for, guarded, and report what the
 * reply reducer needs to know.
 *
 * ---------------------------------------------------------------------------
 * Why this is not just a map over executeToolCallGuarded
 * ---------------------------------------------------------------------------
 *
 * Three things have to survive the move from the cascade, and each of them is
 * a real defect if it does not:
 *
 * - `capabilityState` threads through calls, both within a round and across
 *   turns. "Look up my appointment, then cancel it" arrives as two calls; the
 *   second needs the first's `selectedAppointmentId` or it asks "which one?"
 *   about the appointment it just read out. services/gemini.js rebuilds
 *   toolCtx per call for exactly this reason and this does the same.
 *
 * - Every call gets a response. A Live session left holding an unanswered tool
 *   call does not error -- it waits, and the caller hears silence. So a throw
 *   inside a tool becomes a failed response, never an escaped exception.
 *
 * - `completedActionThisTurn` / `ThisCall` gate `end_call` in
 *   services/tools.js. Without them the model says goodbye, calls end_call, is
 *   refused, and the line stays open until the silence ladder fires half a
 *   minute later -- the documented ~90% of goodbyes.
 *
 * @param {object} opts
 * @param {object} opts.config
 * @param {object} [opts.extras] - { integrations, businessId, callerPhone, callId, ... }
 * @param {Function} [opts.execute] - test seam; defaults to executeToolCallGuarded
 * @param {Function} [opts.turnState] - () => { step, callerTurnCount, transferAllowed, spellingSettled }
 */
export function createToolRunner({ config, extras = {}, execute = executeToolCallGuarded, turnState = () => ({}) }) {
  const declarations = buildAllDeclarations(config, extras, intentMarkerEnabled(extras));
  const guards = createToolGuards({ declarations, config });

  /** Survives the whole call, not just a round. */
  let capabilityState = {};
  let completedActionThisCall = false;

  /**
   * @param {{functionCalls: Array<{id: string, name: string, args: object}>}} toolCall
   */
  async function handleToolCall(toolCall) {
    const calls = Array.isArray(toolCall?.functionCalls) ? toolCall.functionCalls : [];
    const functionResponses = [];
    const toolResults = [];
    const capabilityEffects = [];
    let intentArgs;
    let endCallArgs;
    let transferRequested;
    let completedActionThisTurn = false;

    for (const fc of calls) {
      const verdict = guards.before(fc);
      if (!verdict.allow) {
        // The guard already counted and logged. Its response is the model's
        // instruction for what to do instead.
        functionResponses.push(verdict.functionResponse);
        continue;
      }

      const state = turnState() || {};
      // Rebuilt per call so an earlier tool's output is visible to the next.
      const ctx = {
        businessId: extras.businessId || null,
        callerPhone: extras.callerPhone || null,
        callId: extras.callId || null,
        integrations: extras.integrations || [],
        completedActionThisTurn,
        completedActionThisCall: completedActionThisCall || completedActionThisTurn,
        callerTurnCount: Number(state.callerTurnCount) || 0,
        spellingSettled: !!state.spellingSettled,
        step: state.step,
        transferAllowed: state.transferAllowed !== false,
        config,
        capabilityState,
        callerContext: extras.callerContext || null,
        // Harness seam, identical to services/gemini.js:2385. When set,
        // services/tools.js hands this to a pack's execute in place of the
        // real CAPABILITY_DEPS. undefined in production, where it must be.
        //
        // Present so the Live eval driver can run this EXACT tool runner
        // against in-memory fakes rather than a second copy of it -- the
        // handoff's own warning about the drivers drifting, which is how an
        // eval stops measuring production without anyone noticing.
        depsOverride: extras.capabilityDeps,
      };

      let result;
      try {
        result = await execute(fc, ctx);
      } catch (err) {
        // Never let a tool failure leave the call unanswered. The model can
        // apologise to a failed response; it cannot do anything with silence.
        log.error("live_tool_execution_failed", { tool: fc.name, reason: err?.message, severity: "warn" });
        functionResponses.push({
          id: fc.id,
          name: fc.name,
          response: { success: false, message: "That didn't go through. Apologise briefly and offer to take a message." },
        });
        continue;
      }

      guards.after(fc, result);
      functionResponses.push(result.functionResponse);

      const effects = result.stateEffects || {};
      if (effects.toolResult) toolResults.push(effects.toolResult);
      if ("intentArgs" in effects) intentArgs = effects.intentArgs;
      if ("endCallArgs" in effects) endCallArgs = effects.endCallArgs;
      if ("transferRequested" in effects) transferRequested = effects.transferRequested;
      if (Array.isArray(effects.capabilityEffects)) capabilityEffects.push(...effects.capabilityEffects);
      if (effects.capabilityState) capabilityState = mergeCapabilityState(capabilityState, effects.capabilityState);

      if (effects.toolResult?.success && ACTION_TOOL_NAMES.includes(fc.name)) {
        completedActionThisTurn = true;
        completedActionThisCall = true;
      }
    }

    return { functionResponses, toolResults, capabilityEffects, intentArgs, endCallArgs, transferRequested };
  }

  return {
    declarations,
    guards,
    handleToolCall,
    get capabilityState() {
      return capabilityState;
    },
  };
}

/**
 * Shallow-merge per capability, with null clearing a capability's slice.
 * Mirrors services/gemini.js mergeCapabilityState, which is module-private.
 */
function mergeCapabilityState(current, patch) {
  const out = { ...(current || {}) };
  for (const [capability, value] of Object.entries(patch || {})) {
    if (value === null) delete out[capability];
    else out[capability] = { ...(out[capability] || {}), ...value };
  }
  return out;
}
