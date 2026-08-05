/**
 * Prompt assembler — merges capability prompt fragments into the engine's
 * fixed section skeleton.
 *
 * The engine owns the SHAPE of the prompt: which sections exist, their order,
 * their headers, and all safety text. A capability pack contributes only
 * fragments, and cannot move a section, rename a header, or remove a guardrail.
 * That asymmetry is the point — a business enabling a capability must never be
 * able to weaken the receptionist's safety floor.
 *
 * THE STATIC/DYNAMIC SPLIT IS LOAD-BEARING. Gemini's implicit caching hits on a
 * stable prompt PREFIX, so anything varying per turn (step, intent, current
 * time) must land in the dynamic tail. A pack leaking step-dependent text into
 * a static fragment silently collapses cache hit rate — no test would fail, the
 * calls would just cost more and respond slower. tests/promptSnapshot.test.js
 * asserts the prefix is identical across every step and intent for exactly this
 * reason.
 */

import { listPacks } from "../../capabilities/index.js";

/**
 * Merge the static (cacheable) fragments from every pack.
 *
 * @param {object} config - normalised business config
 * @param {object} ctx - { integrations, transferAllowed, ... }
 * @returns {{capabilities: string[], protocols: string[], escalation: string[], guardrails: string[], capabilityNotes: string[]}}
 */
export function collectStaticFragments(config, ctx = {}) {
  const merged = { capabilities: [], protocols: [], escalation: [], guardrails: [], capabilityNotes: [] };

  for (const pack of listPacks()) {
    if (typeof pack.prompt !== "function") continue;
    const fragment = pack.prompt(config, ctx) || {};
    const stat = fragment.static || {};
    for (const key of Object.keys(merged)) {
      const value = stat[key];
      if (Array.isArray(value)) merged[key].push(...value.filter(Boolean));
    }
  }

  return merged;
}

/**
 * Build the intent -> step-guidance map contributed by packs.
 *
 * Returned as a plain object rather than resolved text because guidance is
 * dynamic: the appointments flow renders today's business hours inline, and
 * forks on whether an EHR owns the appointment book.
 *
 * @param {object} config
 * @param {object} ctx - { integrations, hasEhrIntegration, now, ... }
 * @returns {Record<string, string>}
 */
export function collectStepGuidance(config, ctx = {}) {
  const guidance = {};

  for (const pack of listPacks()) {
    if (typeof pack.prompt !== "function") continue;
    const fragment = pack.prompt(config, ctx) || {};
    const byIntent = fragment.dynamic?.stepGuidance;
    if (!byIntent) continue;

    for (const [intent, text] of Object.entries(byIntent)) {
      if (!text) continue;
      if (guidance[intent]) {
        // Two packs claiming the same intent would make the model's guidance
        // depend on registry order, which is not a thing an operator can see or
        // reason about. Fail loudly instead.
        throw new Error(
          `Two capability packs both provide step guidance for intent "${intent}". ` +
            `An intent must have exactly one owner.`
        );
      }
      guidance[intent] = text;
    }
  }

  return guidance;
}

/**
 * Rules that belong to the CALLER CONTEXT block — what to DO about a caller's
 * existing records, as opposed to what those records are.
 *
 * Separate from stepGuidance because stepGuidance is keyed on INTENT, and intent
 * is decided by the model. On production call 0db83104 the assistant offered a
 * strategy call to someone who already had one: it was still in general_question
 * when it made the offer, so book_appointment's guidance had not been rendered
 * and nothing had told it to look. A rule that only applies once the model has
 * agreed the call is about booking cannot govern the moment the model itself
 * raises booking.
 *
 * Rendered only when the caller actually has records, so a first-time caller
 * pays nothing.
 *
 * @param {object} config
 * @param {object} ctx - { integrations, now, ... }
 * @returns {string[]}
 */
export function collectCallerContextRules(config, ctx = {}) {
  const out = [];

  for (const pack of listPacks()) {
    if (typeof pack.prompt !== "function") continue;
    const fragment = pack.prompt(config, ctx) || {};
    const rules = fragment.dynamic?.callerContextRules;
    if (Array.isArray(rules)) out.push(...rules.filter(Boolean));
  }

  return out;
}

/** Length caps for a rendered caller fact (see sanitizeFact). */
const MAX_LABEL_LEN = 40;
const MAX_VALUE_LEN = 120;

/**
 * Sanitize a caller-fact label or value before it reaches collectCallerFacts'
 * output — and from there, verbatim, the system prompt every turn
 * (services/gemini.js buildDynamicTail renders `- ${label}: ${value}` with no
 * escaping of its own). A fact's value can originate from caller speech
 * relayed through the model (a name, a service type), so it must never be
 * able to inject prompt structure — a fake `=== SECTION ===` header, or a
 * `[BEGIN ...]` / `[END ...]` bracket token mimicking some other framing
 * convention — and an unbounded value must never be able to bloat the prompt
 * sent on every single turn.
 * @param {string} raw
 * @param {number} maxLen
 * @returns {string}
 */
export function sanitizeFact(raw, maxLen) {
  let s = String(raw)
    .replace(/\s+/g, " ") // collapse whitespace/newlines to single spaces
    .replace(/={3,}/g, "") // strip "===" (and longer) header-fence sequences
    .replace(/\[BEGIN[^\]]*\]?/gi, "") // strip [BEGIN ...] / [BEGIN tokens
    .replace(/\[END[^\]]*\]?/gi, "") // strip [END ...] / [END tokens
    .replace(/\s+/g, " ") // the strips above can leave doubled spaces
    .trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1).trimEnd()}…`;
  return s;
}

/**
 * Gather display-ready caller facts written by packs into their capabilityState.
 *
 * Convention (not a hardcoded list): any pack — or the engine — may record facts
 * the call has already established under the reserved key
 * `capabilityState.<packId>.callerFacts`, a flat string->string map whose values
 * are already human-readable. buildDynamicTail renders them so the model stops
 * re-asking a confirmed name or contradicting a booking it just made.
 *
 * Order is stable and explainable: registry order (capabilities/index.js) across
 * packs, then key-insertion order within each pack's map. Non-string values are
 * ignored defensively — a fact reaches the model verbatim, so a stray object or
 * number must never leak into the prompt.
 *
 * Every label and value is run through sanitizeFact: whitespace/newlines
 * collapsed, "===" header fences and "[BEGIN"/"[END" bracket tokens stripped,
 * and the result capped (40 chars for a label, 120 for a value, ellipsized) —
 * a fact is rendered into the prompt with no further escaping, so this is the
 * only chokepoint that stands between caller-supplied text and prompt
 * structure the model would otherwise treat as instructions.
 *
 * @param {object} [capabilityState] - the per-call scratchpad, keyed by pack id
 * @returns {Array<{label: string, value: string, packId: string}>}
 */
export function collectCallerFacts(capabilityState) {
  const facts = [];
  if (!capabilityState || typeof capabilityState !== "object") return facts;

  for (const pack of listPacks()) {
    const map = capabilityState[pack.id]?.callerFacts;
    if (!map || typeof map !== "object") continue;
    for (const [label, value] of Object.entries(map)) {
      if (typeof value !== "string") continue;
      facts.push({
        label: sanitizeFact(label, MAX_LABEL_LEN),
        value: sanitizeFact(value, MAX_VALUE_LEN),
        packId: pack.id,
      });
    }
  }

  return facts;
}
