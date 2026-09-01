/**
 * Deciding the caller is finished from WHAT they said, not from how long they
 * have been quiet.
 *
 * SHIPPED DARK. VOICE_SEMANTIC_ENDPOINT defaults to "false" and nothing here
 * runs on a real call until it is switched on deliberately, because this is
 * the first thing in the pipeline that would put a model call in the hot path
 * of an ordinary turn and its cost has not been measured.
 *
 * THE PROBLEM IT IS FOR
 *
 * Every end-of-turn decision today is a timer. lib/transcriptUtils.js gives a
 * fragment a fixed hold from a regex tier — 800ms for a trailing "I'd like
 * to", 500ms for a final with no full stop — and the backlog has the measured
 * consequence of trying to fix that with bigger numbers: 800ms leaves 3
 * barge-ins at p50 2,322ms, 1,200ms leaves 2 at p50 2,663ms. Accuracy bought
 * with time, one for one, from every caller including the ones who never
 * hesitate. A hold cannot out-wait a caller who pauses for two seconds
 * mid-sentence, and sizing it as though it could is what makes the fluent
 * caller pay for the hesitant one.
 *
 * WHAT THIS CHANGES, AND WHAT IT DOES NOT
 *
 * It is an ACCURACY fix, not a latency fix, and it should never be described
 * as one. Real measured voice-to-voice p50 is 3,062ms and endpointing plus
 * hold is roughly 500-650ms of it, so even perfect turn detection is worth a
 * couple of hundred milliseconds. What it buys is spending the wait on the
 * turns that need it instead of on all of them.
 *
 * FAIL OPEN, ALWAYS, AND NEVER IN SERIES
 *
 * The judge runs CONCURRENTLY with the heuristic hold that would have run
 * anyway, and its answer is only ever allowed to shorten or extend that hold.
 * Ask-then-decide would be strictly worse than what we have now: a 250-400ms
 * round trip inside a 500ms budget spends the budget on the decision. So a
 * verdict that arrives late, errors, or comes back unparseable returns null
 * and the timer wins untouched. There is no path through this module where a
 * caller waits on it.
 */

import { log } from "../logger.js";
import { buildThinkingConfig } from "../../services/gemini.js";

/**
 * Which model. Deliberately the small one — this is a two-way classification
 * on a handful of words, and the whole design depends on the answer landing
 * inside a hold that is already running.
 */
const ARBITER_MODEL = "gemini-3.6-flash";

/**
 * Is the semantic arbiter switched on for this call?
 *
 * Read at call time so it can be turned on for a single test call without a
 * deploy, and OFF by default because it is the only thing in the turn path
 * that costs money per turn.
 *
 * @returns {boolean}
 */
export function semanticEndpointEnabled() {
  return process.env.VOICE_SEMANTIC_ENDPOINT === "true";
}

/**
 * The hold rules worth arbitrating.
 *
 * Not every hold: the conjunction and lead-in tiers are already near-certain
 * ("book an appointment for", "my name is" — nobody ends a sentence there),
 * and post_barge_settle is about a barge rather than about grammar. These
 * three are the genuinely ambiguous ones, which is also what keeps the cost
 * down: a fluent caller's turns come back terminal_punctuation and are never
 * sent anywhere.
 */
export const ARBITRATED_RULES = new Set([
  "no_terminal_punctuation",
  "trailing_incomplete",
  "partial_digits",
]);

const SYSTEM = [
  "You judge whether a phone caller has FINISHED speaking.",
  "You are given the last thing they said, mid-call, as the speech recognizer heard it.",
  "Punctuation is the recognizer's guess and is often wrong — ignore it and judge the words.",
  'Answer with one word: COMPLETE if they have finished their thought, INCOMPLETE if they are mid-sentence and about to continue.',
  "Examples of INCOMPLETE: \"I'd like to book\", \"my number is oh seven seven\", \"I've been having\", \"can I get a\".",
  'Examples of COMPLETE: "yes that works", "Tuesday morning", "no that\'s everything thanks", "what time do you close".',
].join("\n");

/**
 * Ask whether this fragment is a finished thought.
 *
 * @param {object} opts
 * @param {string} opts.fragment - what the caller just said
 * @param {Array<{role:string, parts?:Array<{text?:string}>}>} [opts.recentTurns]
 *   the last few history entries, for context. Trimmed hard: this is a
 *   grammatical judgement, not a comprehension one, and a long prompt costs
 *   latency the hold has to cover.
 * @param {number} opts.deadlineMs - abandon the judgement after this long. Set
 *   from the hold that is already running, so a late answer is simply ignored.
 * @param {object} [deps] - injection seam for tests and sim/cutoffSim.sim.js,
 *   which must be able to exercise this wiring without a network or a bill.
 * @param {() => object} [deps.getClient]
 * @returns {Promise<{complete: boolean|null}>} complete=null means "no usable
 *   answer in time" — the caller MUST treat that as no opinion.
 */
export async function judgeTurnComplete({ fragment, recentTurns = [], deadlineMs }, deps = {}) {
  const text = String(fragment || "").trim();
  if (!text) return { complete: null };
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return { complete: null };

  const getClient = deps.getClient;
  if (typeof getClient !== "function") return { complete: null };

  const context = recentTurns
    .slice(-4)
    .map((h) => `${h.role === "model" ? "Receptionist" : "Caller"}: ${h.parts?.[0]?.text || ""}`)
    .filter((line) => line.length < 300)
    .join("\n");

  // The deadline is enforced with a race rather than an abort signal on
  // purpose: whether the request is actually cancelled underneath does not
  // matter here, because a late answer is discarded either way and the caller
  // of this function has already moved on.
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ complete: null }), deadlineMs);
    timer.unref?.();
  });

  const ask = (async () => {
    try {
      const client = getClient();
      const response = await client.models.generateContent({
        model: ARBITER_MODEL,
        contents:
          `${SYSTEM}\n\n` +
          (context ? `Recent conversation:\n${context}\n\n` : "") +
          `Caller just said: "${text}"\n\nCOMPLETE or INCOMPLETE?`,
        config: {
          temperature: 0,
          maxOutputTokens: 4,
          // Thinking would blow the deadline on every turn, and this is a
          // judgement the model either makes instantly or should not be
          // making inside a hold.
          //
          // Built by the shared helper, NOT hand-written. gemini-3.x REJECTS
          // the legacy `thinkingBudget` key outright — services/gemini.js
          // records it as a verified 400 INVALID_ARGUMENT, which is the entire
          // reason buildThinkingConfig exists — and this module targets
          // gemini-3.6-flash. The first version of this file hand-rolled
          // `{ thinkingBudget: 0 }`, so every request would have 400'd, the
          // catch below would have swallowed it into a debug line, and the
          // counters would have sat at zero looking exactly like "the arbiter
          // was never needed". That is the failure this module's own header
          // warns about, written by the same hand that then shipped it.
          thinkingConfig: buildThinkingConfig(ARBITER_MODEL, 0),
        },
      });
      const raw = String(response?.text ?? "").trim().toUpperCase();
      if (raw.startsWith("COMPLETE")) return { complete: true };
      if (raw.startsWith("INCOMPLETE")) return { complete: false };
      // Anything else is not an answer. Say so rather than guessing, or the
      // fail-open guarantee stops being one.
      return { complete: null };
    } catch (err) {
      log.debug("semantic_endpoint_failed", { reason: err?.message });
      return { complete: null };
    }
  })();

  try {
    return await Promise.race([ask, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
