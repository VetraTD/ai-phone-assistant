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

const REASK_NUMBER_TEXT =
  "Sorry, I didn't catch the full number. Could you say it again, digit by digit?";

const YES_RE = /\b(yes|yeah|yep|right|correct|that's right|uh-huh)\b/i;
const NOISH_MESSAGE_RE = /\b(no|nope|no thanks|that's it|that's all)\b/i;

const NAME_PREFIX_RE = /^\s*(my name is|this is|it's)\s+/i;

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

  function finishSuccess() {
    const finalMessage = message || "(caller did not leave details)";
    say(
      `Great. I've got your message, and someone from ${businessName} will get back to you as soon as possible. Thanks for calling, and sorry again for the trouble. Goodbye!`
    );
    active = false;
    currentState = "done";
    onComplete?.({ callerName: name, callbackNumber, message: finalMessage });
  }

  function finishFail() {
    active = false;
    currentState = "failed";
    onFail?.();
  }

  function acceptNumber(digits, { viaCallerId = false } = {}) {
    callbackNumber = digits;
    if (viaCallerId) say("No problem — I'll use the number you're calling from.");
    const grouped = groupDigits(digits);
    sayAndSetState(`Got it — that's ${grouped}. Is that right?`, "confirming_number");
  }

  /** A number attempt (short digits, or a "no" to the read-back) failed — re-ask once, then fall back to caller ID. */
  function handleNumberFailure() {
    numberAttempts++;
    if (numberAttempts >= 2) {
      acceptNumber(extractDigits(callerPhone), { viaCallerId: true });
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
          const digits = extractDigits(text);
          const valid = digits.length >= 7 && digits.length <= 15;
          if (valid) {
            acceptNumber(digits, { viaCallerId: false });
          } else {
            handleNumberFailure();
          }
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
