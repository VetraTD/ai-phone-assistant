import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Self-echo detection — standalone module for the voice pipeline. One
// `createEchoGuard(opts)` instance per call.
//
// There is no acoustic echo cancellation anywhere in this pipeline. On a
// speakerphone the AI's own voice re-enters the caller's microphone loudly
// enough that:
//   1. the energy VAD (lib/voice/inboundVad.js) reports genuine voice — echo
//      has plenty of energy, so VAD confirmation cannot tell the two apart;
//   2. Deepgram transcribes it as caller speech; and
//   3. turnManager sees >=4 words arriving with VAD backing and fires a
//      barge-in — the AI interrupts ITSELF.
// Worse, once the AI has stopped, that echo's final arrives with the AI no
// longer "playing", so it closes the caller's turn and is handed to the LLM as
// if the caller had said it. The reply is new but unrelated, it plays, it
// echoes, and the call collapses into a start/stop loop that ends only when
// the caller gives up and goes silent. This module is what breaks that loop.
//
// turnManager.js used to assert (in a comment) that echo "would come back as
// the AI's own words, not as unrelated caller content" and then never check.
// This is that check.
//
// The signal is CONTENT, not energy: what the caller's transcript shares with
// what the AI actually said, and whether it arrived while that audio could
// still be bouncing around the room. Time is always caller-supplied (`atMs`),
// never read from the system clock, so behavior is deterministic and testable
// (same pattern as lib/voice/inboundVad.js and lib/voice/metrics.js).
//
// CLOCK: every timestamp handed to this module — noteSpoken, noteAudioStopped,
// classify, and whatever aiAudibleUntil returns — must come from the SAME
// clock. In the live session that clock is performance.now(), because that is
// what audioOut and turnManager already use; mixing in a Date.now() would
// compare an epoch timestamp against a since-process-start one and silently
// classify everything as outside the window.
// ---------------------------------------------------------------------------

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function envFloat(name, fallback, { min = 0, max = 1 } = {}) {
  const v = Number.parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

// Shortest transcript that may be classified as echo, in tokens.
//
// Deliberately equal to turnManager's own no-cue interim threshold (4 words):
// the guard therefore covers exactly the range that can trigger a barge-in,
// and everything shorter keeps relying on the existing backchannel and
// STT-phantom rules instead.
//
// This is also the false-positive guard that matters most. A caller repeating
// a slot back — "Thursday at three?" — is the commonest thing said right
// after the AI proposes one, and without acoustic echo cancellation it is
// acoustically indistinguishable from echo. Below this length the benefit of
// the doubt always goes to the caller.
const DEFAULT_MIN_TOKENS = envInt("VOICE_ECHO_MIN_TOKENS", 4, { min: 2, max: 20 });

// Absolute floor on matched bigrams, so a 4-token transcript (3 bigrams) has
// to match all three rather than clearing the ratio on a lucky pair.
const DEFAULT_MIN_MATCHED_BIGRAMS = envInt("VOICE_ECHO_MIN_BIGRAMS", 3, { min: 1, max: 20 });

// Fraction of the transcript's bigrams that must appear in recent AI speech.
//
// BIGRAMS, not single words: word ORDER is what separates an echo from a
// caller who happens to be talking about the same thing in the same
// vocabulary. Not trigrams — one STT word error breaks every trigram covering
// it, and phone-bandwidth echo produces exactly that kind of damage.
const DEFAULT_MIN_RATIO = envFloat("VOICE_ECHO_MIN_RATIO", 0.6, { min: 0, max: 1 });

// How many transcript words absent from recent AI speech are tolerated before
// the transcript is treated as the caller contributing something new. This is
// what rescues "Thursday at three but can we do four thirty instead" — high
// overlap on the prefix, yet plainly not an echo.
const DEFAULT_MAX_NOVEL_TOKENS = envInt("VOICE_ECHO_MAX_NOVEL", 2, { min: 0, max: 20 });

// How long after the AI's audio is estimated to have finished a transcript may
// still be echo.
//
// Generous on purpose, and load-bearing for the barge-in case: audioOut's
// tapered clear() collapses the playback estimate to roughly now+140ms, while
// the echo that caused the barge is still sitting in Deepgram's buffer and its
// final will not arrive for another 300ms (endpointing) to 1000ms
// (utterance_end_ms) plus network. A tight tail would let exactly the worst
// echo — the one that triggered the interruption — through.
const DEFAULT_TAIL_MS = envInt("VOICE_ECHO_TAIL_MS", 1_200, { min: 0, max: 10_000 });

// How long spoken text is remembered. Longer than the tail so a slow final
// still finds the text it echoes; short enough that the AI quoting a phrase
// early in a call can't suppress the caller minutes later.
const DEFAULT_RETAIN_MS = envInt("VOICE_ECHO_RETAIN_MS", 10_000, { min: 1_000, max: 60_000 });

// Bound on remembered chunks, so a long call can't grow this without limit.
const MAX_SPANS = 24;

const ENABLED_BY_DEFAULT = process.env.VOICE_ECHO_GUARD !== "false";

/**
 * Normalize text for matching: lowercase, punctuation dropped, whitespace
 * collapsed, and — crucially — consecutive all-digit tokens merged.
 *
 * The digit merge exists because the two sides spell numbers differently:
 * toSpeakable hands TTS "817 580 3291" so it is read out as digits, while
 * Deepgram (numerals: true) returns "8175803291". Without merging, a
 * read-back-the-number echo — one of the most common lines on these calls —
 * would never match.
 *
 * Known limitation, not worth solving: toSpeakable may render "3 PM" as
 * digits where Deepgram returns "three". The ratio threshold absorbs a couple
 * of such mismatches; a number-word table would be a maintenance burden for
 * marginal gain.
 *
 * @param {*} text
 * @returns {string[]} tokens
 */
export function normalizeTokens(text) {
  if (typeof text !== "string") return [];
  const raw = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  const merged = [];
  for (const token of raw) {
    if (/^\d+$/.test(token) && merged.length > 0 && /^\d+$/.test(merged[merged.length - 1])) {
      merged[merged.length - 1] += token;
    } else {
      merged.push(token);
    }
  }
  return merged;
}

/** @param {string[]} tokens @returns {string[]} */
function bigrams(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/**
 * Create a self-echo guard for one call.
 *
 * @param {object} opts
 * @param {function(): number} opts.aiAudibleUntil - () => timestamp (same clock as atMs) when queued AI audio is estimated to stop being heard; wire to audioOut.aiAudioPlayingUntil()
 * @param {boolean} [opts.enabled] - false disables all suppression (env VOICE_ECHO_GUARD=false)
 * @param {number} [opts.minTokens]
 * @param {number} [opts.minMatchedBigrams]
 * @param {number} [opts.minRatio]
 * @param {number} [opts.maxNovelTokens]
 * @param {number} [opts.tailMs]
 * @param {number} [opts.retainMs]
 * @returns {{
 *   noteSpoken: function(string, number): void,
 *   noteAudioStopped: function(number): void,
 *   classify: function(*, number): {isEcho: boolean, reason: string, ratio: number, novel: number},
 *   isEcho: function(*, number): boolean,
 *   reset: function(): void,
 * }}
 */
export function createEchoGuard({
  aiAudibleUntil,
  enabled = ENABLED_BY_DEFAULT,
  minTokens = DEFAULT_MIN_TOKENS,
  minMatchedBigrams = DEFAULT_MIN_MATCHED_BIGRAMS,
  minRatio = DEFAULT_MIN_RATIO,
  maxNovelTokens = DEFAULT_MAX_NOVEL_TOKENS,
  tailMs = DEFAULT_TAIL_MS,
  retainMs = DEFAULT_RETAIN_MS,
} = {}) {
  /** @type {{tokens: Set<string>, bigrams: Set<string>, atMs: number}[]} */
  let spans = [];
  let lastAudioStoppedAtMs = null;

  function prune(atMs) {
    if (spans.length === 0) return;
    spans = spans.filter((s) => atMs - s.atMs <= retainMs);
    if (spans.length > MAX_SPANS) spans = spans.slice(spans.length - MAX_SPANS);
  }

  /**
   * Record text the AI has handed to TTS — i.e. what the caller is about to
   * hear, and therefore what may come back.
   * @param {string} text
   * @param {number} atMs
   */
  function noteSpoken(text, atMs) {
    try {
      const tokens = normalizeTokens(text);
      if (tokens.length === 0) return;
      spans.push({
        tokens: new Set(tokens),
        bigrams: new Set(bigrams(tokens)),
        atMs,
      });
      prune(atMs);
    } catch (err) {
      log.error("echo_guard_note_spoken_error", { reason: err?.message });
    }
  }

  /**
   * Record that outbound audio was cut (barge-in). Extends the window during
   * which a transcript may still be echo, because the playback estimate
   * collapses the instant audioOut.clear() runs while the echo it caused is
   * still in flight through STT. See DEFAULT_TAIL_MS.
   * @param {number} atMs
   */
  function noteAudioStopped(atMs) {
    lastAudioStoppedAtMs = atMs;
  }

  /**
   * Latest moment AI audio could still have been audible.
   *
   * Returns null when the playback estimate cannot be read at all. That is
   * "unknown", not "zero": without knowing whether the AI was audible there
   * is no basis for calling anything echo, and wrongly suppressing a real
   * caller is far worse than answering one echo.
   * @returns {number|null}
   */
  function audibleUntil() {
    let fromAudioOut = 0;
    try {
      const v = aiAudibleUntil?.();
      if (typeof v === "number" && Number.isFinite(v)) fromAudioOut = v;
    } catch (err) {
      log.error("echo_guard_audible_until_error", { reason: err?.message });
      return null;
    }
    return Math.max(fromAudioOut, lastAudioStoppedAtMs ?? 0);
  }

  /**
   * Decide whether `text` is the AI's own audio coming back.
   *
   * All of the following must hold — each one is a distinct way for a real
   * caller utterance to be mistaken for echo, and dropping any of them is
   * what would make this dangerous rather than useful:
   *   - it arrived while AI audio could still be audible (plus the tail)
   *   - it is long enough that a caller could not plausibly have meant it as
   *     a short confirmation
   *   - enough of its word PAIRS appear in recent AI speech (order matters)
   *   - it carries almost nothing the AI did not itself say
   *
   * @param {*} text
   * @param {number} atMs
   * @returns {{isEcho: boolean, reason: string, ratio: number, novel: number}}
   */
  function classify(text, atMs) {
    const miss = (reason, extra = {}) => ({ isEcho: false, reason, ratio: 0, novel: 0, ...extra });
    try {
      if (!enabled) return miss("disabled");

      const tokens = normalizeTokens(text);
      if (tokens.length === 0) return miss("empty");
      if (tokens.length < minTokens) return miss("too_short");

      prune(atMs);
      if (spans.length === 0) return miss("nothing_spoken");

      const audible = audibleUntil();
      if (audible === null) return miss("window_unknown");
      if (atMs > audible + tailMs) return miss("outside_window");

      const candidateBigrams = bigrams(tokens);
      if (candidateBigrams.length === 0) return miss("too_short");

      let matched = 0;
      for (const bg of candidateBigrams) {
        if (spans.some((s) => s.bigrams.has(bg))) matched++;
      }
      const ratio = matched / candidateBigrams.length;

      let novel = 0;
      for (const t of tokens) {
        if (!spans.some((s) => s.tokens.has(t))) novel++;
      }

      if (matched < minMatchedBigrams) return miss("too_few_matches", { ratio, novel });
      if (ratio < minRatio) return miss("low_overlap", { ratio, novel });
      if (novel > maxNovelTokens) return miss("caller_added_content", { ratio, novel });

      return { isEcho: true, reason: "echo", ratio, novel };
    } catch (err) {
      log.error("echo_guard_classify_error", { reason: err?.message });
      // Never suppress on an internal error — a missed echo costs a bad turn,
      // a wrongly-suppressed caller costs the call.
      return miss("error");
    }
  }

  /**
   * @param {*} text
   * @param {number} atMs
   * @returns {boolean}
   */
  function isEcho(text, atMs) {
    return classify(text, atMs).isEcho;
  }

  /**
   * Is a very short transcript (1..maxTokens words) wholly contained in what
   * the AI just said?
   *
   * classify() refuses anything under minTokens because ratio-and-bigram
   * similarity is meaningless at that length — with one word there are no
   * bigrams at all. Exact token containment IS meaningful there, and it closes
   * a real gap: turnManager treats a one-word interrupt cue ("no", "sorry",
   * "wait", "actually") as sufficient to cut the AI off, while nothing else
   * guards a transcript that short. So the AI saying "No problem, I can get
   * that booked" and being transcribed back off a speakerphone as "no" was an
   * unguarded path straight to triggerInterrupt — the caller hears themselves
   * cut off with no idea why.
   *
   * Same window rules as classify(): only within the audible span plus tail,
   * and never on an internal error.
   *
   * @param {*} text
   * @param {number} atMs
   * @param {number} [maxTokens=3]
   * @returns {boolean}
   */
  function isShortEcho(text, atMs, maxTokens = 3) {
    try {
      if (!enabled) return false;

      const tokens = normalizeTokens(text);
      if (tokens.length === 0 || tokens.length > maxTokens) return false;

      prune(atMs);
      if (spans.length === 0) return false;

      const audible = audibleUntil();
      if (audible === null) return false;
      if (atMs > audible + tailMs) return false;

      // EVERY token must have been said by the AI. One word the AI never
      // uttered means the caller contributed something, and this is not echo.
      return tokens.every((t) => spans.some((s) => s.tokens.has(t)));
    } catch (err) {
      log.error("echo_guard_short_echo_error", { reason: err?.message });
      return false;
    }
  }

  /** Forget all remembered AI speech and playback state. */
  function reset() {
    spans = [];
    lastAudioStoppedAtMs = null;
  }

  return { noteSpoken, noteAudioStopped, classify, isEcho, isShortEcho, reset };
}
