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
const MAX_SAY = 60;
const MAX_IPA = 60;

// Letters, marks, digits, spaces, apostrophes, hyphens, dots, ampersands.
// No quotes, braces, colons or newlines: the spoken form is written into the
// model's prompt, so it must not be able to carry an instruction of its own.
const SAFE_TEXT = /^[\p{L}\p{M}\p{N}'’ .&-]+$/u;
const SAFE_IPA = /^[\p{L}\p{M}ˈˌːˑ. -]+$/u;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The usable entries of a business's map, longest written form first (so a
 * multi-word entry wins over a single word inside it).
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
    if (!written || written.length > MAX_WRITTEN || !SAFE_TEXT.test(written)) continue;
    if (!say || say.length > MAX_SAY || !SAFE_TEXT.test(say)) continue;
    const ipaRaw = value && typeof value === "object" && typeof value.ipa === "string" ? value.ipa.trim() : "";
    const ipa = ipaRaw && ipaRaw.length <= MAX_IPA && SAFE_IPA.test(ipaRaw) ? ipaRaw : null;
    out.push({ written, say, ipa });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.sort((a, b) => b.written.length - a.written.length);
}

/**
 * A whole-word match of `written` that is not part of an email address, a web
 * address or a social handle: "info@digile-media.com", "digile-media.com" and
 * "@digilemedia" keep their real letters because a caller has to be able to
 * use them.
 */
function writtenRe(written) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}@./_-])${escapeRe(written)}(?![\\p{L}\\p{N}_@]|[\\p{L}\\p{N}_-]*\\.[a-z]{2,})`,
    "giu"
  );
}

/** "Dij-aisle" also matches "Dij aisle", "Dijaisle" and any case. */
function spokenRe(say) {
  const parts = say.split(/[\s-]+/).filter(Boolean).map(escapeRe);
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("[\\s-]?")}(?![\\p{L}\\p{N}])`, "giu");
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

const PROSE_FIELDS =["businessName", "greeting", "generalInfo", "customInstructions", "recordingDisclosureText"];

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
