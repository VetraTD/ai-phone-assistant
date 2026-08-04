// ---------------------------------------------------------------------------
// In-band intent marker.
//
// The model declares the caller's intent as the first line of its reply:
//
//     <<intent:book_appointment>>
//     Sure, I can get that booked for you. What day works?
//
// rather than through a set_call_intent function call. The tool cost a full
// extra model round-trip (~700ms of a 3,062ms turn) for a value that is a no-op
// in the turn that produces it — see
// docs/superpowers/specs/2026-08-03-intent-marker-design.md.
//
// This module is pure: no I/O, no logging, no clock. It is consumed by
// services/gemini.js (streaming, the one strip point every caller of the model
// inherits) and by lib/voice/speakableText.js (defensive, so nothing
// marker-shaped can ever be spoken).
//
// The design accepts a failure class the function call did not have: text can
// be malformed, a tool call cannot. Everything below is about making the two
// consequences unequal — a garbled marker must degrade to "no intent", never to
// "wrong intent" and never to something the caller hears.
// ---------------------------------------------------------------------------

/** The opening token. Compared case-insensitively. */
const OPEN = "<<intent:";

/**
 * Decoration the model sometimes wraps the marker in (markdown emphasis,
 * backticks) plus leading whitespace. Tolerated by the parser, never by what
 * gets spoken.
 */
const DECORATION_RE = /^[\s*`_~]+/;

/**
 * Longest buffer held while deciding whether a marker is present. A marker that
 * has not closed by here is broken; releasing bounds the worst-case delay to
 * this many characters of generation.
 */
export const MAX_MARKER_CHARS = 64;

/**
 * A complete leading marker, plus the separator between it and the reply. The
 * value charset matches the tool enum it replaces (allowedTasks entries are
 * lowercase snake_case), with a length bound so a runaway generation cannot be
 * mistaken for one.
 */
const LEADING_MARKER_RE =
  /^[\s*`_~]*<<\s*intent\s*:\s*([a-zA-Z0-9_]{1,40})\s*>>[ \t*`_~]*\r?\n?/i;

/**
 * A complete marker anywhere in a string, plus the line break that followed it.
 * Taking the newline matters: the model writes the marker on its own line, so
 * leaving it behind turns a stripped marker into a stray blank line mid-reply.
 */
const ANY_MARKER_RE = /[*`_~]*<<\s*intent\s*:\s*[a-zA-Z0-9_]{0,40}\s*>>[*`_~]*[ \t]*\r?\n?/gi;

/**
 * A marker attempt that is not well-formed. Two alternatives, longest first:
 *
 *   1. terminated, but the value holds characters the strict pattern rejects
 *      (a space, a hyphen) — take the whole thing including the `>>`;
 *   2. never terminated — take the token plus a value-shaped run and the line
 *      break, so the value is not left behind to be read aloud.
 *
 * Both are bounded, and alternative 2's run excludes spaces so it stops at the
 * first word of real speech. An earlier version swept `[^\n]*`, which on a
 * voice reply (rarely containing a newline) ran to the end of the string and
 * deleted the entire reply: one wrong character in the value and the caller
 * heard the generic "say that again" line instead of the answer. Losing the
 * intent is acceptable; losing the reply is not.
 */
const MALFORMED_MARKER_RE =
  /[*`_~]*<<\s*intent\s*:[a-zA-Z0-9_ \t-]{0,40}>>[*`_~]*[ \t]*\r?\n?|[*`_~]*<<\s*intent\s*:[a-zA-Z0-9_-]{0,40}[ \t]*\r?\n?/gi;

/**
 * Can this buffer still turn into a marker if more text arrives?
 *
 * Answering "no" as early as possible is the entire latency argument for
 * putting the marker first: a reply starting "Sure," fails on its first
 * character and is released with nothing held back.
 *
 * @param {string} buf
 * @returns {boolean}
 */
function couldBeMarker(buf) {
  const lead = buf.replace(DECORATION_RE, "");
  if (lead.length === 0) return true; // only decoration so far
  const cmp = Math.min(lead.length, OPEN.length);
  return lead.slice(0, cmp).toLowerCase() === OPEN.slice(0, cmp);
}

/**
 * Remove anything marker-shaped from a finished string. Complete markers go
 * first so a well-formed one is not swallowed by the unterminated rule, which
 * eats to end of line.
 *
 * Never throws — returns the input unchanged if anything fails, matching the
 * contract of the toSpeakable helpers it sits alongside.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkerAnywhere(text) {
  try {
    if (typeof text !== "string") return text;
    if (!text.includes("<<")) return text; // cheap bail for the common case
    return text.replace(ANY_MARKER_RE, "").replace(MALFORMED_MARKER_RE, "");
  } catch {
    return text;
  }
}

/**
 * What is safe to write to a log line for a rejected marker value.
 *
 * The value is model output. The marker charset is `[a-zA-Z0-9_]`, which is
 * wide enough to hold an unformatted phone number or an account identifier if
 * the model ever misplaces caller data into that slot — and one deployment of
 * this codebase is in HIPAA scope.
 *
 * Every real task name is `[a-z_]+` (services/supabase.js CORE_TASKS /
 * MODULE_TASKS), so refusing to log anything containing a digit costs no
 * diagnostic signal: a genuine drift to an unenabled intent still logs its
 * name, and the one shape caller data would take does not.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeRejectedValue(value) {
  return typeof value === "string" && /^[a-z_]+$/i.test(value) ? value : "(redacted)";
}

/**
 * Create a streaming stripper for one model turn.
 *
 * @param {object} opts
 * @param {string[]} opts.allowedIntents - the business's allowedTasks. A value
 *   outside this list is stripped from the text but does NOT set an intent:
 *   leaking a marker to a caller is worse than losing one intent update.
 * @returns {{push: (delta: string) => {text: string, intent: string|null, rejected: string|null},
 *            flush: () => {text: string, intent: string|null, rejected: string|null}}}
 */
export function createMarkerStripper({ allowedIntents = [] } = {}) {
  let buf = "";
  let resolved = false;
  // A marker matched but its trailing separator may not have arrived yet: when
  // a delta ends exactly on ">>", the newline is the first character of the
  // NEXT delta and would otherwise be spoken as a leading blank line.
  let eatSeparator = false;

  /**
   * Drop a separator still owed from a matched marker. Tolerates the same
   * decoration the marker itself may be wrapped in, since a trailing backtick
   * can arrive in its own delta — and stays armed until it has actually seen
   * the line break or the reply proper, rather than giving up after one delta.
   */
  function takeSeparator(text) {
    if (!eatSeparator) return text;
    const consumed = /^[ \t*`_~]*\r?\n?/.exec(text)?.[0] ?? "";
    const out = text.slice(consumed.length);
    if (consumed.includes("\n") || out.length > 0) eatSeparator = false;
    return out;
  }

  /**
   * Give up on finding a marker and emit what is held. The buffer is swept
   * even though no marker matched: an opening token that never closed must not
   * survive the release either.
   */
  function release() {
    const text = stripMarkerAnywhere(buf).replace(/^[ \t]*\r?\n/, "");
    buf = "";
    resolved = true;
    return { text, intent: null, rejected: null };
  }

  return {
    push(delta) {
      // Resolved: this round's marker question is settled, so text flows
      // through. It is still swept, because the model sometimes emits the line
      // again partway through a round — the first live eval run caught exactly
      // that. Only whole markers within a single delta are caught here; the
      // leading case is the state machine's job above, and the voice path has
      // toSpeakable behind it as well.
      if (resolved) {
        return { text: takeSeparator(stripMarkerAnywhere(delta)), intent: null, rejected: null };
      }
      buf += delta;

      const m = LEADING_MARKER_RE.exec(buf);
      if (m) {
        const rest = buf.slice(m[0].length);
        buf = "";
        resolved = true;
        // The separator is owed only when the match stopped at ">>" with
        // nothing after it — otherwise the regex already consumed it.
        eatSeparator = rest.length === 0 && !/\n$/.test(m[0]);
        const value = m[1].toLowerCase();
        const allowed = allowedIntents.includes(value);
        return {
          text: takeSeparator(rest),
          intent: allowed ? value : null,
          rejected: allowed ? null : value,
        };
      }

      // Ruled out, ran past the first line, or ran past the length bound.
      // The newline test reads the DECORATION-STRIPPED buffer: a delta that is
      // nothing but "\n" is plausible when the model resumes generating after a
      // tool round, and testing the raw buffer made that stray newline resolve
      // the round before the marker had even started — throwing the declaration
      // away while the very next delta carried a perfectly good one.
      const lead = buf.replace(DECORATION_RE, "");
      if (!couldBeMarker(buf) || lead.includes("\n") || buf.length >= MAX_MARKER_CHARS) {
        return release();
      }
      return { text: "", intent: null, rejected: null };
    },

    flush() {
      if (resolved) return { text: "", intent: null, rejected: null };
      return release();
    },
  };
}
