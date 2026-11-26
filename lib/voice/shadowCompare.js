// lib/voice/shadowCompare.js
//
// Hammersleys round 4 (item 6): the Deepgram-vs-Live hard-word table, pure.
// For each hard word the owner says on a test call (a street, a village, "half
// eight", a surname, a postcode), did each transcript hear it, and if not, what
// was its nearest same-length run of words. Only those words and their nearest
// matches leave this function -- never the rest of what the caller said.

const MAX_WORDS = 12;
/** Review M5: a hard "word" is at most this many words, so a match never prints more of the call. */
const MAX_WORD_TOKENS = 4;

const tokens = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const similarity = (a, b) => {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  const max = Math.max(x.length, y.length);
  return max === 0 ? 0 : 1 - editDistance(x, y) / max;
};

/**
 * The run of words in `text` nearest to `word` (same word count).
 * @returns {{exact: boolean, text: string, score: number}}
 */
export function closestMatch(text, word) {
  const t = tokens(text);
  const w = tokens(word);
  if (!t.length || !w.length) return { exact: false, text: "", score: 0 };
  const target = w.join(" ");
  let best = { exact: false, text: "", score: 0 };
  for (let i = 0; i + w.length <= t.length; i++) {
    const run = t.slice(i, i + w.length).join(" ");
    if (run === target) return { exact: true, text: run, score: 1 };
    const score = Math.round(similarity(run, target) * 100) / 100;
    if (score > best.score) best = { exact: false, text: run, score };
  }
  return best;
}

/**
 * The Deepgram segment whose text holds `word`'s best match, with that match.
 * A phrase split across two segments is matched within one segment only.
 */
function bestSegmentMatch(segments, word) {
  let best = { exact: false, text: "", score: 0, t_ms: null };
  for (const s of segments) {
    const m = closestMatch(s?.text, word);
    if (m.score > best.score) best = { ...m, t_ms: Number.isFinite(s?.t_ms) ? s.t_ms : null };
    if (m.exact) break;
  }
  return best;
}

/**
 * @param {{live: string, deepgram?: string, segments?: {t_ms: number, text: string}[], words: string[]}} input
 *   With `segments` (the shadow's own), each row also says when the segment
 *   holding Deepgram's best match arrived (ms since the shadow stream started).
 * @returns {{word: string, live_exact: boolean, live_closest: string, live_score: number,
 *            deepgram_exact: boolean, deepgram_closest: string, deepgram_score: number,
 *            deepgram_t_ms: number|null}[]}
 */
export function hardWordTable({ live, deepgram, segments, words }) {
  const segs = Array.isArray(segments) ? segments : null;
  return (Array.isArray(words) ? words : []).slice(0, MAX_WORDS).map((raw) => {
    const word = String(raw || "").trim().split(/\s+/).slice(0, MAX_WORD_TOKENS).join(" ");
    const l = closestMatch(live, word);
    const d = segs ? bestSegmentMatch(segs, word) : { ...closestMatch(deepgram, word), t_ms: null };
    return {
      word,
      live_exact: l.exact,
      live_closest: l.text,
      live_score: l.score,
      deepgram_exact: d.exact,
      deepgram_closest: d.text,
      deepgram_score: d.score,
      deepgram_t_ms: d.score > 0 ? d.t_ms : null,
    };
  });
}
