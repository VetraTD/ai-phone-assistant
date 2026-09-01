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

// The one import this module has. Pure and I/O-free, like everything else
// here: it reads a transcript string and returns a boolean, so the reducer
// stays drivable from the eval harness with no engine wiring.
import {
  looksLikeSpelling,
  looksLikeSpellingRefusal,
  looksLikeNonNameSpelling,
} from "../spellingSignal.js";

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
 * Raised 1 -> 3 on 2026-08-31. At 1 this was the ONLY thing standing between
 * the caller and a mis-spelled record, and it opened the moment the assistant
 * finished speaking — so a caller who was asked and simply talked about
 * something else had their mis-heard name written down. It is now the outer
 * backstop, not the policy: spellMissCap() below is what actually ends the
 * asking, and it ends it on the caller's answer rather than on ours.
 *
 * Read at call time, not module load, so tests and the sim can vary it without
 * reimporting — the same convention as transcriptUtils.holdNoPunctMs().
 *
 * @returns {number} default 3; 0 forbids spelling requests entirely
 */
export function spellAskCap() {
  const v = Number.parseInt(process.env.VOICE_SPELL_ASK_CAP, 10);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 3;
}

/**
 * How many asks may go UNANSWERED before the call stops asking.
 *
 * This is the escape hatch on an otherwise hard block, and it is the reason
 * the block is safe to make hard. A caller who cannot or will not spell — a
 * bad line, a distracted parent, someone who simply talks past the question —
 * must still be able to book. Two attempts, then the name is written as heard
 * and the call moves on.
 *
 * A "miss" is an ask that came back as neither letters nor a refusal. An
 * explicit refusal settles immediately and does not consume one of these.
 *
 * @returns {number} default 2; 0 means never block for a spelling at all
 */
export function spellMissCap() {
  const v = Number.parseInt(process.env.VOICE_SPELL_MISS_CAP, 10);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 2;
}

/**
 * Has this call already spent its spelling request(s)?
 *
 * Lives beside the counter that feeds it so the two cannot drift.
 *
 * @param {object} state - the call state carrying `spellAsks`
 * @returns {boolean}
 */
export function hasSpentSpellingAsk(state) {
  return (state?.spellAsks || 0) >= spellAskCap();
}

/**
 * Is the spelling question CLOSED for this call?
 *
 * The single question the prompt block and the write gate both ask, and the
 * replacement for `hasSpentSpellingAsk` in both of those roles. The difference
 * is the whole point of this change: the old flag closed when the assistant
 * had asked, this one closes when the caller has answered — or has visibly
 * declined to, or has been given the agreed number of chances.
 *
 * Four ways to settle, in the order they matter:
 *  - the caller spelled something (letters are the answer we wanted)
 *  - the caller declined (asking again is the nagging that got reported)
 *  - the asks went unanswered spellMissCap() times (the escape hatch)
 *  - the call hit its hard ask ceiling (backstop for a model that asks in a
 *    phrasing the miss counter never got to see)
 *
 * @param {object} state
 * @returns {boolean}
 */
export function spellingSettled(state) {
  if (!state) return false;
  if (state.spellingCaptured || state.spellingDeclined) return true;
  if ((state.spellAskMisses || 0) >= spellMissCap()) return true;
  return hasSpentSpellingAsk(state);
}

/**
 * Read the caller's side of the spelling exchange, BEFORE the turn is built.
 *
 * Called at the top of a turn by both drivers, because everything that acts on
 * the result — the SPELLING NOT YET CONFIRMED prompt block and the write gate
 * in services/tools.js — is decided from `extras`, which is assembled before
 * the model is called. Running this in applyReplyState (where it started) made
 * every signal one turn late: the caller spelled their name, and on that very
 * turn the prompt still told the model to ask for a spelling and the gate
 * still refused the booking for not having one.
 *
 * Letters are checked unconditionally, not only while an ask is pending: a
 * caller who volunteers "it's Bell, B-E-L-L" without being asked has still
 * spelled it, and re-asking would be the exact repetition this area exists to
 * stop. A REFUSAL only counts in reply to a question, which is what makes a
 * bare "no" safe to read as one — and because this now runs on every turn,
 * the pending flag is consumed on the next turn rather than surviving to a
 * much later one where an unrelated "no worries" could settle it.
 *
 * No strings supplied means no detection at all, matching the "unaffected
 * other callers" contract the ask counter has.
 *
 * @param {object} state - the call state
 * @param {string} userText - what the caller just said
 * @param {object|null} strings - the call's locale table
 */
export function applyCallerSpellingSignal(state, userText, strings) {
  if (!state || !strings || !userText) return;
  if (looksLikeSpelling(userText, strings)) {
    // ...unless they are plainly spelling something else. A volunteered
    // email address is a letter run too, and counting it would open the NAME
    // gate for the rest of the call. The guard is skipped when a spelling ask
    // is outstanding, because in that case we asked about the name and an
    // answer to that question is what we are being given.
    if (state.spellAskPending || !looksLikeNonNameSpelling(userText)) {
      state.spellingCaptured = true;
      state.spellAskPending = false;
      return;
    }
  }
  if (!state.spellAskPending) return;
  if (looksLikeSpellingRefusal(userText, strings)) {
    state.spellingDeclined = true;
  } else {
    // Asked, and got something that was neither letters nor a no. One of the
    // caller's limited chances, and the reason the block can be hard without
    // being able to trap a call.
    state.spellAskMisses = (state.spellAskMisses || 0) + 1;
  }
  state.spellAskPending = false;
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
  //
  // The CALLER's half of this exchange is deliberately NOT here — see
  // applyCallerSpellingSignal, which both drivers call at the TOP of the turn.
  // It lived here first and was a turn late: buildExtras runs before the LLM
  // call and this reducer runs after it, so on the turn the caller actually
  // spelled their name the prompt still said "they have not spelled it" and
  // the write gate still refused the booking. That is the re-asking loop this
  // whole area exists to close, reintroduced by putting the read on the wrong
  // side of the turn.
  if (spellRequestRe && replyText && spellRequestRe.test(replyText)) {
    state.spellAsks = (state.spellAsks || 0) + 1;
    // Armed for the next turn, so the caller's reply can be judged against a
    // question we know was asked.
    state.spellAskPending = true;
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
