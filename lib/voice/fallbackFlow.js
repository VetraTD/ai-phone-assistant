// ---------------------------------------------------------------------------
// fallbackFlow.js — deterministic, zero-LLM "take a message" state machine.
//
// Used by session.js as a safety net when the LLM has failed repeatedly
// (see lib/voice/session.js's consecutiveFailures wiring). Once active this
// flow NEVER calls the LLM again for the remainder of the call — every
// caller utterance is handled by pure string matching against a small,
// fixed script, so a caller can always leave a message and hang up even if
// the model/API is completely down.
//
// Dependencies are injected (onSay/onComplete/onFail) so this module has no
// knowledge of TTS, Twilio, or the database — it is pure state + text.
// ---------------------------------------------------------------------------

import { isIncomplete } from "../transcriptUtils.js";

const REASK_NUMBER_TEXT =
  "Sorry, I didn't catch the full number. Could you say it again, digit by digit?";

const SKIP_NUMBER_TEXT =
  "No problem — let's move on. What's the message you'd like to leave?";

const YES_RE = /\b(yes|yeah|yep|right|correct|that's right|uh-huh)\b/i;
const NOISH_MESSAGE_RE = /\b(no|nope|no thanks|that's it|that's all)\b/i;

const NAME_PREFIX_RE = /^\s*(my name is|this is|it's)\s+/i;

// How long to hold a suspected split-number fragment (e.g. STT delivered
// "five five five one two three" as its own final, mid-number) waiting for
// the continuation, before giving up and processing it as a standalone
// attempt. Mirrors session.js's INCOMPLETE_HOLD_MS for the same underlying
// STT-splitting problem.
const NUMBER_HOLD_MS = 1_000;

const WORD_DIGITS = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
const WORD_DIGITS_RE = new RegExp(`\\b(${Object.keys(WORD_DIGITS).join("|")})\\b`, "gi");

/** Strip a leading "my name is" / "this is" / "it's" (case-insensitive). */
function stripNamePrefix(text) {
  const stripped = text.replace(NAME_PREFIX_RE, "").trim();
  return stripped || text.trim();
}

/** Extract a digit string from spoken text (numerals already, plus spelled-out digit words defensively). */
function extractDigits(text) {
  if (!text) return "";
  const withDigits = text.replace(WORD_DIGITS_RE, (m) => WORD_DIGITS[m.toLowerCase()]);
  return withDigits.replace(/\D/g, "");
}

/** Group a digit string 3-3-4 (with overflow handled) for a spoken read-back. */
function groupDigits(digits) {
  if (digits.length <= 4) return digits;
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}, ${digits.slice(3, 6)}, ${digits.slice(6)}`;
  }
  if (digits.length > 10) {
    const lead = digits.slice(0, digits.length - 10);
    const rest = digits.slice(digits.length - 10);
    return `${lead}, ${rest.slice(0, 3)}, ${rest.slice(3, 6)}, ${rest.slice(6)}`;
  }
  // 5-9 digits: chunks of 3 from the start, final group takes the remainder.
  const groups = [];
  let i = 0;
  while (digits.length - i > 4) {
    groups.push(digits.slice(i, i + 3));
    i += 3;
  }
  groups.push(digits.slice(i));
  return groups.join(", ");
}

/**
 * @param {object} opts
 * @param {string} opts.businessName
 * @param {string} [opts.callerPhone] - caller-ID number, used as a fallback
 *   callback number if the caller can't be understood twice.
 * @param {(text: string) => void} opts.onSay - speak a line (session's TTS path).
 * @param {(result: { callerName: string|null, callbackNumber: string|null, message: string }) => void} opts.onComplete
 * @param {() => void} opts.onFail - called when the flow cannot proceed at all
 *   (e.g. no info captured and the caller has gone silent).
 */
export function createFallbackFlow({ businessName, callerPhone = "", onSay, onComplete, onFail }) {
  let active = false;
  let currentState = null; // "awaiting_name" | "awaiting_number" | "confirming_number" | "awaiting_message" | "confirming_message" | "done" | "failed"
  let lastPrompt = "";
  let emptyStreak = 0;
  let numberAttempts = 0;
  let callerIdAttempted = false;
  let heldNumberFragment = null;
  let numberHoldTimer = null;
  let messageAppended = false;

  let name = null;
  let callbackNumber = null;
  let message = "";

  function say(text) {
    try {
      onSay?.(text);
    } catch {
      /* never let a downstream TTS error break the flow's own state */
    }
  }

  function sayAndSetState(text, nextState) {
    say(text);
    currentState = nextState;
    lastPrompt = text;
  }

  function clearNumberHold() {
    if (numberHoldTimer) {
      clearTimeout(numberHoldTimer);
      numberHoldTimer = null;
    }
    heldNumberFragment = null;
  }

  function finishSuccess() {
    clearNumberHold();
    const finalMessage = message || "(caller did not leave details)";
    say(
      `Great. I've got your message, and someone from ${businessName} will get back to you as soon as possible. Thanks for calling, and sorry again for the trouble. Goodbye!`
    );
    active = false;
    currentState = "done";
    onComplete?.({ callerName: name, callbackNumber, message: finalMessage });
  }

  function finishFail() {
    clearNumberHold();
    active = false;
    currentState = "failed";
    onFail?.();
  }

  /** Extract digits from `text` and either accept it as a number or run the
   * standard failure/re-ask/caller-ID-fallback path. Shared by the normal
   * awaiting_number handler and the held-fragment expiry flush below, so a
   * timed-out fragment is treated exactly like any other attempt. */
  function processNumberAttempt(text) {
    const digits = extractDigits(text);
    const valid = digits.length >= 7 && digits.length <= 15;
    if (valid) {
      acceptNumber(digits, { viaCallerId: false });
    } else {
      handleNumberFailure();
    }
  }

  /** A held number fragment's continuation never arrived within
   * NUMBER_HOLD_MS — stop waiting and process what we have as its own
   * (likely incomplete/invalid) attempt rather than stranding it forever. */
  function flushHeldNumberFragment() {
    numberHoldTimer = null;
    const fragment = heldNumberFragment;
    heldNumberFragment = null;
    if (!active || !fragment || currentState !== "awaiting_number") return;
    processNumberAttempt(fragment);
  }

  function acceptNumber(digits, { viaCallerId = false } = {}) {
    callbackNumber = digits;
    if (viaCallerId) say("No problem — I'll use the number you're calling from.");
    const grouped = groupDigits(digits);
    sayAndSetState(`Got it — that's ${grouped}. Is that right?`, "confirming_number");
  }

  /** No usable number at all (bad input, and caller ID isn't usable either) — stop trying and move on without one. */
  function skipNumber() {
    callbackNumber = null;
    sayAndSetState(SKIP_NUMBER_TEXT, "awaiting_message");
  }

  /**
   * A number attempt (bad/unusable digits, or a "no" to the read-back)
   * failed — re-ask once, then fall back to caller ID. If caller ID has
   * already been tried (accepted or itself rejected) or isn't usable, give
   * up on capturing a number entirely rather than looping forever between
   * awaiting_number/confirming_number.
   */
  function handleNumberFailure() {
    numberAttempts++;

    if (callerIdAttempted) {
      skipNumber();
      return;
    }

    if (numberAttempts >= 2) {
      callerIdAttempted = true;
      const callerDigits = extractDigits(callerPhone);
      const usable = callerDigits.length >= 7 && callerDigits.length <= 15;
      if (usable) {
        acceptNumber(callerDigits, { viaCallerId: true });
      } else {
        skipNumber();
      }
    } else {
      sayAndSetState(REASK_NUMBER_TEXT, "awaiting_number");
    }
  }

  function start() {
    if (active) return;
    active = true;
    emptyStreak = 0;
    sayAndSetState(
      "I'm having a little trouble on my end, but I can still take a message. Can I get your name, please?",
      "awaiting_name"
    );
  }

  function handleInput(rawText) {
    if (!active) return;
    try {
      const text = (rawText || "").trim();

      if (!text) {
        // A held number fragment must never be silently discarded. Without
        // this check, an empty final (caller went quiet, or STT delivered
        // nothing usable) while a fragment was held would fall straight into
        // the emptyStreak "wrap the call up" logic below and finish/fail
        // with callbackNumber still null — the held digits would simply
        // vanish, with no re-ask and no caller-ID fallback ever attempted.
        // Flush it now as its own attempt (same processNumberAttempt path
        // the hold-timeout uses) instead: either it's accepted, or
        // handleNumberFailure re-asks/falls back to caller ID.
        if (heldNumberFragment && currentState === "awaiting_number") {
          const fragment = heldNumberFragment;
          clearNumberHold();
          processNumberAttempt(fragment);
          return;
        }

        emptyStreak++;
        if (emptyStreak >= 2) {
          const hasInfo = !!(name || callbackNumber || message);
          if (hasInfo) finishSuccess();
          else finishFail();
          return;
        }
        if (lastPrompt) say(lastPrompt);
        return;
      }
      emptyStreak = 0;

      switch (currentState) {
        case "awaiting_name": {
          name = stripNamePrefix(text);
          sayAndSetState(
            `Thanks, ${name}. What's the best number to reach you? Please say it digit by digit.`,
            "awaiting_number"
          );
          break;
        }

        case "awaiting_number": {
          // Cheap hardening for STT splitting one recited number across two
          // finals (e.g. "five five five one two three" / "four five six
          // seven"): if this looks like a partial number and we're not
          // already holding a fragment, hold it silently and wait for the
          // continuation once — no re-prompt, no failure counted. The next
          // final (whatever it is) gets concatenated and processed normally.
          // Bounded: if the continuation never arrives, NUMBER_HOLD_MS later
          // flushHeldNumberFragment() processes the fragment on its own
          // instead of stranding it forever (see NUMBER_HOLD_MS above).
          if (heldNumberFragment) {
            const fragment = heldNumberFragment;
            clearNumberHold();
            // The caller may have simply RESTARTED with the full number
            // rather than continuing the fragment (e.g. held "555123" then
            // said "5551234567" in full) — concatenating unconditionally
            // would produce a 16-digit string and force a needless re-ask.
            // If this final already parses to a valid number on its own,
            // treat it as a fresh attempt instead of concatenating.
            const freshDigits = extractDigits(text);
            if (freshDigits.length >= 7 && freshDigits.length <= 15) {
              processNumberAttempt(text);
              break;
            }
            processNumberAttempt(`${fragment} ${text}`);
            break;
          } else if (isIncomplete(text)) {
            heldNumberFragment = text;
            numberHoldTimer = setTimeout(flushHeldNumberFragment, NUMBER_HOLD_MS);
            numberHoldTimer.unref?.();
            break;
          }

          processNumberAttempt(text);
          break;
        }

        case "confirming_number": {
          if (YES_RE.test(text)) {
            sayAndSetState("Perfect. And what's the message you'd like to leave?", "awaiting_message");
          } else {
            handleNumberFailure();
          }
          break;
        }

        case "awaiting_message": {
          message = text;
          sayAndSetState(
            `Let me read that back: ${message}. Anything you'd like to add or change?`,
            "confirming_message"
          );
          break;
        }

        case "confirming_message": {
          if (NOISH_MESSAGE_RE.test(text)) {
            finishSuccess();
          } else if (messageAppended) {
            // Already gave them one extra round to add/change — accept and move on.
            finishSuccess();
          } else {
            message = `${message} ${text}`.trim();
            messageAppended = true;
            sayAndSetState(
              `Let me read that back: ${message}. Anything you'd like to add or change?`,
              "confirming_message"
            );
          }
          break;
        }

        default:
          finishFail();
      }
    } catch {
      if (active) finishFail();
    }
  }

  function isActive() {
    return active;
  }

  function getState() {
    return currentState;
  }

  return { start, handleInput, isActive, getState };
}
