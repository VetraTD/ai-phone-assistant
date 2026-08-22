// ---------------------------------------------------------------------------
// Word error rate, for the C5b provider comparison.
//
// C5 is a blind TTS listen — it answers how the bot SOUNDS. This answers
// whether it HEARS, which is the half that is functional rather than
// aesthetic: a mis-transcription is a wrong booking or a misheard name, and
// STT latency sits inside the turn loop where A0 put the whole budget at ~3s.
//
// ---------------------------------------------------------------------------
// The normalisation decision, stated out loud because it moves the headline
// ---------------------------------------------------------------------------
//
// Both providers format numbers by default — Deepgram with `numerals: true`,
// Google with its own formatter. So a phone number read as "five five five,
// two" comes back as "5552" from both. Compared literally that is a 100% word
// error rate on the most common thing a caller says to a receptionist, for two
// providers that both heard it perfectly.
//
// So numbers are canonicalised on BOTH sides: number words become digits, and
// every digit run is split into single digits. "five five five two", "5552"
// and "555 2" all become 5 5 5 2. What survives is a comparison about what was
// HEARD rather than how it was rendered.
//
// This forgives a real difference in one direction — a provider that groups
// digits wrongly is not penalised — and that is deliberate, because grouping
// is a display concern and the LLM downstream reads digits either way. The
// raw, unnormalised rate is reported alongside so the choice stays visible.
// ---------------------------------------------------------------------------

/** Spoken forms that are the same token as a digit. */
const NUMBER_WORDS = new Map(Object.entries({
  zero: "0", oh: "0", o: "0", nought: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", thirty: "30", forty: "40", fifty: "50",
  sixty: "60", seventy: "70", eighty: "80", ninety: "90",
}));

/**
 * Split a transcript into comparable word tokens.
 *
 * @param {string|null|undefined} text
 * @param {{ expandNumbers?: boolean }} [opts] - false gives the RAW rate
 * @returns {string[]}
 */
export function normalizeTranscript(text, { expandNumbers = true } = {}) {
  if (typeof text !== "string") return [];

  const cleaned = text
    .toLowerCase()
    // Apostrophes survive: "that's" and "thats" are genuinely different words,
    // and merging them would forgive a real recognition difference. Everything
    // else that is not a letter, digit or apostrophe becomes a separator.
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    // A leading or trailing apostrophe is punctuation, not part of the word.
    .replace(/(^|\s)'+|'+(\s|$)/g, "$1$2")
    .trim();

  if (!cleaned) return [];

  const tokens = [];
  for (const word of cleaned.split(/\s+/)) {
    if (!word) continue;
    if (!expandNumbers) {
      tokens.push(word);
      continue;
    }
    const asNumber = NUMBER_WORDS.get(word);
    const value = asNumber !== undefined ? asNumber : word;
    // Split digit runs so "5552", "555 2" and "five five five two" agree.
    if (/^\d+$/.test(value)) tokens.push(...value.split(""));
    else tokens.push(value);
  }
  return tokens;
}

/**
 * Levenshtein distance over word tokens, with the edit types kept apart.
 *
 * The breakdown is not decoration: a provider that DELETES words is failing
 * differently from one that INVENTS them, and only the second can book an
 * appointment nobody asked for.
 *
 * @param {string[]} ref
 * @param {string[]} hyp
 */
function alignmentCounts(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  // d[i][j] = {cost, s, d, i} for ref[0..i) against hyp[0..j)
  const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const ops = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));

  for (let i = 0; i <= n; i++) {
    cost[i][0] = i;
    ops[i][0] = { s: 0, d: i, i: 0 };
  }
  for (let j = 0; j <= m; j++) {
    cost[0][j] = j;
    ops[0][j] = { s: 0, d: 0, i: j };
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const match = ref[i - 1] === hyp[j - 1];
      const sub = cost[i - 1][j - 1] + (match ? 0 : 1);
      const del = cost[i - 1][j] + 1;
      const ins = cost[i][j - 1] + 1;
      const best = Math.min(sub, del, ins);
      cost[i][j] = best;
      if (best === sub) {
        const p = ops[i - 1][j - 1];
        ops[i][j] = { s: p.s + (match ? 0 : 1), d: p.d, i: p.i };
      } else if (best === del) {
        const p = ops[i - 1][j];
        ops[i][j] = { s: p.s, d: p.d + 1, i: p.i };
      } else {
        const p = ops[i][j - 1];
        ops[i][j] = { s: p.s, d: p.d, i: p.i + 1 };
      }
    }
  }

  return ops[n][m];
}

/**
 * Word error rate of one hypothesis against one reference.
 *
 * NOT capped at 1. Standard WER is (S + D + I) / N and can exceed 1 when a
 * provider invents words, which is the worst failure mode available to it —
 * capping would hide exactly the case worth seeing.
 *
 * @param {string} reference - the ground-truth text
 * @param {string} hypothesis - what the provider returned
 * @param {{ expandNumbers?: boolean }} [opts]
 * @returns {{wer:number, substitutions:number, deletions:number, insertions:number, refWords:number, hypWords:number}}
 */
export function wordErrorRate(reference, hypothesis, opts = {}) {
  const ref = normalizeTranscript(reference, opts);
  const hyp = normalizeTranscript(hypothesis, opts);
  const { s, d, i } = alignmentCounts(ref, hyp);
  const errors = s + d + i;

  return {
    // An empty reference has no words to be wrong about. Reporting the error
    // COUNT rather than dividing by zero keeps the aggregate finite; a
    // reference is never empty in this corpus, and a NaN would poison a mean.
    wer: ref.length === 0 ? (errors === 0 ? 0 : errors) : errors / ref.length,
    substitutions: s,
    deletions: d,
    insertions: i,
    refWords: ref.length,
    hypWords: hyp.length,
  };
}

/**
 * Corpus-level WER: total errors over total reference words.
 *
 * Deliberately NOT the mean of per-utterance rates. Averaging rates weights a
 * three-word line the same as a fifteen-word one, so one short misheard line
 * would swing the headline more than a long one it got completely wrong.
 *
 * @param {Array<{reference: string, hypothesis: string}>} pairs
 * @param {{ expandNumbers?: boolean }} [opts]
 */
export function corpusWordErrorRate(pairs, opts = {}) {
  let errors = 0;
  let refWords = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  for (const { reference, hypothesis } of pairs) {
    const r = wordErrorRate(reference, hypothesis, opts);
    substitutions += r.substitutions;
    deletions += r.deletions;
    insertions += r.insertions;
    errors += r.substitutions + r.deletions + r.insertions;
    refWords += r.refWords;
  }

  return {
    wer: refWords === 0 ? 0 : errors / refWords,
    substitutions,
    deletions,
    insertions,
    refWords,
    utterances: pairs.length,
  };
}
