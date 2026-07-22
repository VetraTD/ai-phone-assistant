/**
 * Capability registry.
 *
 * The single place that knows which capability packs exist. Adding a
 * capability is one new file plus one line in PACKS — see
 * capabilities/_contract.js for what a pack must provide, and
 * docs/superpowers/specs/2026-07-22-capability-packs-design.md for why.
 *
 * ORDER IS LOAD-BEARING (for now). PACKS order determines the order tool
 * declarations reach the model, and today's order is asserted byte-for-byte by
 * tests/promptSnapshot.test.js. It reproduces the sequence the old hardcoded
 * builders in services/gemini.js produced:
 *
 *   set_call_intent, end_call        <- engine, not a pack
 *   book_appointment                 <- appointments
 *   record_customer_request          <- messages
 *   request_transfer                 <- transfer
 *   <webhook integration tools>      <- engine (the generic escape hatch)
 *   <athena OR db appointment tools> <- appointments.adapterTools
 *
 * Reordering PACKS is a real change to what the model sees, so it needs a
 * deliberate snapshot update, not a silent one.
 */

import appointments from "./appointments.js";
import messages from "./messages.js";
import transfer from "./transfer.js";

/** @type {import("./_contract.js").CapabilityPack[]} */
const PACKS = [appointments, messages, transfer];

const BY_ID = new Map(PACKS.map((p) => [p.id, p]));

// name -> pack, built once at module load. Static (declared via each pack's
// toolNames) rather than derived from tools(cfg), because dispatch in
// services/tools.js must resolve a tool name without knowing the tenant's
// config — a tool the model somehow called for a disabled capability must
// resolve to its owner and be refused there, not fall through as "unknown".
const TOOL_OWNER = new Map();
for (const pack of PACKS) {
  for (const name of pack.toolNames || []) {
    const existing = TOOL_OWNER.get(name);
    if (existing) {
      throw new Error(
        `Capability tool name collision: "${name}" declared by both "${existing.id}" and "${pack.id}". ` +
          `Tool names must be globally unique — the model addresses tools by name alone.`
      );
    }
    TOOL_OWNER.set(name, pack);
  }
}

/**
 * All registered packs, in canonical order.
 * @returns {import("./_contract.js").CapabilityPack[]}
 */
export function listPacks() {
  return [...PACKS];
}

/**
 * @param {string} id
 * @returns {import("./_contract.js").CapabilityPack | null}
 */
export function getPack(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Which pack owns a tool name.
 * @param {string} toolName
 * @returns {import("./_contract.js").CapabilityPack | null}
 */
export function packForTool(toolName) {
  return TOOL_OWNER.get(toolName) ?? null;
}

/** Every tool name any pack can ever contribute. */
export function allCapabilityToolNames() {
  return [...TOOL_OWNER.keys()];
}

/**
 * Tool declarations contributed by packs, in registry order.
 *
 * TRANSITIONAL (Step A): packs still read `config.allowedTasks` to decide what
 * to register, exactly as the old builders did, so behavior is unchanged.
 * Step B replaces that with explicit per-capability `enabled` rows from
 * database/020_business_capabilities.sql.
 *
 * @param {object} config - normalised business config
 * @param {object} [ctx] - { integrations }
 * @returns {import("./_contract.js").CapabilityTool[]}
 */
export function collectTools(config, ctx = {}) {
  const out = [];
  for (const pack of PACKS) {
    if (typeof pack.tools !== "function") continue;
    out.push(...(pack.tools(config, ctx) || []));
  }
  return out;
}

/**
 * Backend-shaped tool declarations (the EHR-vs-internal-DB fork today).
 * Kept separate from collectTools purely to preserve the order the model has
 * always seen; Step B folds this into adapter resolution.
 *
 * @param {object} config
 * @param {object} [ctx] - { integrations }
 * @returns {import("./_contract.js").CapabilityTool[]}
 */
export function collectAdapterTools(config, ctx = {}) {
  const out = [];
  for (const pack of PACKS) {
    if (typeof pack.adapterTools !== "function") continue;
    out.push(...(pack.adapterTools(config, ctx) || []));
  }
  return out;
}

/**
 * Names of tools whose success is caller-visible and should unlock same-turn
 * end_call. Replaces the hardcoded ACTION_TOOL_NAMES array that used to live in
 * services/gemini.js — a pack now declares this itself via `isAction`, so a new
 * capability's action tool is picked up without an engine edit.
 * @returns {string[]}
 */
export function actionToolNames() {
  const out = [];
  for (const pack of PACKS) {
    out.push(...(pack.actionTools || []));
  }
  return out;
}
