/**
 * Hard-assertion helpers for the eval suite.
 *
 * PURE and unit-tested (tests/evalAsserts.test.js). A scenario's `hard` array
 * is a list of `(ctx) => result` closures built from these helpers; the runner
 * evaluates them after the conversation and the process exit code is driven by
 * them alone (the LLM judge is advisory). Correctness here is load-bearing:
 * this is the part of the measurement instrument that MUST be trustworthy, so
 * every helper is deterministic and has no dependency on the model.
 *
 * Every helper returns `{ pass: boolean, name: string, detail: string }` so the
 * runner can render a uniform pass/fail table and, on failure, a human-readable
 * reason next to the transcript.
 *
 * The ctx shape the runner assembles:
 *   {
 *     toolCalls:  [{ name, args }],           // flat, in call order, all turns
 *     toolResults:[{ name, success, message }],
 *     turns:      [{ caller, reply, toolCalls, timings }],
 *     transcript, finalState, store,
 *   }
 */

const ok = (pass, name, detail) => ({ pass: !!pass, name, detail: detail ?? "" });

/**
 * Flat, ordered list of every executed tool call ({ name, args }). Prefers the
 * aggregate `ctx.toolCalls` the runner builds; falls back to flattening the
 * per-turn view so synthetic test ctxs (and partial ctxs) still work.
 */
export function collectToolCalls(ctx) {
  if (Array.isArray(ctx?.toolCalls)) return ctx.toolCalls;
  const out = [];
  for (const t of ctx?.turns || []) {
    for (const c of t?.toolCalls || []) out.push(c);
  }
  return out;
}

/** Reply strings, one per model turn, in order. */
function collectReplies(ctx) {
  if (Array.isArray(ctx?.replies)) return ctx.replies;
  if (Array.isArray(ctx?.turns)) return ctx.turns.map((t) => t?.reply ?? "");
  if (Array.isArray(ctx?.transcript)) {
    return ctx.transcript.filter((e) => e.role === "model").map((e) => e.text ?? "");
  }
  return [];
}

const namesOf = (ctx) => collectToolCalls(ctx).map((c) => c.name);
const countOf = (ctx, name) => namesOf(ctx).filter((n) => n === name).length;

export function toolCalled(ctx, name) {
  const n = countOf(ctx, name);
  return ok(n > 0, `toolCalled(${name})`, n > 0 ? `called ${n}×` : "never called");
}

export function toolNotCalled(ctx, name) {
  const n = countOf(ctx, name);
  return ok(n === 0, `toolNotCalled(${name})`, n === 0 ? "not called" : `called ${n}×`);
}

export function toolCalledTimes(ctx, name, times) {
  const n = countOf(ctx, name);
  return ok(n === times, `toolCalledTimes(${name}, ${times})`, `called ${n}×`);
}

export function toolCalledAtMost(ctx, name, max) {
  const n = countOf(ctx, name);
  return ok(n <= max, `toolCalledAtMost(${name}, ${max})`, `called ${n}×`);
}

/**
 * At least one call to `name` whose args satisfy `pred`. `label` is an optional
 * human description of the predicate for the failure detail.
 */
export function toolCalledWith(ctx, name, pred, label = "predicate") {
  const calls = collectToolCalls(ctx).filter((c) => c.name === name);
  const match = calls.some((c) => {
    try {
      return !!pred(c.args || {});
    } catch {
      return false;
    }
  });
  const detail = calls.length
    ? match
      ? `matched ${label}`
      : `${calls.length} call(s), none matched ${label}`
    : "tool never called";
  return ok(match, `toolCalledWith(${name}, ${label})`, detail);
}

/** No call to `name` has args satisfying `pred` (vacuously true if never called). */
export function toolNotCalledWith(ctx, name, pred, label = "predicate") {
  const calls = collectToolCalls(ctx).filter((c) => c.name === name);
  const offender = calls.find((c) => {
    try {
      return !!pred(c.args || {});
    } catch {
      return false;
    }
  });
  return ok(
    !offender,
    `toolNotCalledWith(${name}, ${label})`,
    offender ? `a call matched ${label}: ${JSON.stringify(offender.args)}` : `no call matched ${label}`
  );
}

/**
 * The full `sequence` appears as an ordered subsequence of the tool-call trace
 * (every element present, first-occurrence order preserved). Use for "check
 * THEN book" where both are expected. For "book, if it happens, only after a
 * check" use `toolBefore`.
 */
export function toolOrder(ctx, sequence) {
  const names = namesOf(ctx);
  let from = 0;
  for (const target of sequence) {
    const at = names.indexOf(target, from);
    if (at === -1) {
      return ok(false, `toolOrder(${sequence.join(" → ")})`, `"${target}" not found after position ${from}`);
    }
    from = at + 1;
  }
  return ok(true, `toolOrder(${sequence.join(" → ")})`, "in order");
}

/**
 * Every occurrence of `b` is preceded by at least one `a`. Vacuously passes if
 * `b` never occurs — the intended semantic for "it must not book before it has
 * checked" (not booking at all is fine).
 */
export function toolBefore(ctx, a, b) {
  const names = namesOf(ctx);
  const firstA = names.indexOf(a);
  const firstB = names.indexOf(b);
  const pass = firstB === -1 || (firstA !== -1 && firstA < firstB);
  const detail =
    firstB === -1 ? `"${b}" never called` : pass ? `"${a}" precedes "${b}"` : `"${b}" called before any "${a}"`;
  return ok(pass, `toolBefore(${a}, ${b})`, detail);
}

/** A success result was recorded for `name` (tool ran AND its handler reported success). */
export function toolSucceeded(ctx, name) {
  const results = (ctx?.toolResults || []).filter((r) => r.name === name);
  const pass = results.some((r) => r.success);
  const detail = results.length
    ? pass
      ? "succeeded"
      : `ran but did not succeed: ${results.map((r) => r.message).join("; ")}`
    : "no result recorded";
  return ok(pass, `toolSucceeded(${name})`, detail);
}

export function replySomewhereMatches(ctx, regex) {
  const replies = collectReplies(ctx);
  const hit = replies.find((r) => regex.test(r));
  return ok(!!hit, `replySomewhereMatches(${regex})`, hit ? `matched: "${truncate(hit)}"` : "no reply matched");
}

/**
 * A receptionist reply matching `regex` appeared in a turn STRICTLY BEFORE the
 * first turn in which `toolName` was called. The ordering assertion for
 * "verify before you act": a cancel/change tool must not be reached until the
 * receptionist has actually asked for the identity proof.
 *
 * Vacuously passes when `toolName` was never called (mirrors `toolBefore`) —
 * "it never acted" is not an ordering violation; pair it with `toolSucceeded`
 * when the action must also happen. A refused tool call still counts as a call
 * (the runner records the attempt), so an act-then-ask model fails this.
 */
export function replyMatchesBeforeTool(ctx, regex, toolName) {
  const turns = ctx?.turns || [];
  const toolTurn = turns.findIndex((t) => (t?.toolCalls || []).some((c) => c.name === toolName));
  if (toolTurn === -1) {
    return ok(true, `replyMatchesBeforeTool(${regex}, ${toolName})`, `"${toolName}" never called`);
  }
  const hit = turns.slice(0, toolTurn).find((t) => regex.test(t?.reply ?? ""));
  return ok(
    !!hit,
    `replyMatchesBeforeTool(${regex}, ${toolName})`,
    hit ? `asked (${truncate(hit.reply)}) before "${toolName}"` : `no reply matched before "${toolName}"`
  );
}

export function replyNeverMatches(ctx, regex) {
  const replies = collectReplies(ctx);
  const offender = replies.find((r) => regex.test(r));
  return ok(!offender, `replyNeverMatches(${regex})`, offender ? `matched: "${truncate(offender)}"` : "no reply matched");
}

export function turnsAtMost(ctx, max) {
  const n = (ctx?.turns || []).length;
  return ok(n <= max, `turnsAtMost(${max})`, `${n} turn(s)`);
}

/**
 * `name` does not appear in any turn before `turnIndex`. Used for end-call
 * gating: `end_call` must not fire before the caller's final turn.
 */
export function toolNotCalledBeforeTurn(ctx, name, turnIndex) {
  const turns = ctx?.turns || [];
  for (let i = 0; i < Math.min(turnIndex, turns.length); i++) {
    if ((turns[i]?.toolCalls || []).some((c) => c.name === name)) {
      return ok(false, `toolNotCalledBeforeTurn(${name}, ${turnIndex})`, `called in turn ${i}`);
    }
  }
  return ok(true, `toolNotCalledBeforeTurn(${name}, ${turnIndex})`, `not called before turn ${turnIndex}`);
}

/**
 * The call ended carrying one of `intents` as its intent.
 *
 * Every other assert here reads the tool trace. This one reads the state the
 * reducer actually produced (lib/voice/replyState.js), which is the thing the
 * next turn's prompt is built from — and, under VOICE_INTENT_MARKER, the one
 * signal that does not pass through the marker parser on its way here. A guard
 * that only inspected the tool trace would be partly testing the parser rather
 * than the behaviour.
 *
 * @param {object} ctx
 * @param {string[]} intents - acceptable final intents
 */
export function finalIntentIsOneOf(ctx, intents) {
  const actual = ctx?.finalState?.intent ?? null;
  return ok(
    intents.includes(actual),
    `finalIntentIsOneOf(${intents.join("|")})`,
    `intent is ${actual === null ? "null" : actual}`
  );
}

function truncate(s, n = 80) {
  return typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s;
}
