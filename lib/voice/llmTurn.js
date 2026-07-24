import { getReplyStreaming } from "../../services/gemini.js";

// ---------------------------------------------------------------------------
// runLlmTurn — timeout/abort wrapper around services/gemini.js's
// getReplyStreaming, for the voice-pipeline v2 session orchestrator.
//
//   - Relays getReplyStreaming's text deltas ({ type: "delta", text }) and
//     its final chunk ({ type: "done", ...finalChunkFields }) as-is.
//   - If no chunk arrives from Gemini within `firstChunkTimeoutMs`, yields a
//     single { type: "slow" } event (caller can play a filler) and keeps
//     waiting — this does NOT abort the turn.
//   - If the whole turn exceeds `totalTimeoutMs`, aborts the underlying
//     request and throws an Error with `code: "LLM_TIMEOUT"`.
//   - If the consumer stops iterating early (barge-in — e.g. `break` in a
//     `for await` loop, or an explicit `generator.return()`), the
//     underlying request is aborted via the same AbortController.
//   - Never leaves a dangling setTimeout: both timers are cleared in a
//     `finally` block that runs on every exit path (normal completion,
//     timeout, early return, or an error from getReplyStreaming itself).
//   - Single pre-stream transient retry: if the underlying iterator throws a
//     transient error (network-ish, HTTP 5xx, 429/RESOURCE_EXHAUSTED) BEFORE
//     any chunk has been consumed from it, and ≥3000ms of the total budget
//     remain, the iterator is recreated ONCE and streaming continues. Once a
//     chunk has been pulled (delta/toolCall/toolEffect/done — anything that
//     may have executed a tool or spoken to the caller) we never retry, to
//     avoid double-speech / double-execution. See isTransientError below.
// ---------------------------------------------------------------------------

/**
 * Classify an error thrown by getReplyStreaming's iterator as transient
 * (worth one recreation) or not. Transient = network-ish (fetch failed,
 * ECONNRESET, socket hang up, …), HTTP 5xx, or 429/RESOURCE_EXHAUSTED. NOT
 * transient: our own abort/timeout (AbortError, LLM_TIMEOUT), any other 4xx,
 * and schema/validation errors (which a retry cannot fix).
 *
 * @param {*} err
 * @returns {boolean}
 */
export function isTransientError(err) {
  if (!err) return false;

  // Our own control-flow signals are never transient.
  if (err.name === "AbortError") return false;
  if (err.code === "LLM_TIMEOUT") return false;

  // Prefer a numeric HTTP status when the SDK exposes one (err.status, or a
  // numeric err.code as some transports use). This is authoritative: a 400
  // here means "no retry" even if the message text is noisy.
  const status =
    typeof err.status === "number"
      ? err.status
      : typeof err.code === "number"
        ? err.code
        : null;
  if (status !== null) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status >= 400 && status < 500) return false; // other 4xx — permanent
  }

  const msg = String(err?.message ?? err).toLowerCase();
  // Rate limit / quota.
  if (/\b429\b|resource_exhausted|too many requests/.test(msg)) return true;
  // Server-side 5xx (by code or by canonical name).
  if (/\b5\d\d\b|internal error|internal server error|unavailable|bad gateway|gateway timeout|deadline exceeded/.test(msg))
    return true;
  // Network / socket layer.
  if (/econnreset|econnrefused|etimedout|enotfound|epipe|socket hang up|network error|fetch failed/.test(msg))
    return true;

  return false;
}

/**
 * @param {object} params
 * @param {Array} params.history
 * @param {string} params.userText
 * @param {string} params.step
 * @param {string|null} params.intent
 * @param {object} [params.config]
 * @param {object} [params.extras]
 * @param {number} [params.firstChunkTimeoutMs=2000]
 * @param {number} [params.totalTimeoutMs=8000]
 * @yields {{type:"slow"}|{type:"delta",text:string}|{type:"done",reply:object,[key:string]:*}}
 */
export async function* runLlmTurn({
  history,
  userText,
  step,
  intent,
  config,
  extras,
  firstChunkTimeoutMs = 2000,
  totalTimeoutMs = 8000,
} = {}) {
  const turnStartedAt = Date.now();
  const controller = new AbortController();
  let totalTimer = null;
  let slowTimer = null;
  let completed = false;

  const totalTimeoutPromise = new Promise((resolve) => {
    totalTimer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, totalTimeoutMs);
  });

  let slowTimeoutPromise = new Promise((resolve) => {
    slowTimer = setTimeout(() => resolve({ kind: "slow" }), firstChunkTimeoutMs);
  });

  // `let`, not `const`: the transient-retry path recreates the iterator once.
  // nextChunk() closes over this binding, so it always pulls from the current
  // iterator after a retry.
  let iterator = getReplyStreaming(history, userText, step, intent, config, extras, {
    signal: controller.signal,
  });

  function nextChunk() {
    const p = iterator.next();
    p.catch(() => {}); // settlement is observed via Promise.race below; avoid unhandled-rejection noise once we stop caring (timeout/early-return)
    return p;
  }

  let pendingNext = nextChunk();
  let firstChunkSeen = false;
  let retried = false;

  try {
    while (true) {
      // Map a rejected next() into a { kind: "error" } racer rather than
      // letting it reject the race directly — that's what lets us inspect the
      // error and decide whether to retry (vs. propagating it immediately).
      const racers = [
        pendingNext.then(
          (result) => ({ kind: "next", result }),
          (error) => ({ kind: "error", error })
        ),
      ];
      racers.push(totalTimeoutPromise);
      if (slowTimeoutPromise) racers.push(slowTimeoutPromise);

      const winner = await Promise.race(racers);

      if (winner.kind === "timeout") {
        throw Object.assign(new Error("LLM turn timeout"), { code: "LLM_TIMEOUT" });
      }

      if (winner.kind === "slow") {
        slowTimeoutPromise = null; // fire at most once
        yield { type: "slow" };
        continue; // pendingNext is still the same pending promise — keep waiting on it
      }

      if (winner.kind === "error") {
        const err = winner.error;
        const remainingMs = totalTimeoutMs - (Date.now() - turnStartedAt);
        // Retry exactly once, and only when NOTHING has been consumed from the
        // iterator yet (firstChunkSeen guards against double-speech /
        // re-executing a tool). A prior { type: "slow" } filler does not block
        // a retry — it played no model content, so re-streaming stays
        // invisible to the caller beyond that filler. The total budget still
        // governs the whole turn: totalTimer keeps counting across the retry,
        // and we require ≥3000ms of it to remain so the recreated request has
        // room to produce a first chunk before the timeout fires.
        if (!retried && !firstChunkSeen && remainingMs >= 3000 && isTransientError(err)) {
          retried = true;
          iterator = getReplyStreaming(history, userText, step, intent, config, extras, {
            signal: controller.signal,
          });
          pendingNext = nextChunk();
          continue;
        }
        throw err;
      }

      // winner.kind === "next"
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (slowTimeoutPromise) {
          clearTimeout(slowTimer);
          slowTimeoutPromise = null;
        }
      }

      const { value: chunk, done } = winner.result;
      if (done) {
        // Underlying generator returned without an explicit done chunk.
        completed = true;
        break;
      }

      if (chunk.delta) {
        yield { type: "delta", text: chunk.delta };
      } else if (chunk.toolEffect) {
        // Forwarded so the session can persist durable tool outcomes (DB
        // writes, verified identity) even if the turn is later barged or
        // hits the total timeout before its done event.
        yield { type: "toolEffect", effect: chunk.toolEffect };
      } else if (chunk.done) {
        completed = true;
        // Surface the retry only when it actually happened — keeps the done
        // event byte-identical for the overwhelming majority of turns (and for
        // the passthrough tests) while giving telemetry a signal when it did.
        yield retried ? { type: "done", ...chunk, retried: true } : { type: "done", ...chunk };
        break;
      }
      // Other event types (e.g. toolCall) are informational only — not part
      // of this wrapper's contract — so just keep draining the stream.

      pendingNext = nextChunk();
    }
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(slowTimer);
    if (!completed) controller.abort();
  }
}
