// lib/voice/shadowCompare.js
//
// Hammersleys round 4 (item 6): the Deepgram-vs-Live hard-word table, pure.
// For each hard word the owner says on a test call (a street, a village, "half
// eight", a surname, a postcode), did each transcript hear it, and if not, what
// was its nearest same-length run of words. Only those words and their nearest
// matches leave this function -- never the rest of what the caller said.

const MAX_WORDS = 12;

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
 * @param {{live: string, deepgram: string, words: string[]}} input
 * @returns {{word: string, live_exact: boolean, live_closest: string, live_score: number,
 *            deepgram_exact: boolean, deepgram_closest: string, deepgram_score: number}[]}
 */
export function hardWordTable({ live, deepgram, words }) {
  return (Array.isArray(words) ? words : []).slice(0, MAX_WORDS).map((word) => {
    const l = closestMatch(live, word);
    const d = closestMatch(deepgram, word);
    return {
      word,
      live_exact: l.exact,
      live_closest: l.text,
      live_score: l.score,
      deepgram_exact: d.exact,
      deepgram_closest: d.text,
      deepgram_score: d.score,
    };
  });
}
