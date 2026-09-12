// ---------------------------------------------------------------------------
// WHEN A SCRIPTED CALL SHOULD HANG UP.
//
// Pure by design: no timers, no sockets, no clock of its own. The harness owns
// all three and asks this module one question per tick. That separation is the
// only reason the decision can be tested without spending a phone call on it,
// and scripts/live-call-harness.js has no test of its own today.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// LVX121 -- the recovery that books what a call agreed to and never made -- is
// deployed and parked, and ITS WRITE PATH HAS NEVER EXECUTED. The window it
// needs is "a recorded agreement with no row yet": opened by the caller's yes,
// closed by the write. Measured on two real calls:
//
//   CA7a5667c0   yes 08:33:02  ->  row 08:33:46   = 44 SECONDS
//   CA6b773e2a   yes 08:39:23  ->  row 08:39:25.9 =  2.7 SECONDS
//
// The 44 seconds existed only because the assistant became confused about the
// caller's existing appointments. On a clean call the write lands under three
// seconds after the yes, and no human can reliably hang up inside that. Two
// recipes were tried on real calls and neither was sound: "hang up when it asks
// you to spell" fails because the model asks for the spelling EARLY on some
// calls, and "say yes then hang up" is the 2.7-second race.
//
// The same three-second problem is why eleven calls on 2026-09-12 could not
// discriminate old code from new on LVX125 or LVX126.
//
// ---------------------------------------------------------------------------
// Two triggers, because they answer different questions
// ---------------------------------------------------------------------------
//
//   --hangup-after <label>      fires when that scripted line's audio has
//                               finished sending. Answers "what happens if the
//                               caller vanishes mid-turn".
//   --hangup-on-counter <name>  fires the instant that counter rises above its
//                               pre-call value. Answers "what happens INSIDE
//                               the write window", and it is the deterministic
//                               one.
//
// Both may be armed at once; the counter is checked first and the label is then
// the backstop for a counter that never moves.
// ---------------------------------------------------------------------------

/** @typedef {{afterLabel: string, onCounter: string, delayMs: number}} HangupPlan */

/** @returns {HangupPlan} */
export function makeHangupPlan({ afterLabel = "", onCounter = "", delayMs = 0 } = {}) {
  const d = Number(delayMs);
  return {
    afterLabel: String(afterLabel || ""),
    onCounter: String(onCounter || ""),
    delayMs: Number.isFinite(d) && d > 0 ? d : 0,
  };
}

/** @param {HangupPlan} plan */
export function hangupArmed(plan) {
  return Boolean(plan?.afterLabel || plan?.onCounter);
}

/**
 * Read one counter out of a /api/debug/latency turnTaking block.
 *
 * A counter nobody has bumped yet is ABSENT from that object, not zero. Reading
 * it as undefined makes the first rise on a fresh boot invisible, which is
 * precisely the rise the counter trigger exists to catch.
 */
export function counterValue(counters, name) {
  return Number(counters?.[name] || 0);
}

/**
 * @returns {{hangUp: boolean, reason: "" | "after_label" | "counter"}}
 */
export function hangupDecision({
  plan,
  now,
  spokenEndedAt = null,
  counterBefore = null,
  counterNow = null,
  bootIdStable = true,
}) {
  if (!hangupArmed(plan)) return { hangUp: false, reason: "" };

  if (plan.onCounter) {
    // A restart resets every counter to zero, so a rise and a reset-then-rise
    // are the same number. The harness already refuses to PRINT a counter delta
    // across a bootId change; a trigger built on one must refuse to FIRE for
    // the same reason. The run is then reported inconclusive, which is the
    // honest answer -- an unreadable signal is not a signal.
    const readable = bootIdStable && counterBefore !== null && counterNow !== null;
    if (readable && counterNow > counterBefore) return { hangUp: true, reason: "counter" };
  }

  if (plan.afterLabel && spokenEndedAt !== null && now >= spokenEndedAt + plan.delayMs) {
    return { hangUp: true, reason: "after_label" };
  }

  return { hangUp: false, reason: "" };
}

/**
 * `--expect-counter recover_booked` or `--expect-counter write_order_refused:2`
 *
 * Throws rather than defaulting. An expectation nobody can name is an
 * expectation nobody checks, and this flag's whole job is to make a run capable
 * of failing.
 */
export function parseExpectation(raw) {
  const [name, min] = String(raw || "").split(":");
  if (!name) throw new Error(`--expect-counter needs a counter name, got "${raw}"`);
  const n = Number.parseInt(min ?? "1", 10);
  return { name, min: Number.isFinite(n) && n > 0 ? n : 1 };
}

/**
 * The DELTA across the call, never the absolute value. A counter already at 5
 * before the call started has not moved because it reads 5 afterwards.
 */
export function checkExpectations(expectations, before, after) {
  const failures = [];
  for (const e of expectations || []) {
    const moved = counterValue(after, e.name) - counterValue(before, e.name);
    if (moved < e.min) failures.push({ ...e, moved });
  }
  return { ok: failures.length === 0, failures };
}
