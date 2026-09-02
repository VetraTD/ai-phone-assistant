// ---------------------------------------------------------------------------
// Gemini Live usage accumulation.
//
// Gemini emits one `usageMetadata` message PER TURN, not a running total for
// the session. The first version of these probes stored `state.usage = msg
// .usageMetadata`, which kept only the last turn and under-reported a 5-turn
// conversation by roughly 3-4x. Measured directly before this file existed:
//
//   turn 1  promptTokenCount 8458  (TEXT 7728, AUDIO 96)
//   turn 2  promptTokenCount 4456  (TEXT 3894, AUDIO 205)
//   turn 3  promptTokenCount 4710  (TEXT 3928, AUDIO 389)
//
// Two things follow, and both matter beyond a bookkeeping fix:
//
//   1. Cost must be SUMMED across turns. A cap enforced against the last turn
//      only is not a cap.
//   2. Turn 2 costs about HALF of turn 1, not more. Whatever Gemini is doing,
//      it is not re-sending the full prefix as new input on every turn at full
//      price. That is worth stating plainly because the analysis doc's reseed
//      economics rest on the opposite assumption.
// ---------------------------------------------------------------------------

export function emptyUsage() {
  return { text_in: 0, audio_in: 0, text_out: 0, audio_out: 0, cached_in: 0, turns_billed: 0 };
}

/**
 * Fold one per-turn usageMetadata message into a running total.
 * @param {object} acc - from emptyUsage()
 * @param {object} u - a single usageMetadata message
 */
export function addUsage(acc, u) {
  if (!u) return acc;
  let sawDetail = false;
  for (const d of u.promptTokensDetails || []) {
    sawDetail = true;
    if (d.modality === "AUDIO") acc.audio_in += d.tokenCount || 0;
    else acc.text_in += d.tokenCount || 0;
  }
  for (const d of u.responseTokensDetails || []) {
    sawDetail = true;
    if (d.modality === "AUDIO") acc.audio_out += d.tokenCount || 0;
    else acc.text_out += d.tokenCount || 0;
  }
  for (const d of u.cacheTokensDetails || []) acc.cached_in += d.tokenCount || 0;
  // Fall back to the flat counters when the detail arrays are absent, so a
  // turn is never silently billed as zero.
  if (!sawDetail) {
    acc.text_in += u.promptTokenCount || 0;
    acc.audio_out += u.responseTokenCount || 0;
  }
  acc.turns_billed += 1;
  return acc;
}
