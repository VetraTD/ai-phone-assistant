/**
 * LVX192, Task 5. The numbered questions in a business's message notes, and
 * which of them still have no saved answer.
 *
 * Pure and offline. The model is the one that asks; this only lets the save
 * reply NAME the questions still open, so a caller who answers three in one
 * line is still asked the rest.
 *
 * Matching is by label: a saved answer's label (the `label` the model put in
 * `details`) answers a question when they share a content word, or when the
 * compacted forms agree ("pick-up" = "pickup"). Deliberately no stemming:
 * "Passenger" (the other person's name) must not answer "Passengers".
 */

/** @typedef {{ n: number, label: string, words: string[], compact: string }} NotesQuestion */

const ITEM_RE = /^\s*(\d{1,2})[.)]\s+(\S.*)$/;
const MAX_LABEL = 40;
const STOP = new Set([
  "the", "a", "an", "of", "to", "their", "your", "his", "her", "its", "what", "they", "them", "you",
  "is", "are", "and", "or", "on", "in", "for", "it", "how", "which", "who", "any", "if",
  "back", "main", "thing", "time", "right", "now", "call",
]);

const tokens = (text) =>
  String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const compactOf = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Content words; a label made only of stop words keeps all its words. */
function contentWords(text) {
  const all = tokens(text);
  const kept = all.filter((w) => !STOP.has(w));
  return [...new Set(kept.length ? kept : all)];
}

function labelOf(text) {
  const colon = text.indexOf(":");
  if (colon > 0 && colon <= MAX_LABEL) return text.slice(0, colon).trim();
  let clause = text.split(/[.;:,?!]/)[0].trim();
  if (clause.length > MAX_LABEL) {
    const cut = clause.slice(0, MAX_LABEL + 1);
    const space = cut.lastIndexOf(" ");
    clause = (space > 0 ? cut.slice(0, space) : clause.slice(0, MAX_LABEL)).trim();
  }
  return clause;
}

/**
 * @param {unknown} notes
 * @returns {NotesQuestion[]} empty unless at least two numbered items parse
 */
export function parseNotesQuestions(notes) {
  if (typeof notes !== "string" || !notes.trim()) return [];
  /** @type {NotesQuestion[]} */
  const out = [];
  for (const line of notes.split(/\r?\n/)) {
    const m = ITEM_RE.exec(line);
    if (!m) continue;
    const label = labelOf(m[2]);
    if (!label) continue;
    out.push({ n: Number(m[1]), label, words: contentWords(label), compact: compactOf(label) });
  }
  return out.length >= 2 ? out : [];
}

/**
 * Does a saved label answer this question? Exported (round 6) so the
 * answerParts setting matches its labels the same way, never by a copy.
 */
export function labelAnswers(question, savedLabel) {
  return answers(question, savedLabel);
}

/** The same match for a bare label ("Pickup"), as if it were a numbered question. */
export function labelMatches(label, savedLabel) {
  return answers({ words: contentWords(label), compact: compactOf(label) }, savedLabel);
}

function answers(question, savedLabel) {
  if (typeof savedLabel !== "string") return false;
  const saved = contentWords(savedLabel);
  if (question.words.some((w) => saved.includes(w))) return true;
  const compact = compactOf(savedLabel);
  if (!compact || !question.compact) return false;
  return compact === question.compact || (question.compact.length >= 4 && compact.includes(question.compact));
}

/**
 * @param {NotesQuestion[]} questions
 * @param {string[]} savedLabels
 * @returns {NotesQuestion[]} the questions no saved label answers, in order
 */
export function openQuestions(questions, savedLabels) {
  const saved = Array.isArray(savedLabels) ? savedLabels : [];
  return questions.filter((q) => !saved.some((s) => answers(q, s)));
}

/** True when at least one saved label answers a numbered question. */
export function anyAnswered(questions, savedLabels) {
  const saved = Array.isArray(savedLabels) ? savedLabels : [];
  return questions.some((q) => saved.some((s) => answers(q, s)));
}
