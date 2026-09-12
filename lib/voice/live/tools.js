import { buildAllDeclarations, intentMarkerEnabled, ACTION_TOOL_NAMES } from "../../../services/gemini.js";
import { executeToolCallGuarded } from "../../../services/tools.js";
import { createToolGuards } from "./guards.js";
import { packForTool } from "../../../capabilities/index.js";
import { log } from "../../logger.js";
import { bumpCounter } from "../metrics.js";

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
  const guards = createToolGuards({ declarations, config, callSid: extras.callSid || null });

  /** Survives the whole call, not just a round. */
  let capabilityState = {};
  let completedActionThisCall = false;
  /** LVX72: whether the one-shot abandoned-write hang-up refusal has been used. */
  let abandonedHangupRefused = false;

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
    /**
     * Which end_call gate refused, if one did: "hesitation" or "generic".
     *
     * Carried per call rather than left to bumpCounter, which writes to process
     * memory shared by every call the instance handles and zeroed by the next
     * deploy. On 2026-09-09 two refusals were readable only as
     * `tool_duration success=false`, and the question "why did the gate refuse
     * on THIS call" had no answer at all.
     */
    let endCallRefusal = null;
    let completedActionThisTurn = false;
    /**
     * Caller-visible writes that were asked for and did NOT happen this turn.
     *
     * Distinct from the attempted count the reducer already keeps, and the
     * distinction is LVX34: a refused write leaves the caller's request
     * outstanding, and the refusal carries an instruction the model is supposed
     * to follow rather than fall back from. Counting attempts made the promise
     * guard blind to exactly this turn, because a refusal still increments an
     * attempt.
     *
     * Every refusal path is included: the Live guards (which return no
     * toolResult at all), the spelling gate and the requirements check in
     * services/tools.js, a pack's own invariant, and an execution failure.
     * They differ in cause and not in what the caller experiences.
     */
    let refusedActionCalls = 0;
    /**
     * EVERY refused call this turn, action tool or not.
     *
     * Separate from the count above because the two answer different
     * questions. `refusedActionCalls` is "did something the caller asked for
     * fail to happen" -- that is LVX34's shape. This one is "did any tool
     * actually execute", which is what the claim guard needs: a lookup the
     * guards refused is not grounds for telling the caller anything is done
     * either.
     */
    let refusedCalls = 0;

    for (const fc of calls) {
      const isAction = ACTION_TOOL_NAMES.includes(fc.name);
      const verdict = guards.before(fc);
      if (!verdict.allow) {
        // The guard already counted and logged. Its response is the model's
        // instruction for what to do instead.
        //
        // A suppressed duplicate is NOT a refusal: the write already happened
        // earlier in this call and the cached success is returned, so nothing
        // the caller asked for is outstanding.
        if (verdict.reason !== "duplicate_write") {
          refusedCalls += 1;
          if (isAction) {
            refusedActionCalls += 1;
            bumpCounter("live_tool_refusals");
          }
        }
        functionResponses.push(verdict.functionResponse);
        continue;
      }

      const state = turnState() || {};
      // Rebuilt per call so an earlier tool's output is visible to the next.
      const ctx = {
        businessId: extras.businessId || null,
        callerPhone: extras.callerPhone || null,
        callId: extras.callId || null,
        // Distinct from callId, which is the database row. This is what Cloud
        // Logging filters on, and services/tools.js has been reading
        // `ctx?.callSid` -- for withTenantSafe's audit and for tool_duration --
        // against an object that never carried it.
        callSid: extras.callSid || null,
        integrations: extras.integrations || [],
        completedActionThisTurn,
        completedActionThisCall: completedActionThisCall || completedActionThisTurn,
        callerTurnCount: Number(state.callerTurnCount) || 0,
        spellingSettled: !!state.spellingSettled,
        // What the caller actually last said.
        //
        // turnState() has produced this since the LVX45 fix shipped and NOTHING
        // COPIED IT HERE, so services/tools.js read undefined, heardOnlyHesitation
        // was permanently false, and the hang-up gate was unreachable on every
        // Live call. end_call_refused_hesitation read 0 throughout -- a
        // fault-only counter reads zero for a clean run and for a run that never
        // got there, which is exactly how this hid.
        //
        // Both sides had unit tests. tests/tools.test.js passes lastCallerText
        // straight into executeToolCall, so it proved the consumer; turnState
        // proved the producer; nothing proved they were connected. That is what
        // tests/liveToolContext.test.js is for.
        lastCallerText: typeof state.lastCallerText === "string" ? state.lastCallerText : "",
        // LVX95's other half: what the assistant said on the PREVIOUS completed
        // turn. The write-order gate needs both -- a read-back that was made,
        // and a caller who agreed to it -- and neither is something the model
        // can assert about itself. Copied here for the reason written directly
        // above: the producer and the consumer each had tests and nothing
        // proved they were connected, and the gate that depended on it was dead
        // for a whole deployment.
        lastReplyText: typeof state.lastReplyText === "string" ? state.lastReplyText : "",
        // Everything the caller has been transcribed saying on this call, for
        // the name-provenance check (LVX53). Held in memory only and never
        // logged: it carries the caller's name and number, which is the LVX24
        // scar.
        callerSaidThisCall:
          typeof state.callerSaidThisCall === "string" ? state.callerSaidThisCall : null,
        step: state.step,
        transferAllowed: state.transferAllowed !== false,
        // LVX72, and copied here for the reason written twenty lines above:
        // turnState producing a field and this object not copying it is how the
        // hang-up gate sat unreachable for the life of a deployment. The wire
        // is asserted in tests/liveToolContext.test.js, not just the producer
        // and the consumer separately.
        abandonedWrites: Array.isArray(state.abandonedWrites) ? state.abandonedWrites : [],
        // Set only by the end-of-call sweep, and only for a message. The wire
        // is asserted rather than assumed, for the reason written above this:
        // a field produced here and not copied there is how the hang-up gate
        // sat unreachable for the life of a deployment.
        lastChance: state.lastChance === true,
        // Measurement only, threaded for the consent probe in services/tools.js.
        // A value that exists on turnState and is never copied here reads as
        // undefined downstream and silently measures nothing -- the defect
        // lastCallerText itself had for the life of a deployment.
        lastAgreementReadBackKey: state.lastAgreementReadBackKey ?? null,
        callerTurnsSinceAgreement:
          state.callerTurnsSinceAgreement === undefined ? null : state.callerTurnsSinceAgreement,
        // LVX72's refusal is allowed ONCE per call. The latch lives here rather
        // than in services/tools.js, which is stateless and shared with the
        // cascade -- and a guard that can refuse twice can hold a caller on the
        // line indefinitely.
        abandonedHangupRefusalSpent: abandonedHangupRefused,
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
        refusedCalls += 1;
        if (isAction) {
          refusedActionCalls += 1;
          bumpCounter("live_tool_refusals");
        }
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
      if (effects.endCallRefusal) endCallRefusal = effects.endCallRefusal;
      if (Array.isArray(effects.capabilityEffects)) capabilityEffects.push(...effects.capabilityEffects);
      if (effects.capabilityState) capabilityState = mergeCapabilityState(capabilityState, effects.capabilityState);
      // LVX72. Spend the one-shot hang-up refusal. Asserted in
      // tests/liveAbandonedEndCall.test.js rather than trusted: a latch that is
      // never set makes the guard fire on every attempt, which is the hair
      // trigger the whole count-first ladder existed to avoid.
      if (effects.endCallAbandonedRefusal) abandonedHangupRefused = true;

      // Read off the functionResponse rather than the toolResult, because that
      // is the one thing every refusal shape sets: the spelling gate and the
      // requirements check both return success:false there, and a pack's own
      // invariant does too.
      const refused = result.functionResponse?.response?.success === false;
      if (refused) refusedCalls += 1;
      if (isAction) {
        if (effects.toolResult?.success) {
          completedActionThisTurn = true;
          completedActionThisCall = true;
          // The stash is "a write that was refused and has not since
          // succeeded" -- LVX72's own definition. If the MODEL comes back with
          // the write itself, there is nothing left to retry, and retrying
          // anyway would book twice. This is also what makes deferring our
          // retry to the end of the turn safe.
          //
          // ANY write in this pack, not just the same tool. LVX126.
          //
          // It used to clear only when `pendingWrite.name === fc.name`, so a
          // stash for a DIFFERENT tool survived another write completing -- and
          // the retry trigger then released it on the caller's next "yes",
          // whatever that yes was about.
          //
          // CA73bf7dc5, 2026-09-12: a reschedule to Wednesday was held at
          // 16:55:21, the caller changed their mind twice and asked to cancel
          // instead, the cancellation was read back and committed at 16:56:00,
          // and the caller's "Yes." five seconds later -- agreement to the
          // CANCELLATION -- re-issued the stale reschedule. One word ran two
          // different writes.
          //
          // A caller who has just had a DIFFERENT write completed for them has
          // moved on; whatever was held before it is no longer what they are
          // answering. Losing a re-issue is the safe direction -- the model can
          // still call the tool itself and the post-call net still sees a
          // booking that was owed -- where firing the wrong write is not
          // recoverable by the caller at all.
          //
          // Deliberately NOT a read-back comparison: the gate RE-ASKS when it
          // refuses ("Just to confirm before I do that -- shall I go ahead?"),
          // so the sentence the caller finally answers is not the sentence the
          // write was stashed against, and matching prose fingerprints breaks
          // the legitimate re-issue. tests/liveWriteRetry.test.js caught that
          // within a minute of it being written.
          const pack = packForTool(fc.name);
          if (pack?.id && capabilityState?.[pack.id]?.pendingWrite) {
            capabilityState = mergeCapabilityState(capabilityState, {
              [pack.id]: { pendingWrite: null },
            });
          }
        } else if (refused) {
          refusedActionCalls += 1;
          bumpCounter("live_tool_refusals");
        }
      }
    }

    return {
      functionResponses,
      toolResults,
      capabilityEffects,
      intentArgs,
      endCallArgs,
      transferRequested,
      endCallRefusal,
      refusedActionCalls,
      refusedCalls,
    };
  }

  /**
   * The write the spelling gate refused, returned ONCE and then forgotten.
   *
   * Atomic on purpose. The caller of this is driven by an inbound transcript,
   * and a vendor that re-delivers or splits a transcript would otherwise fire
   * the same booking twice -- which is a worse defect than the one being
   * fixed, and not one the availability guard would catch, because two
   * identical bookings a second apart are both legitimately available.
   *
   * @returns {{name: string, args: object}|null}
   */
  /**
   * What is stashed, WITHOUT consuming it.
   *
   * takePendingWrite clears as it reads, which is right for its own job -- a
   * stash read twice books twice. The end-of-call message sweep has to decide
   * WHETHER to re-issue before committing to it, and a decision that consumes
   * the thing it is deciding about cannot decide.
   */
  function peekPendingWrite() {
    for (const packState of Object.values(capabilityState || {})) {
      if (packState?.pendingWrite?.name) return packState.pendingWrite;
    }
    return null;
  }

  function takePendingWrite() {
    for (const [packId, packState] of Object.entries(capabilityState || {})) {
      const pending = packState?.pendingWrite;
      if (!pending?.name) continue;
      capabilityState = mergeCapabilityState(capabilityState, { [packId]: { pendingWrite: null } });
      return pending;
    }
    return null;
  }

  return {
    declarations,
    guards,
    handleToolCall,
    takePendingWrite,
    peekPendingWrite,
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
