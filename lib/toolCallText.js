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
 * @returns {{push: (delta: string) => {text: string, calls: object[]},
 *            flush: () => {text: string, calls: object[]}}}
 */
export function createToolCallTextStripper({ toolNames = [] } = {}) {
  const names = [...new Set(toolNames.filter((n) => typeof n === "string" && n))]
    // Longest first so `cancel_appointment_db` wins over a hypothetical
    // `cancel_appointment` rather than leaving `_db` behind to be spoken.
    .sort((a, b) => b.length - a.length);

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
   * Only the tail can be an incomplete opener, so this is one anchored regex
   * rather than a scan — holding is latency, and latency on every delta of
   * every turn is not worth paying to catch a rare shape.
   */
  function holdIndex() {
    // The name half of `default_api:` is optional: a delta can end exactly on
    // the separator, and releasing there speaks the namespace out loud — which
    // is the whole defect.
    const m = /(?:^|[^A-Za-z0-9_`])(`{1,3}[a-z_]*|[A-Za-z][A-Za-z0-9_]*(?:\s*[.:]\s*(?:[A-Za-z][A-Za-z0-9_]*)?)?(?:\s*[{(][^})]*)?)$/.exec(buf);
    if (!m) return buf.length;
    const token = m[1];
    if (!viableOpener(token)) return buf.length;
    return buf.length - token.length;
  }

  /** Could this trailing token still grow into a pseudo-call? */
  function viableOpener(token) {
    if (token.startsWith("`")) return true;

    // A namespace, whole or partial ("defa", "default_api:resche").
    const head = token.split(/[.:({]/)[0].trim();
    if (NAMESPACE.startsWith(head) || head === NAMESPACE) return true;

    // An identifier that is a registered name, or could still become one.
    const openedBracket = /[{(]/.test(token);
    const ident = head;
    if (!ident) return false;
    if (names.some((n) => n === ident)) return true; // args may follow
    if (!openedBracket && names.some((n) => n.startsWith(ident))) return true;
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
