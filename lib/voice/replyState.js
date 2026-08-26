// ---------------------------------------------------------------------------
// replyState.js — the pure state transitions applied after an LLM reply.
//
// Extracted verbatim from lib/voice/session.js applyReply so a text-conversation
// eval harness can drive the exact same reducer the live voice session does,
// and so neither channel can silently drift from the other. This module does
// NO I/O: no logging, no timers, no network. It mutates the passed-in state
// object exactly like the live session, and returns just enough for the caller
// to emit its identical log lines (intent_set, step_transition, turn_completed).
//
// Everything channel-specific — logging, close-mark arming, transcript
// persistence, transfers — stays in the caller. Effects dispatch and capability
// merge are injected as hooks so the reducer stays free of engine wiring.
// ---------------------------------------------------------------------------

/**
 * The exact framing that wraps a system note. Exported (rather than duplicated)
 * so history trimming (lib/voice/historyTrim.js) can identify note entries and
 * strip them back down to their inner text when hoisting evicted notes — the
 * single source of truth for the format lives here.
 */
export const SYSTEM_NOTE_PREFIX = "[system note — not the caller speaking: ";
export const SYSTEM_NOTE_SUFFIX = ".]";

/**
 * The single source of the system-note history format, shared with the salvage
 * path (session.js salvageDurableEffects). A system note is a synthetic "user"
 * turn that tells the model an action already happened so it never redoes it —
 * the framing text makes clear it is not the caller speaking.
 *
 * @param {string[]} notes
 * @returns {{ role: "user", parts: [{ text: string }] }}
 */
export function systemNoteEntry(notes) {
  return {
    role: "user",
    parts: [{ text: `${SYSTEM_NOTE_PREFIX}${notes.join("; ")}${SYSTEM_NOTE_SUFFIX}` }],
  };
}

/**
 * Apply an LLM reply's state effects to a session-shaped state object.
 *
 * Pure w.r.t. I/O: no logging, no timers, no network. Mutates `state`
 * (history, step, intent, consecutiveFailures, capability scratchpad) in the
 * exact order the live session does.
 *
 * @param {object} state - { history, step, intent, consecutiveFailures, ... }
 * @param {object} turn - { userText, reply }
 *   reply: { text, intentArgs?, endCallArgs?, capabilityState?, capabilityEffects? }
 * @param {object} hooks
 * @param {object} hooks.STEPS - the step-name enum
 * @param {(patch:any)=>void} hooks.mergeCapabilityState - merge a scratchpad patch
 * @param {(effects:any)=>string[]} hooks.dispatchEffects - dispatch capability
 *   effects, returning history notes; may itself mutate state.step.
 * @returns {{
 *   intentSet: { intent:string, prevStep:string, newStep:string } | null,
 *   capabilityNotes: string[],
 *   ended: boolean,
 * }}
 */
/**
 * How many times ONE call may ask the caller to spell something.
 *
 * Read at call time, not module load, so tests and the sim can vary it without
 * reimporting — the same convention as transcriptUtils.holdNoPunctMs().
 *
 * @returns {number} default 1; 0 forbids spelling requests entirely
 */
export function spellAskCap() {
  const v = Number.parseInt(process.env.VOICE_SPELL_ASK_CAP, 10);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 1;
}

/**
 * Has this call already spent its spelling request(s)?
 *
 * Lives beside the counter that feeds it so the two cannot drift, and is used
 * by BOTH drivers (lib/voice/session.js and lib/harness/textSession.js) to
 * build the same prompt extra.
 *
 * @param {object} state - the call state carrying `spellAsks`
 * @returns {boolean}
 */
export function hasSpentSpellingAsk(state) {
  return (state?.spellAsks || 0) >= spellAskCap();
}

export function applyReplyState(state, { userText, reply }, { STEPS, mergeCapabilityState, dispatchEffects, spellRequestRe }) {
  // (1) A successful LLM turn resets the failure streak so a transient blip
  // followed by a good turn doesn't leave the fallback threshold primed.
  state.consecutiveFailures = 0;

  const { text: replyText, intentArgs, endCallArgs } = reply;

  // (2) Conversation history.
  state.history.push({ role: "user", parts: [{ text: userText }] });
  state.history.push({ role: "model", parts: [{ text: replyText }] });

  // (2b) Count spelling requests. This lives in the SHARED reducer rather than
  // in session.js on purpose: textSession.js drives the eval suite and the CLI
  // through the same reducer, and anything implemented in only one of the two
  // "goes inert for every eval scenario and the CLI even though it works live"
  // — the exact trap the capabilityState comment in textSession.js warns about.
  // A cap the eval cannot see is a cap that regresses silently, which is how
  // the nine-turn spelling livelock survived with every hard assert green.
  //
  // No regex supplied means no counting, so any other caller is unaffected.
  if (spellRequestRe && replyText && spellRequestRe.test(replyText)) {
    state.spellAsks = (state.spellAsks || 0) + 1;
  }

  // (4) Intent. Setting an intent early in the call advances the step; once
  // details are being gathered (or beyond), the step is left alone.
  let intentSet = null;
  if (intentArgs) {
    const prevStep = state.step;
    state.intent = intentArgs.intent;
    if (state.step === STEPS.IDENTIFY_INTENT || state.step === STEPS.CONFIRM) {
      state.step = STEPS.GATHER_DETAILS;
    }
    intentSet = { intent: intentArgs.intent, prevStep, newStep: state.step };
  }

  // (5,6) Capability-declared effects. Dispatched AFTER intentArgs so a
  // completed action wins the step over an intent change in the same turn — the
  // caller did the thing, and the call should reflect that rather than dropping
  // back to gathering details. dispatchEffects may mutate state.step (via the
  // injected setStep closure); that is expected.
  mergeCapabilityState(reply.capabilityState);
  const capabilityNotes = dispatchEffects(reply.capabilityEffects);

  // (7) A history note so the model remembers the action happened.
  if (capabilityNotes.length > 0) {
    state.history.push(systemNoteEntry(capabilityNotes));
  }

  // (8, state part) End-call intentionally runs last so it wins the step over
  // anything an effect set above.
  const ended = Boolean(endCallArgs);
  if (ended) {
    state.step = STEPS.ENDING;
  }

  return { intentSet, capabilityNotes, ended };
}
