import { countAsks } from "../lib/transcriptUtils.js";

// ---------------------------------------------------------------------------
// Scoring a run for stacked questions.
//
// The defect: LVX82. On the first deployed Live calls the assistant asked for
// several things in one breath and `live_stacked_questions` reported the same
// number -- one per offending turn -- whether it asked two things or five. The
// instrument could not have shown its own fix working.
//
// ---------------------------------------------------------------------------
// It reuses the PRODUCTION predicate, and that is the whole design
// ---------------------------------------------------------------------------
//
// `countAsks` is the same function lib/voice/live/index.js auditTurn counts
// with. eval/fabrication.js is the precedent and the reasoning is identical:
// if this file wrote its own rule, the measured rate would be the rate of a
// detector nobody ships, and a prompt change that moved the real counter would
// silently stop being measured here.
//
// ---------------------------------------------------------------------------
// Why this exists at all, given the harnesses that already run
// ---------------------------------------------------------------------------
//
// Nothing in the repository could both produce a real stacked question and say
// how many things it asked. `npm run chat` and `npm run eval` produce real
// replies but run the cascade brain, where auditTurn never executes.
// EVAL_DRIVER=live produces real Live replies but lib/harness/liveTextSession.js
// bumps no counters. scripts/live-call-harness.js bumps them and states at its
// own head that IT CANNOT HEAR. This closes that gap on the text side, for free,
// on transcripts a run already has.
//
// ---------------------------------------------------------------------------
// What it CANNOT see, stated so nobody reads a low number as innocence
// ---------------------------------------------------------------------------
//
// - countAsks is a LOWER BOUND. "Can I take your name, date of birth, and what
//   it is for?" scores 2, not 3. asksTotal is a floor, not a census.
// - It scores TEXT. Two asks delivered with a pause between them and two
//   delivered in one breath score the same, and only the second is the
//   complaint.
// - Nothing about how the call sounded.
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx - the eval scenario ctx (`turns`, each with a `reply`)
 * @returns {{turns: number, repliesChecked: number, stackedTurns: number,
 *            asksTotal: number, asksMax: number, asksPerReply: number|null}}
 */
export function scoreQuestionShape(ctx) {
  const turns = ctx?.turns || [];

  let repliesChecked = 0;
  let stackedTurns = 0;
  let asksTotal = 0;
  let asksMax = 0;

  for (const t of turns) {
    const text = (t?.reply || "").trim();
    // The denominator counts turns that CARRIED TEXT, matching auditTurn's
    // live_reply_turns_checked. Counting every turn instead would let a run
    // that produced more tool-only turns look better than one that did not.
    if (!text) continue;
    repliesChecked += 1;

    const asks = countAsks(text);
    if (asks > 1) {
      stackedTurns += 1;
      asksTotal += asks;
      if (asks > asksMax) asksMax = asks;
    }
  }

  return {
    turns: turns.length,
    repliesChecked,
    stackedTurns,
    asksTotal,
    asksMax,
    // The comparable figure across runs of different lengths. Null rather than
    // 0 for an empty run, so "asked nothing" and "ran nothing" differ -- the
    // same rule the audio buckets in lib/voice/live/summary.js follow.
    asksPerReply: repliesChecked ? asksTotal / repliesChecked : null,
  };
}
