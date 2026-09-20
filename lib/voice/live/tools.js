import { buildAllDeclarations, intentMarkerEnabled, ACTION_TOOL_NAMES } from "../../../services/gemini.js";
import { executeToolCallGuarded } from "../../../services/tools.js";
import { createToolGuards } from "./guards.js";
import { packForTool } from "../../../capabilities/index.js";
import { log } from "../../logger.js";
import { bumpCounter } from "../metrics.js";
import { textFingerprint } from "../../transcriptUtils.js";

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
export function buildLiveTools(config, extras = {}, env = process.env) {
  const declarations = buildAllDeclarations(config, extras, intentMarkerEnabled(extras));
  const behavior = toolBehavior(env);
  if (!behavior) return [{ functionDeclarations: declarations }];
  return [{ functionDeclarations: declarations.map((d) => ({ ...d, behavior })) }];
}

/**
 * Whether to pin tool calls BLOCKING, and why the default is to pin them.
 *
 * ---------------------------------------------------------------------------
 * gemini-3.8-live made NON_BLOCKING the DEFAULT. 3.1 had no such concept.
 * ---------------------------------------------------------------------------
 *
 * docs/gemini-38-live-analysis.md: "The model does not wait for your tool to
 * return." Every guard on this path, the whole reducer, and the tool loop in
 * this file were written when waiting was the only behaviour there was.
 *
 * Watched on 3.8's first two real calls, 2026-09-17:
 *
 *   4 zero-text turns   tool calls with no speech at all
 *   2 promise-only      "Let me check the openings for this Friday afternoon."
 *   CAb76b13            asked "book this in addition?", called
 *                       cancel_appointment_db SIX SECONDS later without an
 *                       answer, was refused, and announced the cancellation as
 *                       done before hanging up
 *
 * That is not a model being dishonest. That is a model that was never told to
 * wait, talking over work it had not received.
 *
 * BLOCKING rather than scheduling modes, deliberately. The async design --
 * SILENT for set_call_intent, INTERRUPT for a refused write -- is the richer
 * answer and is change #3 on the analysis doc's own list, marked "real work".
 * It is a redesign of the turn machinery, not a setting. Restoring the
 * semantics the existing code already assumes is the move that makes 3.8
 * comparable to 3.1 at all, and it has to come first or the comparison measures
 * our missing integration instead of the model.
 *
 * ACCEPTED IS NOT ENFORCED, and this repository has already paid for that
 * distinction: probe 6470081 established that 3.8 ACCEPTS `toolConfig` and does
 * not ENFORCE it. So this is an unverified control until a real call shows the
 * zero-text and promise-only turns gone. The env var exists so that finding out
 * it does nothing does not require a rebuild.
 *
 * Unset or "default" leaves the field off entirely, which is every call taken
 * before this and is what 3.1 will keep doing either way.
 */
function toolBehavior(env) {
  const raw = String(env.LIVE_TOOL_BEHAVIOR ?? "BLOCKING").trim().toUpperCase();
  if (raw === "DEFAULT" || raw === "") return null;
  return raw === "NON_BLOCKING" ? "NON_BLOCKING" : "BLOCKING";
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
/**
 * LVX157. What comes back attached to a write that landed.
 *
 * Worded against three things that have gone wrong before on this seam:
 *
 *   It opens by saying the write SUCCEEDED. The no_ask refusal had to be
 *   rewritten to open "NOT A FAILURE" because the model read a refusal as a
 *   broken system and offered the caller a transfer. An instruction arriving
 *   on a success must not read as a complaint about it.
 *
 *   It says what to do, not what to avoid. "A refusal message is a request":
 *   three differently-worded prohibitions failed to make the model retry a
 *   lost booking and code had to do it. The prohibition is one clause at the
 *   end, after the two positive ones.
 *
 *   It does not dictate the sentence. LVX25/LVX35 removed a prompt mandate to
 *   say "Is there anything else I can help you with?" because the model recited
 *   it after every ordinary answer. This asks for the question, once, here.
 */
const COMPLETION_ASK_NOTE =
  "[not caller speech] Done — this went through and the caller is still on the line. " +
  "Tell them briefly what you did, then ask in ONE short sentence whether there is " +
  "anything else they need, and wait for their answer. Do not say goodbye and do not " +
  "end the call on this turn.";

export function createToolRunner({ config, extras = {}, execute = executeToolCallGuarded, turnState = () => ({}) }) {
  const declarations = buildAllDeclarations(config, extras, intentMarkerEnabled(extras));
  const guards = createToolGuards({ declarations, config, callSid: extras.callSid || null });

  /** Survives the whole call, not just a round. */
  let capabilityState = {};
  let completedActionThisCall = false;
  /**
   * LVX157. HOW MANY CALLER-VISIBLE WRITES HAVE LANDED ON THIS CALL.
   *
   * Not a boolean, because both halves of the ask gate need to tell "the
   * caller was asked about THIS work" from "the caller was asked, once, about
   * something else earlier". A count is the cheapest thing that carries that,
   * and it only ever goes up on a SUCCESS -- a refused write moves nothing,
   * which is what keeps LVX21's livelock unreachable.
   */
  let completedActionCount = 0;
  /** LVX72: whether the one-shot abandoned-write hang-up refusal has been used. */
  let abandonedHangupRefused = false;
  /**
   * LVX132: whether the one-shot "you never asked" hang-up refusal has been
   * used. Same reasoning as the line above, and the same reason it lives here:
   * services/tools.js is stateless and shared with the cascade, and a guard
   * that can refuse twice can hold a caller on the line indefinitely. One
   * refusal is a question the caller can answer; two is a trap.
   */
  let anythingElseRefused = false;
  /**
   * LVX157. WHICH completed action the no-ask refusal was spent on.
   *
   * `anythingElseRefused` above was one-shot per CALL, and CA84dc64 is what
   * that costs: the refusal was spent at 20:56:22 on a cancel the caller
   * abandoned, a booking completed at 20:58:31, and the sign-off at 20:58:36
   * went through with nobody ever asked. The gate was inert at the only moment
   * it mattered because an earlier, unrelated hang-up attempt had used it up.
   *
   * So the latch is scoped to the work rather than to the call: one refusal
   * per completed action. Two hang-up attempts with nothing written in between
   * still get exactly one refusal -- LVX21's rule, unchanged, and
   * tests/liveEndCallAsk.test.js's "lets the second hang-up through" pins it.
   *
   * null means never spent. The comparison is against completedActionCount at
   * the moment of the attempt, so it re-arms only when a write has LANDED.
   */
  let anythingElseRefusedAtAction = null;
  /**
   * LVX157. How many times the no-ask refusal has RE-ARMED on this call.
   *
   * Kept here beside the latch it describes, and returned, because the process
   * counter that shipped with it could not answer for a single call -- which is
   * exactly what made `CA98d6b04` unreadable the first time it was asked.
   */
  let anythingElseRearms = 0;

  // -------------------------------------------------------------------------
  // THE HAMMERING BRAKE.
  //
  // CA03558d, 2026-09-17: five book_appointment calls in 2.3 seconds, then
  // live_tool_rounds_capped three times. Six attempts on the call, zero rows.
  // CA919b69 did the same and landed only when the attempt budget gave up.
  //
  // Nothing bounded it, and the arithmetic is exact:
  //
  //   - a REFUSED write is never cached. guards.js caches only successes, and
  //     deliberately: a transient failure must stay retryable.
  //   - neither budget increments inside a caller turn. orderRefusalIsNew and
  //     writeAttemptBudget both key on ctx.callerTurnCount, so a model calling
  //     the same tool five times in one turn spends nothing.
  //   - the only in-turn brake is MAX_TOOL_ROUNDS = 5, counted per MODEL turn
  //     and reset in applyTurn. On 3.8 turnComplete lands a median 17 ms after
  //     a tool call, so the counter resets almost immediately and the model
  //     gets another five.
  //
  // So: an identical write, refused, with NOTHING the gate reads having
  // changed, is answered with the answer it already got.
  //
  // THE KEY IS THE GATE'S OWN INPUTS, and that is the whole care in this. A
  // cache keyed on the tool and its arguments alone would be wrong and would
  // lose bookings: the legitimate shape is the model being refused, THEN
  // reading the details back, then retrying -- which is what CA919b69 does and
  // what the gate is supposed to reward. lastReplyText changes at that point,
  // the key changes with it, and the gate runs again. The echo fires only when
  // the caller's words, the assistant's last words, the caller turn and the
  // arguments are all identical, i.e. when re-running could not produce a
  // different answer.
  //
  // Cleared by nothing: a stale entry is impossible by construction, because
  // any state change is already part of the key.
  // -------------------------------------------------------------------------
  const refusalEcho = new Map();
  const echoKey = (fc, state) =>
    [
      fc?.name,
      textFingerprint(JSON.stringify(fc?.args ?? {}, Object.keys(fc?.args ?? {}).sort())),
      Number(state?.callerTurnCount) || 0,
      textFingerprint(state?.lastCallerText ?? ""),
      textFingerprint(state?.lastReplyText ?? ""),
    ].join("|");

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
     * LVX157. How many completion notes went out on this tool round.
     *
     * Returned rather than left to bumpCounter alone, because the counter that
     * matters is the POSITIVE TWIN in auditTurn -- did the model actually ask
     * afterwards -- and that lives a file away, at turnComplete. A note count
     * with no honoured count beside it cannot tell a working instruction from
     * one the model reads and ignores, which is the whole history of this area.
     */
    let completionAskNotes = 0;
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
        //
        // Nor is a read answered from the turn memo -- the model gets the same
        // successful answer the tool gave it a moment ago.
        //
        // STATED PRECISELY, because the obvious justification for this line is
        // not the true one: it is NOT load-bearing for toolsRanThisTurn()
        // (lib/voice/live/index.js:810, realTool - refused > 0). A memo hit
        // requires an earlier allowed, successful call for the same key in the
        // same turn, so that subtraction cannot reach zero through it. This is
        // consistency. The one state where it WOULD change an outcome is a memo
        // that survived a turn boundary, and the reset is asserted at every
        // boundary in tests/liveToolMemoWire.test.js rather than trusted.
        if (verdict.reason !== "duplicate_write" && verdict.reason !== "read_memo") {
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

      // The hammering brake. See refusalEcho above: this fires only when
      // re-running the gate could not produce a different answer, so it costs
      // the model nothing it could have had.
      // `lastChance` is EXEMPT, and a test caught this rather than a reading of
      // the code. saveOutstandingMessage re-issues a refused message write at
      // finish(), after the line is down, under an exemption the gate grants it
      // -- but the caller and assistant text are whatever the last turn left
      // behind, so the key matches the refusal that was just cached and the
      // sweep gets handed it instead of running. That is "a message the caller
      // was promised outlives the call, or it does not exist at all", broken by
      // a cache. LVX117 named this exact call site as the one with no real-path
      // coverage; tests/messageLastChance.test.js is what went red.
      const echo =
        isAction && state?.lastChance !== true ? refusalEcho.get(echoKey(fc, state)) : null;
      if (echo) {
        bumpCounter("live_write_refusal_replayed");
        log.info("live_write_refusal_replayed", { tool: fc.name });
        // NOT counted as a refusal. The refusal it echoes was already counted
        // when it happened, and counting it again would spend the shared
        // attempt budget on a call that never reached a gate -- which is how
        // write_attempt_budget_released came to release CA919b69's booking for
        // the wrong reason.
        functionResponses.push({ ...echo, id: fc.id });
        continue;
      }

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
        // NOT measurement -- the write-order gate DECIDES on this one, so an
        // uncopied field here is a lost booking rather than a lost number. The
        // comment above earned itself again: the first run of
        // tests/liveConsentLatch.test.js failed with the latch implemented at
        // both ends and this line missing in the middle.
        lastReadBackKey: state.lastReadBackKey ?? null,
        lastReadBackText: state.lastReadBackText ?? null,
        // LVX72's refusal is allowed ONCE per call. The latch lives here rather
        // than in services/tools.js, which is stateless and shared with the
        // cascade -- and a guard that can refuse twice can hold a caller on the
        // line indefinitely.
        abandonedHangupRefusalSpent: abandonedHangupRefused,
        // LVX132, and the same wire warning as every field above it: produced
        // in turnState and not copied here, this reads as undefined downstream
        // and the gate silently never fires.
        askedAnythingElse: state.askedAnythingElse === true,
        // LVX157. Spent ONLY if it was spent on the work that stands now. The
        // field name and the meaning services/tools.js reads off it are both
        // unchanged -- "is the one-shot refusal still available" -- so that
        // file stays stateless and stays byte-identical for the cascade, which
        // supplies neither field and whose gate therefore still no-ops.
        anythingElseRefusalSpent:
          anythingElseRefused && anythingElseRefusedAtAction === completedActionCount,
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
      // LVX132's, spent the same way and for the same reason.
      if (effects.endCallNoAskRefusal) {
        // LVX157. A refusal arriving when one has already been spent EARLIER in
        // the call can only mean the latch re-armed, and it re-arms on exactly
        // one thing: a write landed since. Counted here rather than inferred
        // from the refusal total, because `end_call_refusals.no_ask` reading 2
        // does not say whether the second was a re-arm or a gate that had
        // stopped latching at all -- and those need opposite fixes.
        if (anythingElseRefused && anythingElseRefusedAtAction !== completedActionCount) {
          anythingElseRearms += 1;
          bumpCounter("end_call_ask_rearmed_by_action");
        }
        anythingElseRefused = true;
        anythingElseRefusedAtAction = completedActionCount;
      }

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
          completedActionCount += 1;
          // -------------------------------------------------------------------
          // LVX157, LAYER A. THE ONE SEAM WHERE A SIGN-OFF CAN STILL BE
          // PREVENTED RATHER THAN CAUGHT.
          //
          // Two thirds of the time the assistant finishes an action it signs
          // off in the same breath and never asks whether the caller needs
          // anything else. Every guard for that sits downstream of the words:
          // end_call's declaration REQUIRES the farewell in the same response
          // as the call, so by the time any gate runs the sentence exists.
          //
          // bfb65fb tried to make the words wait and f603af4 reverted it the
          // same day -- "You're all set then", then six seconds of dead air,
          // then a silence nudge. Nothing here defers a word. This is an
          // instruction delivered with the RESULT, which the model reads before
          // it composes anything about the write at all.
          //
          // THE SEAM IS REAL AND WAS MEASURED, not assumed. Across the 33
          // end_call attempts in call-corpus/ that follow a successful write,
          // the SHORTEST gap between the two is 1.86 seconds and not one pair
          // shares a tool batch. The model always gets this back, and decides
          // whether to hang up, in a later round.
          //
          // On the one shape where it would not -- a write and an end_call
          // declared in the SAME batch -- this note is attached to a response
          // the model has not read yet. That case is Layer B's, and it is why
          // there are two layers rather than a note on its own.
          //
          // `next_step` rather than `message`: packs own `message` and several
          // of them put caller-facing text in it. A separate key cannot collide
          // with one, and the "[not caller speech]" prefix is the convention
          // every other model-facing instruction in this codebase already uses.
          // -------------------------------------------------------------------
          if (result.functionResponse?.response) {
            result.functionResponse.response.next_step = COMPLETION_ASK_NOTE;
            completionAskNotes += 1;
            bumpCounter("live_completion_ask_note_sent");
          }
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
          // Remember the refusal against the state that produced it, so an
          // identical retry with nothing changed is answered rather than
          // re-gated. See refusalEcho.
          refusalEcho.set(echoKey(fc, state), result.functionResponse);
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
      completionAskNotes,
      completedActionCount,
      anythingElseRearms,
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
