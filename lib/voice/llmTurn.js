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
// ---------------------------------------------------------------------------

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

  const iterator = getReplyStreaming(history, userText, step, intent, config, extras, {
    signal: controller.signal,
  });

  function nextChunk() {
    const p = iterator.next();
    p.catch(() => {}); // settlement is observed via Promise.race below; avoid unhandled-rejection noise once we stop caring (timeout/early-return)
    return p;
  }

  let pendingNext = nextChunk();
  let firstChunkSeen = false;

  try {
    while (true) {
      const racers = [pendingNext.then((result) => ({ kind: "next", result }))];
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
        yield { type: "done", ...chunk };
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
