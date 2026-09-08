// Pure helpers for the live transcript. No React, no DOM, so they can be
// tested against the real transcript JSON without a browser.
//
// A word is "active" from its own start until the NEXT word starts, so the
// highlight never blanks during the small gaps between words. After the last
// word it stays lit for TAIL_SECONDS and then clears.

export const TAIL_SECONDS = 0.75;

function isActiveAt(words, i, t) {
  const w = words[i];
  if (t < w.start) return false;
  if (i === words.length - 1) return t <= w.end + TAIL_SECONDS;
  return t < words[i + 1].start;
}

/**
 * Index of the word being spoken at time `t`, or -1 when none is.
 *
 * `hint` is the previous answer. Playback advances one word at a time, so
 * checking `hint` and `hint + 1` first avoids the search on almost every
 * frame; the binary search is the fallback for seeks.
 */
export function findActiveWordIndex(words, t, hint = -1) {
  const n = words ? words.length : 0;
  if (!n || !Number.isFinite(t)) return -1;
  if (t < words[0].start) return -1;
  if (t > words[n - 1].end + TAIL_SECONDS) return -1;

  if (hint >= 0 && hint < n) {
    if (isActiveAt(words, hint, t)) return hint;
    if (hint + 1 < n && isActiveAt(words, hint + 1, t)) return hint + 1;
  }

  // Last index whose start <= t.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Split a flat word list into speaker turns: half-open index ranges
 * `[from, to)` with the speaker id and the time span they cover.
 */
export function groupIntoTurns(words) {
  const turns = [];
  if (!words || !words.length) return turns;
  let from = 0;
  for (let i = 1; i <= words.length; i++) {
    if (i === words.length || words[i].speaker !== words[from].speaker) {
      turns.push({
        speaker: words[from].speaker,
        start: words[from].start,
        end: words[i - 1].end,
        from,
        to: i,
      });
      from = i;
    }
  }
  return turns;
}

/** Index of the turn that contains word `i`, or -1. */
export function turnIndexForWord(turns, i) {
  if (i < 0 || !turns || !turns.length) return -1;
  let lo = 0;
  let hi = turns.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (turns[mid].from <= i) lo = mid;
    else hi = mid - 1;
  }
  return turns[lo].from <= i && i < turns[lo].to ? lo : -1;
}

/** "m:ss" for a time in seconds; "–:––" when the duration is not known yet. */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
