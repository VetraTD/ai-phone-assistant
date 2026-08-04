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

/** An opening token that never closed — stripped to the end of its line. */
const UNTERMINATED_MARKER_RE = /[*`_~]*<<\s*intent\s*:[^\n]*/gi;

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
    return text.replace(ANY_MARKER_RE, "").replace(UNTERMINATED_MARKER_RE, "");
  } catch {
    return text;
  }
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

  /** Drop a separator still owed from a matched marker. */
  function takeSeparator(text) {
    if (!eatSeparator) return text;
    const out = text.replace(/^[ \t]*\r?\n?/, "");
    // Only stop waiting once there is real text to anchor on; an empty delta
    // leaves the separator still owed.
    if (out.length > 0 || text.length > 0) eatSeparator = false;
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
      if (!couldBeMarker(buf) || buf.includes("\n") || buf.length >= MAX_MARKER_CHARS) {
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
