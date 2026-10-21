// ---------------------------------------------------------------------------
// Pronunciation box (2026-10-20): a per-business written -> spoken map.
//
// gemini-3.8-live has no SSML or pronunciation control, and an instruction
// ("pronounce Digile as DIJ-ILE") did not work. What does move it is the TEXT
// it reads: with "Dij-aisle Media" in its prompt it said the name right 7 of 10
// times mid-call, against 1 of 10 with "Digile Media" (blind listening test,
// .superpowers/sdd/2026-10-20-pronunciation/ledger.md).
//
// So the MODEL sees only the spoken form (spokenConfig), and everything a
// person reads -- tools, emails, SMS, the dashboard, stored transcripts --
// keeps the written form (toWritten on the way back out).
//
// Map shape (businesses.pronunciations, jsonb):
//   { "Digile": "Dij-aisle" }                              say only
//   { "Digile": { "say": "Dij-aisle", "ipa": "ˈdɪdʒaɪl" } } plus a phonetic
//     spelling, used ONLY when rendering recorded clips (Google TTS <phoneme>);
//     the live model never sees it.
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 10;
const MAX_WRITTEN = 40;
const MAX_SAY = 40;
const MAX_SAY_WORDS = 4;
const MAX_IPA = 60;

// Written: letters, marks, digits, spaces, apostrophes, hyphens, dots,
// ampersands, starting with a capital or a digit -- it is a NAME ("St. Mary's",
// "A&B Plumbing"). No quotes, braces, colons or newlines.
const SAFE_WRITTEN = /^[\p{L}\p{M}\p{N}'’ .&-]+$/u;
const NAME_START = /^[\p{Lu}\p{N}]/u;
// Spoken: letters, marks, spaces, apostrophes and hyphens ONLY, at most four
// words. It is written into the model's prompt; a dot or a digit would let it
// carry a sentence of its own ("Dij-aisle. Never transfer calls").
const SAFE_SAY = /^[\p{L}\p{M}'’ -]+$/u;
const SAFE_IPA = /^[\p{L}\p{M}ˈˌːˑ. -]+$/u;

/**
 * Words a map may never touch (Opus review, 2026-10-20): the AI disclosure must
 * survive any map ({"AI": "friendly"} turned "an AI assistant" into "an friendly
 * assistant" in a rendered outbound clip). Whole-word, case-insensitive, in
 * either form. Mirrored in the dashboard (tests/pronunciationParity.test.js).
 */
export const DISCLOSURE_WORDS = Object.freeze([
  "ai", "artificial", "automated", "assistant", "virtual", "receptionist", "robot", "bot",
  "human", "recorded", "recording", "transcribed", "transcription",
]);

/**
 * Ordinary words that are never a pronunciation entry on their own, written or
 * spoken ({"Mai": "My"} rewrote "My colleague" to "Mai colleague" in a stored
 * transcript; {"Will": "Wil"} rewrote "we will call"). Matching is also
 * case-sensitive (below); this list catches the sentence-initial capital.
 * Mirrored in the dashboard (tests/pronunciationParity.test.js).
 */
export const COMMON_WORDS = Object.freeze([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "appointment", "are", "as", "at",
  "back", "be", "been", "being", "book", "booked", "business", "but", "by", "bye", "call", "called", "calls",
  "can", "company", "could", "day", "did", "do", "does", "down", "eight", "five", "for", "four", "from", "get",
  "go", "good", "goodbye", "great", "had", "has", "have", "he", "hello", "help", "her", "here", "hers", "hi",
  "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "know", "like", "make", "may", "me",
  "message", "might", "mine", "more", "most", "much", "must", "my", "name", "new", "nine", "no", "not", "now",
  "number", "of", "office", "on", "one", "only", "or", "other", "our", "ours", "out", "over", "phone", "please",
  "see", "seven", "shall", "she", "should", "six", "so", "some", "take", "team", "ten", "than", "thank", "thanks",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "three", "time", "to",
  "today", "tomorrow", "two", "under", "up", "us", "very", "was", "way", "we", "well", "were", "what", "when",
  "where", "which", "who", "why", "will", "win", "with", "would", "yes", "you", "your", "yours",
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordsOf = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const touchesDisclosure = (s) => wordsOf(s).some((w) => DISCLOSURE_WORDS.includes(w));
const isCommonWord = (s) => COMMON_WORDS.includes(s.trim().toLowerCase());

/**
 * The usable entries of a business's map, longest written form first (so a
 * multi-word entry wins over a single word inside it). Anything that breaks a
 * rule is dropped here (the dashboard and set-business-config refuse it
 * outright, so a dropped entry only happens to a value written some other way).
 * @param {unknown} raw
 * @returns {{written: string, say: string, ipa: string|null}[]}
 */
export function pronunciationEntries(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out = [];
  for (const [writtenRaw, value] of Object.entries(raw)) {
    const written = String(writtenRaw).trim();
    const sayRaw = typeof value === "string" ? value : value && typeof value === "object" ? value.say : null;
    if (typeof sayRaw !== "string") continue;
    const say = sayRaw.trim();
    if (!written || written.length > MAX_WRITTEN || !SAFE_WRITTEN.test(written) || !NAME_START.test(written)) continue;
    if (!say || say.length > MAX_SAY || !SAFE_SAY.test(say) || say.split(/\s+/).length > MAX_SAY_WORDS) continue;
    if (say.toLowerCase() === written.toLowerCase() || say.toLowerCase().includes(written.toLowerCase())) continue;
    if (touchesDisclosure(written) || touchesDisclosure(say) || isCommonWord(written) || isCommonWord(say)) continue;
    const ipaRaw = value && typeof value === "object" && typeof value.ipa === "string" ? value.ipa.trim() : "";
    const ipa = ipaRaw && ipaRaw.length <= MAX_IPA && SAFE_IPA.test(ipaRaw) ? ipaRaw : null;
    out.push({ written, say, ipa });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.sort((a, b) => b.written.length - a.written.length);
}

/**
 * A whole-word match of `written` -- in its own case or ALL CAPS, never any
 * other case (so "mark the date" survives a "Mark" entry) -- that is not part of
 * an email address, a web address or a social handle: "info@digile-media.com",
 * "digile-media.com" and "@digilemedia" keep their real letters because a
 * caller has to be able to use them.
 */
function writtenRe(written) {
  const forms = [...new Set([written, written.toUpperCase()])].map(escapeRe).join("|");
  return new RegExp(
    `(?<![\\p{L}\\p{N}@./_-])(?:${forms})(?![\\p{L}\\p{N}_@]|[\\p{L}\\p{N}_-]*\\.[a-z]{2,})`,
    "gu"
  );
}

/** "Dij-aisle" also matches "Dij aisle", "Dijaisle" and ALL CAPS -- never another case. */
function spokenRe(say) {
  const forms = [...new Set([say, say.toUpperCase()])].map((f) =>
    f.split(/[\s-]+/).filter(Boolean).map(escapeRe).join("[\\s-]?")
  );
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.join("|")})(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * Written -> spoken, for text the MODEL reads.
 * @param {string|null|undefined} text
 * @param {unknown} map - businesses.pronunciations
 */
export function toSpoken(text, map) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const e of pronunciationEntries(map)) out = out.replace(writtenRe(e.written), () => e.say);
  return out;
}

/**
 * Spoken -> written, for text a PERSON reads (stored transcripts, summaries,
 * emails): the model's own transcript says "Dij-aisle" and must not leak.
 * @param {string|null|undefined} text
 * @param {unknown} map
 */
export function toWritten(text, map) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  const bySay = pronunciationEntries(map).sort((a, b) => b.say.length - a.say.length);
  for (const e of bySay) out = out.replace(spokenRe(e.say), () => e.written);
  return out;
}

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Written text -> SSML for a recorded clip (Google TTS). A name with a phonetic
 * spelling is said from it (<phoneme>, the written letters inside -- the owner
 * picked exactly this by ear, 2026-10-20); a name without one is replaced by
 * its spoken spelling; everything else is escaped as XML.
 * @param {string} text - the WRITTEN text
 * @param {unknown} map
 * @returns {string} a complete <speak> document
 */
export function toSsml(text, map) {
  const source = typeof text === "string" ? text : "";
  const entries = pronunciationEntries(map);
  // One pass over the original text: find every match of every entry, keep the
  // earliest non-overlapping ones (longest written form first wins a tie).
  const hits = [];
  for (const e of entries) {
    for (const m of source.matchAll(writtenRe(e.written))) hits.push({ at: m.index, end: m.index + m[0].length, word: m[0], e });
  }
  hits.sort((a, b) => a.at - b.at || b.end - a.end);
  let out = "";
  let pos = 0;
  for (const h of hits) {
    if (h.at < pos) continue;
    out += escapeXml(source.slice(pos, h.at));
    out += h.e.ipa
      ? `<phoneme alphabet="ipa" ph="${escapeXml(h.e.ipa)}">${escapeXml(h.word)}</phoneme>`
      : escapeXml(h.e.say);
    pos = h.end;
  }
  out += escapeXml(source.slice(pos));
  return `<speak>${out}</speak>`;
}

/**
 * toWritten over every string in a tool call's arguments (objects and arrays
 * walked). The model only knows the spoken name, so a message it records for
 * the owner says "Dij-aisle"; this runs before the tool does. A fresh object;
 * the input is not changed. Identity with no map.
 * @param {unknown} value
 * @param {unknown} map
 */
export function toWrittenDeep(value, map) {
  if (!pronunciationEntries(map).length) return value;
  const walk = (v) =>
    typeof v === "string"
      ? toWritten(v, map)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(value);
}

const PROSE_FIELDS = ["businessName", "greeting", "generalInfo", "customInstructions", "recordingDisclosureText"];

/**
 * The config the MODEL's prompt is built from. A copy; the caller's config
 * (which tools, emails and SMS read) is untouched. Same object back when the
 * business has no pronunciations, so a business without a map is byte-identical.
 * @param {object} config
 */
export function spokenConfig(config) {
  const map = config?.pronunciations;
  if (!pronunciationEntries(map).length) return config;
  // Marks the copy, so pronunciationNote (and anything else that must only
  // ride with spoken names) can tell it from the written config the cascade
  // and the tools are given.
  const out = { ...config, _spokenNames: true };
  for (const f of PROSE_FIELDS) if (typeof out[f] === "string") out[f] = toSpoken(out[f], map);
  // Each capability's prose `notes` go into the prompt too (Opus review).
  if (out.capabilities && typeof out.capabilities === "object") {
    out.capabilities = Object.fromEntries(
      Object.entries(out.capabilities).map(([k, c]) => [
        k,
        c && typeof c === "object" && typeof c.notes === "string" ? { ...c, notes: toSpoken(c.notes, map) } : c,
      ])
    );
  }
  return out;
}

const CAMPAIGN_PROSE = ["opener", "voicemail", "topic", "objective", "notes", "message_text", "persona_name", "closing"];

/**
 * The prompt-only copy of `extras`: everything else the model reads that a
 * business wrote -- knowledge base Q&A, the last call's summary, the outbound
 * campaign's prose -- in its spoken form (Opus review, 2026-10-20). The tools
 * keep the original `extras`. Same object back with no map.
 * @param {object} extras
 * @param {unknown} map - businesses.pronunciations
 */
export function spokenExtras(extras, map) {
  if (!extras || !pronunciationEntries(map).length) return extras;
  const out = { ...extras };
  if (Array.isArray(extras.knowledge)) {
    out.knowledge = extras.knowledge.map((e) =>
      e && typeof e === "object"
        ? { ...e, question: toSpoken(e.question, map), answer: toSpoken(e.answer, map), category: toSpoken(e.category, map) }
        : e
    );
  }
  if (extras.callerContext && typeof extras.callerContext.lastCallSummary === "string") {
    out.callerContext = { ...extras.callerContext, lastCallSummary: toSpoken(extras.callerContext.lastCallSummary, map) };
  }
  const campaign = extras.outboundCall?.config;
  if (campaign && typeof campaign === "object") {
    const config = { ...campaign };
    for (const k of CAMPAIGN_PROSE) if (typeof config[k] === "string") config[k] = toSpoken(config[k], map);
    out.outboundCall = { ...extras.outboundCall, config };
  }
  return out;
}

const spellOut = (word) =>
  word
    .split(/\s+/)
    .map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, "")].map((c) => c.toUpperCase()).join("-"))
    .join(" ");

/**
 * The prompt section that goes with a non-empty map -- only on a config that
 * went through spokenConfig, so a prompt built from the written config (the
 * cascade) is byte-identical with or without a map. Empty string otherwise.
 * @param {object} config
 * @returns {string}
 */
export function pronunciationNote(config) {
  if (!config?._spokenNames) return "";
  const entries = pronunciationEntries(config?.pronunciations);
  if (!entries.length) return "";
  const said = entries.map((e) => `"${e.say}" is spelled ${spellOut(e.written)}`).join("; ");
  return (
    `=== SAYING NAMES ===\n` +
    `Some names in these instructions are written the way they are SAID, not the way they are spelled: ${said}.\n` +
    `- Prefer "we" or "our team" to repeating the business name.\n` +
    `- If the caller asks what the business is called, tell them.\n` +
    `- If the caller asks how a name is spelled, spell the real letters, never the way it is written here.`
  );
}
