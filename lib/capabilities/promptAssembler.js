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
