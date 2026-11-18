/**
 * Text-channel tool-call stripper.
 *
 * Gemini is supposed to emit a function call as a structured `functionCall`
 * part. Sometimes it writes one into the TEXT channel instead, in its own
 * internal namespace syntax:
 *
 *   default_api:get_caller_appointments_from_db{} One moment while I check that for you.
 *
 * Two things go wrong at once when that happens, and they were reported as
 * separate bugs:
 *
 *   1. Nothing runs. There is no functionCall part, so the tool never executes,
 *      the model has no result to work from, and the caller hears a promise
 *      followed by silence. On the call this was found on, the model went on to
 *      invent an appointment id that does not exist in the database.
 *   2. The caller hears it. `default_api:get_caller_appointments_from_db` reads
 *      aloud as "default api get caller appointments from db" — the "API" leak.
 *
 * There is no SDK-level signal to key off: services/gemini.js's textFromChunk
 * concatenates every non-thought `part.text`, and a pseudo-call arrives as
 * ordinary text. Detection has to be lexical, which is what this module is.
 *
 * Deliberately NOT an executor. It reports what the model appears to have
 * meant; services/gemini.js decides what to do about it, and the answer is to
 * make the model call the tool properly rather than to act on parsed text —
 * these arguments have had no schema validation and, on the observed call,
 * contained a hallucinated id.
 *
 * The tool-name set is passed in from the LIVE declaration list, never
 * hardcoded, so a business's webhook tools and any pack added later are covered
 * without touching this file.
 *
 * A THIRD failure, found 2026-08-29: this module can produce the leak itself.
 * `sweep()` runs BARE_NS_RE unconditionally after CALL_RE, so a delta boundary
 * landing before the closing brace leaves CALL_RE unable to match while
 * BARE_NS_RE still deletes the NAME — orphaning the arguments as ordinary text:
 *
 *   default_api:end_call{reason:Caller declined further assistance.  ->
 *                       {reason:Caller declined further assistance.
 *
 * A caller heard exactly that read aloud. Hence the nameless-blob rule (keyed
 * on live PARAMETER names, same registry principle as the tool names) and the
 * rewritten holdIndex, which scans rather than taking one anchored shot.
 */

// A hold longer than this is worse than the leak it prevents: held text is
// dead air, which is the bug being fixed. Nothing legitimate looks like an
// unterminated call for this long.
const MAX_HOLD_CHARS = 400;

/** Gemini's own tool namespace, as it appears in the text channel. */
const NAMESPACE = "default_api";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split an argument blob on commas that are not nested inside brackets or
 * quotes. The model's output is not JSON — see parseToolCallArgs.
 * @param {string} blob
 * @returns {string[]}
 */
function splitTopLevel(blob) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const ch of blob) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth <= 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const unquote = (s) => s.replace(/^\s*["']?/, "").replace(/["']?\s*$/, "").trim();

/**
 * Parse a pseudo-call's argument blob.
 *
 * Lenient on purpose. The observed production form was
 * `{caller_name:Boris Johnson}` — unquoted key AND unquoted value containing a
 * space — so JSON.parse is useless here. Splits on top-level commas, then on
 * the FIRST colon, which keeps an ISO datetime (`2026-08-06T14:00:00`) whole.
 *
 * Reports `ok:false` rather than guessing. A caller's appointment is not worth
 * a heuristic, and the recovery path treats an unparseable call the same as a
 * parseable one anyway: it asks the model to call the tool properly.
 *
 * @param {string} blob - the text between the brackets
 * @returns {{ok: boolean, args: Record<string, string>}}
 */
export function parseToolCallArgs(blob) {
  const body = (blob || "").trim();
  if (!body) return { ok: true, args: {} };
  const args = {};
  let ok = true;
  for (const frag of splitTopLevel(body)) {
    const at = frag.indexOf(":");
    if (at === -1) { ok = false; continue; }
    const key = unquote(frag.slice(0, at));
    const value = unquote(frag.slice(at + 1));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { ok = false; continue; }
    args[key] = value;
  }
  return { ok, args };
}

/**
 * Create a streaming stripper for one model turn.
 *
 * Contract mirrors lib/intentMarker.js's createMarkerStripper — push(delta)
 * returns the text safe to speak plus anything detected; flush() releases what
 * is held. Unlike the marker stripper it never "resolves": a pseudo-call can
 * appear anywhere in a reply, including after paragraphs of ordinary speech.
 *
 * @param {object} opts
 * @param {string[]} opts.toolNames - the LIVE declaration names for this call
 * @param {string[]} [opts.toolParamNames] - every PARAMETER name those
 *   declarations expose. Used for the nameless-blob rule below: on 2026-08-29 a
 *   caller heard `{reason:Caller declined further assistance and said thank
 *   you. }` with no function name in front of it, because the name had already
 *   been excised and the arguments left behind. Registry-driven for the same
 *   reason the names are — a business's webhook tool's parameters are covered
 *   without touching this file.
 * @returns {{push: (delta: string) => {text: string, calls: object[]},
 *            flush: () => {text: string, calls: object[]}}}
 */
export function createToolCallTextStripper({ toolNames = [], toolParamNames = [] } = {}) {
  const names = [...new Set(toolNames.filter((n) => typeof n === "string" && n))]
    // Longest first so `cancel_appointment_db` wins over a hypothetical
    // `cancel_appointment` rather than leaving `_db` behind to be spoken.
    .sort((a, b) => b.length - a.length);
  const params = [...new Set(toolParamNames.filter((n) => typeof n === "string" && n))];
  const paramSet = new Set(params);

  if (names.length === 0) {
    // No registry, nothing to detect. Pass-through rather than guess at shapes,
    // so a misconfigured call never holds text.
    return {
      push: (delta) => ({ text: delta ?? "", calls: [] }),
      flush: () => ({ text: "", calls: [] }),
    };
  }

  const nameAlt = names.map(escapeRe).join("|");

  // ns:NAME{...} / ns.NAME(...) / NAME{...}, optionally wrapped in print(...).
  const CALL_RE = new RegExp(
    String.raw`(?:print\s*\(\s*)?` +
      String.raw`(?:${NAMESPACE}\s*[.:]\s*)?` +
      `(${nameAlt})` +
      String.raw`\s*(?:\{([^{}]*)\}|\(([^()]*)\))` +
      String.raw`\s*\)?`,
    "g"
  );

  // A namespaced name with no argument block at all. Requires the namespace:
  // a bare tool name in prose is a leak for the TTS-boundary guard to mute,
  // not a call to act on.
  const BARE_NS_RE = new RegExp(`${NAMESPACE}\\s*[.:]\\s*(${nameAlt})`, "g");

  // A fenced block that contains a registered name — ```tool_code, ```json, or
  // an unlabelled fence. Consumed whole, so the fence markers are never spoken.
  const FENCE_RE = /```[a-z_]*\r?\n?([\s\S]*?)```/g;

  // A bracketed blob with no function name in front of it. Only excised when
  // EVERY key it contains is a real parameter of a real registered tool — braces
  // in prose ("the note said {see reception}") are not evidence of anything, and
  // deleting them would be a worse bug than the one this fixes.
  const NAMELESS_ARGS_RE = /[{(]([^{}()]*)[})]/g;

  let buf = "";

  /** Pull every complete pseudo-call out of `buf`, returning what was found. */
  function sweep() {
    const calls = [];

    buf = buf.replace(FENCE_RE, (whole, inner) => {
      const found = [];
      for (const m of inner.matchAll(CALL_RE)) {
        found.push(makeCall(m, "fenced"));
      }
      if (found.length === 0) return whole; // an ordinary code fence, leave it
      calls.push(...found);
      return " ";
    });

    buf = buf.replace(CALL_RE, (whole, name, braceArgs, parenArgs) => {
      calls.push(makeCall([whole, name, braceArgs, parenArgs], detectShape(whole, braceArgs)));
      return " ";
    });

    buf = buf.replace(BARE_NS_RE, (whole, name) => {
      calls.push({ name, shape: "bare_namespaced", args: {}, parseOk: false });
      return " ";
    });

    // LAST, deliberately. BARE_NS_RE above removes a name and leaves its
    // argument blob behind whenever a delta boundary landed before the closing
    // brace — that orphan is exactly what a caller heard read aloud. Running
    // this after it cleans up the orphan as well as catching a blob that
    // arrived nameless in the first place.
    //
    // `name: null` because nothing here says WHICH tool was meant. The recovery
    // path in services/gemini.js picks the first call that has a name; this one
    // exists to be counted and silenced, not acted on.
    if (params.length) {
      buf = buf.replace(NAMELESS_ARGS_RE, (whole, blob) => {
        const { args } = parseToolCallArgs(blob);
        const keys = Object.keys(args);
        if (!keys.length || !keys.every((k) => paramSet.has(k))) return whole;
        calls.push({ name: null, shape: "nameless_args", args: {}, parseOk: false });
        return " ";
      });
    }

    return calls;
  }

  function detectShape(whole, braceArgs) {
    if (braceArgs !== undefined) return whole.includes(":") && whole.includes(NAMESPACE) ? "colon_brace" : "brace";
    return "paren";
  }

  function makeCall(m, shape) {
    const blob = m[2] !== undefined ? m[2] : m[3];
    const { ok, args } = parseToolCallArgs(blob ?? "");
    return { name: m[1], shape, args, parseOk: ok };
  }

  /**
   * Index from which `buf` must be held back because it could still turn into a
   * pseudo-call. Everything before it is safe to speak now.
   *
   * A SCAN, not one anchored regex. The regex this replaces let the optional
   * `[.:]` separator start on the preceding PROSE word, so
   * "...wonderful day.  {reason:" produced head = "day", matched nothing, and
   * the whole buffer - pseudo-call included - went straight to TTS. That is the
   * 2026-08-29 leak. One regex shot cannot recover from it: when the widest
   * candidate is not viable, something has to try a narrower one.
   *
   * Left to right, first viable wins - holding MORE is the safe direction, and
   * MAX_HOLD_CHARS already bounds how long anything is held. buf is normally a
   * few characters (it is sliced to the hold point after every push), so the
   * scan is not the latency the old comment was worried about.
   */
  function holdIndex() {
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      const prev = i === 0 ? "" : buf[i - 1];
      const starts =
        (ch === "`" && prev !== "`") ||
        ch === "{" ||
        ch === "(" ||
        (/[A-Za-z]/.test(ch) && !/[A-Za-z0-9_]/.test(prev));
      if (!starts) continue;
      if (viableOpener(buf.slice(i))) return i;
    }
    return buf.length;
  }

  /** Could this trailing token still grow into a pseudo-call? */
  function viableOpener(token) {
    if (token.startsWith("`")) return true;

    // A bracketed blob with no name in front of it - the orphan shape. Held
    // only while it is still unterminated AND its first key is (or could still
    // become) a real tool parameter: a terminated blob is sweep()'s problem,
    // and a blob whose key means nothing to us is prose.
    if (token[0] === "{" || token[0] === "(") {
      if (!params.length) return false;
      if (/[})]/.test(token)) return false;
      const keyed = /^[{(]\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/.exec(token);
      if (keyed) return paramSet.has(keyed[1]);
      const partial = /^[{(]\s*["']?([A-Za-z_][A-Za-z0-9_]*)?$/.exec(token);
      if (partial) return params.some((n) => n.startsWith(partial[1] || ""));
      return false;
    }

    // A namespace, whole or partial ("defa", "default_api:resche").
    const head = token.split(/[.:({]/)[0].trim();
    if (!head) return false;
    if (NAMESPACE.startsWith(head) || head === NAMESPACE) return true;

    // An identifier that is a registered name, or could still become one.
    const openedBracket = /[{(]/.test(token);
    if (names.some((n) => n === head)) return true; // args may follow
    if (!openedBracket && names.some((n) => n.startsWith(head))) return true;
    return false;
  }

  return {
    push(delta) {
      buf += delta ?? "";
      const calls = sweep();

      if (buf.length > MAX_HOLD_CHARS) {
        // Nothing legitimate stays an unterminated call this long. Release
        // rather than accumulate — a stuck buffer is dead air.
        const text = buf;
        buf = "";
        return { text, calls };
      }

      const at = holdIndex();
      const text = buf.slice(0, at);
      buf = buf.slice(at);
      return { text, calls };
    },

    flush() {
      const calls = sweep();
      const text = buf;
      buf = "";
      return { text, calls };
    },
  };
}
