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
//   - If the model goes quiet for `stallTimeoutMs` AFTER its first chunk,
//     yields { type: "stalled" } (re-armable, unlike "slow") so the caller can
//     keep the line alive. This is the tool-round case: the prompt has the
//     model say "one moment while I check that" in the same response as the
//     tool call, so by the time a lookup actually runs the turn has already
//     produced text — which permanently disarms "slow" — and the caller then
//     hears nothing at all until the tool returns.
//   - If the whole turn exceeds `totalTimeoutMs`, aborts the underlying
//     request and throws an Error with `code: "LLM_TIMEOUT"`. That budget is
//     EXTENDED by `toolGraceMs` each time a tool outcome arrives, up to
//     `hardTimeoutMs`: a turn visibly doing work earns more time, a silently
//     hung one does not. Without this a tool slower than the flat budget kills
//     its own turn and the caller is told "could you repeat that?" instead of
//     being given the answer the tool just fetched.
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

function envInt(name, fallback, { min = 0, max = 120_000 } = {}) {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

// Silence, measured from the last chunk, that means the caller is sitting in
// dead air. 2500ms: long enough that ordinary inter-sentence gaps never
// trigger it, short enough that nobody wonders whether the line dropped.
// 0 disables the signal entirely.
const STALL_TIMEOUT_MS = envInt("VOICE_LLM_STALL_MS", 2_500, { max: 30_000 });

// Cap on hold lines per turn. Two is reassurance; more is nagging.
const STALL_MAX_YIELDS = envInt("VOICE_LLM_STALL_MAX", 2, { max: 10 });

// Extra time granted each time a tool outcome arrives. Sized to cover one more
// tool round plus the model's follow-up. 0 restores the flat budget.
const TOOL_GRACE_MS = envInt("VOICE_LLM_TOOL_GRACE_MS", 4_000, { max: 30_000 });

// Ceiling on those extensions. A turn that has been running this long is
// broken however busy it looks, and the caller has waited long enough.
const HARD_TIMEOUT_MS = envInt("VOICE_LLM_HARD_TIMEOUT_MS", 20_000, { min: 1_000, max: 120_000 });

/**
 * @param {object} params
 * @param {Array} params.history
 * @param {string} params.userText
 * @param {string} params.step
 * @param {string|null} params.intent
 * @param {object} [params.config]
 * @param {object} [params.extras]
 * @param {number} [params.firstChunkTimeoutMs=2000]
 * @param {number} [params.totalTimeoutMs=8000] - base budget; extended by tool activity up to hardTimeoutMs
 * @param {number} [params.stallTimeoutMs] - post-first-chunk silence that yields "stalled" (0 disables)
 * @param {number} [params.stallMaxYields] - most "stalled" events per turn
 * @param {number} [params.toolGraceMs] - budget granted per tool outcome
 * @param {number} [params.hardTimeoutMs] - ceiling no extension may pass
 * @yields {{type:"slow"}|{type:"stalled",sinceLastChunkMs:number}|{type:"delta",text:string}|{type:"toolEffect",effect:object}|{type:"done",reply:object,[key:string]:*}}
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
  stallTimeoutMs = STALL_TIMEOUT_MS,
  stallMaxYields = STALL_MAX_YIELDS,
  toolGraceMs = TOOL_GRACE_MS,
  hardTimeoutMs = HARD_TIMEOUT_MS,
} = {}) {
  const turnStartedAt = Date.now();
  const controller = new AbortController();
  let totalTimer = null;
  let slowTimer = null;
  let stallTimer = null;
  let completed = false;

  // Moving deadline (extended by tool activity) and the ceiling it can never
  // pass. Both absolute, so an extension is a single assignment.
  let deadlineAtMs = turnStartedAt + totalTimeoutMs;
  const hardDeadlineAtMs = turnStartedAt + Math.max(totalTimeoutMs, hardTimeoutMs);

  const totalTimeoutPromise = new Promise((resolve) => {
    // Self-rearming: when the timer fires it re-checks the deadline, which
    // may have moved since it was set. Only a deadline that has actually
    // elapsed ends the turn.
    const arm = (ms) => {
      totalTimer = setTimeout(() => {
        const now = Date.now();
        const effective = Math.min(deadlineAtMs, hardDeadlineAtMs);
        if (now >= effective) {
          controller.abort();
          resolve({ kind: "timeout" });
          return;
        }
        arm(effective - now);
      }, ms);
      totalTimer.unref?.();
    };
    arm(totalTimeoutMs);
  });

  // Stall detection. Unlike the one-shot "slow" signal this re-arms, because
  // a turn can stall repeatedly — once per tool round.
  let stallPromise = null;
  let stallYields = 0;
  let lastChunkAtMs = turnStartedAt;

  function clearStall() {
    clearTimeout(stallTimer);
    stallTimer = null;
    stallPromise = null;
  }

  function armStall() {
    clearStall();
    if (stallTimeoutMs <= 0 || stallYields >= stallMaxYields) return;
    stallPromise = new Promise((resolve) => {
      stallTimer = setTimeout(() => resolve({ kind: "stalled" }), stallTimeoutMs);
      stallTimer.unref?.();
    });
  }

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
      if (stallPromise) racers.push(stallPromise);

      const winner = await Promise.race(racers);

      if (winner.kind === "timeout") {
        throw Object.assign(new Error("LLM turn timeout"), { code: "LLM_TIMEOUT" });
      }

      if (winner.kind === "slow") {
        slowTimeoutPromise = null; // fire at most once
        yield { type: "slow" };
        continue; // pendingNext is still the same pending promise — keep waiting on it
      }

      if (winner.kind === "stalled") {
        stallYields++;
        const sinceLastChunkMs = Date.now() - lastChunkAtMs;
        armStall(); // re-arm: a long tool round can stall more than once
        yield { type: "stalled", sinceLastChunkMs };
        continue; // same pendingNext — the model is slow, not gone
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
      lastChunkAtMs = Date.now();
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (slowTimeoutPromise) {
          clearTimeout(slowTimer);
          slowTimeoutPromise = null;
        }
      }
      // Every chunk resets the stall clock. Armed only after the first chunk:
      // before that, silence is "slow"'s business, and yielding both would
      // have the caller hear two hold lines back to back.
      armStall();

      const { value: chunk, done } = winner.result;
      if (done) {
        // Underlying generator returned without an explicit done chunk.
        completed = true;
        break;
      }

      if (chunk.delta) {
        yield { type: "delta", text: chunk.delta };
      } else if (chunk.toolEffect) {
        // A tool actually ran, so the turn is doing work rather than hanging:
        // buy it more time (bounded by the hard ceiling) instead of letting a
        // multi-round lookup die against a budget sized for a single reply.
        deadlineAtMs = Math.min(hardDeadlineAtMs, Date.now() + toolGraceMs);
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
      } else if (chunk.toolCall) {
        // Forwarded so the session knows a tool STARTED, not just that one
        // finished. That is the difference between covering a slow tool round
        // and finding out about it afterwards — and since the prompt no longer
        // asks the model to announce a lookup, this is the only signal there is.
        //
        // The synthetic set_call_intent event marker mode parses out of reply
        // text is deliberately not forwarded: nothing ran for it, so it must
        // not earn a hold line any more than it earns toolGrace.
        if (chunk.toolCall.name !== "set_call_intent") {
          yield { type: "toolCall", name: chunk.toolCall.name };
        }
      }
      // Other event types are informational only — not part of this wrapper's
      // contract — so just keep draining the stream.

      pendingNext = nextChunk();
    }
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(slowTimer);
    clearStall();
    if (!completed) controller.abort();
  }
}
