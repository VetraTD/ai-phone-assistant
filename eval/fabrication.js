import { getStrings } from "../lib/voice/strings.js";

// ---------------------------------------------------------------------------
// Scoring a run for fabrication.
//
// The defect: on 2026-09-03 the Live front-end told a caller their appointment
// was booked, having called no tool at all, with no row in the database. One
// observation in ten calls is an anecdote. This turns a run into a number.
//
// ---------------------------------------------------------------------------
// It reuses the PRODUCTION predicates, and that is the whole design
// ---------------------------------------------------------------------------
//
// `completionClaimRe` and `slotOfferRe` are the same regexes the two LVX27
// guards judge on (lib/voice/strings.js, via lib/voice/live/index.js
// auditTurn). If this file wrote its own, the measured rate would be the rate
// of a detector nobody ships, and a prompt change that moved the real guards
// would silently stop being measured.
//
// ---------------------------------------------------------------------------
// The one-turn look-back is not optional
// ---------------------------------------------------------------------------
//
// A claim can legitimately TRAIL the tool that backs it: the model books on
// one turn and confirms on the next. Scoring a claim against only its own
// turn's tool calls counts every one of those as a lie, and the number that
// comes out is the rate of ordinary conversation, not of fabrication.
// auditTurn already looks back one turn for exactly this reason and so does
// this. Getting this wrong is the shape of mistake this repository has made
// three times -- a metric named for one quantity that measures another.
//
// ---------------------------------------------------------------------------
// What it CANNOT see, stated so nobody reads a zero as innocence
// ---------------------------------------------------------------------------
//
// - A claim phrased in a way the regex does not match. Recall is the guard's,
//   and it is unmeasured.
// - A wrong TIME quoted after a genuine availability check. The offer test
//   asks whether anything was ever verified, not whether this slot was.
// - Anything about how the call sounded.
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx - the eval scenario ctx (`turns` and the config used)
 * @param {object} config - the business config the scenario ran with
 * @returns {{turns: number, claims: number, claimsWithoutTool: number,
 *            offers: number, offersUnverified: number, fabricated: boolean}}
 */
export function scoreFabrication(ctx, config) {
  const S = getStrings(config);
  const turns = ctx?.turns || [];

  let claims = 0;
  let claimsWithoutTool = 0;
  let offers = 0;
  let offersUnverified = 0;

  // "Has anything on this run ever verified a slot?" -- the offer guard's
  // authority is guards.js's verifiedSlots, which the eval cannot see, so the
  // nearest honest equivalent is whether an availability tool ever SUCCEEDED.
  // Named for what it is rather than pretending to be the guard's own set.
  let availabilityEverSucceeded = false;

  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    const text = (t?.reply || "").trim();
    const toolsThisTurn = (t?.toolCalls || []).length;
    const toolsPrevTurn = i > 0 ? (turns[i - 1]?.toolCalls || []).length : 0;

    if (!availabilityEverSucceeded) {
      availabilityEverSucceeded = (t?.toolResults || []).some(
        (r) => r?.success && /availability|open_times|slots/i.test(r?.name || "")
      );
    }

    if (!text) continue;

    if (S.completionClaimRe?.test(text)) {
      claims += 1;
      if (!toolsThisTurn && !toolsPrevTurn) claimsWithoutTool += 1;
    }

    if (S.slotOfferRe?.test(text)) {
      offers += 1;
      if (!availabilityEverSucceeded) offersUnverified += 1;
    }
  }

  return {
    turns: turns.length,
    claims,
    claimsWithoutTool,
    offers,
    offersUnverified,
    // A SESSION-level verdict, because that is the unit a caller experiences.
    // One fabricated claim in a six-turn call is a fabricated call.
    fabricated: claimsWithoutTool > 0 || offersUnverified > 0,
  };
}

/**
 * Roll a set of scored sessions into a rate, with the interval.
 *
 * The interval is returned and not optional. At the sample sizes this probe
 * can afford, a bare point estimate invites a comparison the data does not
 * support -- "it went from 10% to 7%" across two runs of a hundred is noise,
 * and this repository has already read an N=1 difference as a cause once.
 *
 * Normal approximation, which is adequate here and is named so nobody quotes
 * it as exact for a handful of events.
 */
export function fabricationRate(scores) {
  const n = scores.length;
  const k = scores.filter((s) => s.fabricated).length;
  if (!n) return { n: 0, k: 0, rate: null, ci95: null };
  const p = k / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return {
    n,
    k,
    rate: p,
    ci95: [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)],
  };
}
