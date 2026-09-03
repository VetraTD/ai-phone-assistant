import { sanitizeOutbound } from "../speakableText.js";

// ---------------------------------------------------------------------------
// LVX21 -- what stands between the model's internals and the caller's ear.
//
// The cascade has a text-to-speech boundary and filters everything crossing it
// (lib/voice/session.js -> toSpeakable -> sanitizeOutbound -> tts.write). That
// machinery exists because `get_caller_appointments_from_db` reached a caller
// on 2026-08-04 and an orphaned `{reason:}` blob did the same on 2026-08-29.
//
// On this path the model IS the voice. There is no boundary to filter, so the
// only signal available is outputAudioTranscription -- the vendor telling us
// what we are saying, while we are saying it. That arrives AFTER the audio was
// generated but, because audioOut paces frames to Twilio and holds the rest
// locally, usually BEFORE it has been heard.
//
// ---------------------------------------------------------------------------
// Why sanitizeOutbound is the detector rather than a matcher written here
// ---------------------------------------------------------------------------
//
// A transcript of SPOKEN audio has no underscores: `cancel_appointment_db`
// comes back as "cancel appointment db". A hand-rolled matcher on the literal
// name would therefore miss every spoken leak -- the exact case this guard
// exists for -- and a matcher on the words alone would fire on "book an
// appointment".
//
// speakableText.js already builds each registry regex to span whitespace OR
// underscores, so it matches both forms, and it already knows about JSON
// blobs, identifiers, paths and stack traces. It is the cascade's own guard,
// exercised on every production call. Re-deriving it here would mean
// maintaining two.
//
// It is used as a PREDICATE only: `sanitized !== text` means something
// structural was in there. What it returns is discarded, because on this path
// the audio has already been generated and there is nothing left to rewrite.
// ---------------------------------------------------------------------------

/** How much prior transcript to re-scan, so a name split across two fragments
 *  is still seen whole. The longest declared name is ~32 chars; 200 is slack. */
const WINDOW_CHARS = 200;

/**
 * @param {object} ctx - the same shape lib/voice/session.js's leakCtx() builds:
 *   `{ toolNames, toolParamNames, fallback }`.
 */
export function createLeakGuard(ctx = {}) {
  const names = Array.isArray(ctx.toolNames) ? ctx.toolNames.filter(Boolean) : [];

  // For LABELLING only -- which vocabulary leaked, so the log says something
  // more useful than "a leak". The VERDICT is sanitizeOutbound's; these
  // patterns never decide anything, which is why a miss here is harmless.
  //
  // No escaping: these come from tool declarations, which are identifiers.
  // Longest first, so `cancel_appointment_db` wins over `cancel_appointment`.
  const labels = [...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => ({ name, re: new RegExp(name.split(/[_\s]+/).join("[ _]+"), "i") }));

  return {
    /**
     * @param {string} tail - transcript already accumulated for this turn
     * @param {string} fragment - what just arrived
     * @returns {{leaked: boolean, matched: string|null}}
     */
    inspect(tail, fragment) {
      const text = `${(tail || "").slice(-WINDOW_CHARS)}${fragment || ""}`;
      if (!text.trim()) return { leaked: false, matched: null };
      if (sanitizeOutbound(text, ctx) === text) return { leaked: false, matched: null };
      return { leaked: true, matched: labels.find((l) => l.re.test(text))?.name || null };
    },
  };
}

/**
 * What the model is told after it leaks.
 *
 * A note, not a forcing function: unlike the cascade's re-ask
 * (services/gemini.js, `toolConfig: { mode: "ANY" }`), a Live session fixes its
 * tools at connect and sendClientContent carries no toolConfig. This asks; it
 * cannot compel.
 */
export const LEAK_RECOVERY_NOTE =
  "(System: your last words contained internal system text - a tool name, " +
  "parameter name, or code - which the caller must never hear. It was cut off " +
  "mid-sentence, so the caller heard a partial sentence. Apologise briefly if " +
  "it helps, then continue naturally in plain language. Never speak tool names, " +
  "function names, parameter names, JSON, or code aloud.)";
