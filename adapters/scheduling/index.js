/**
 * Scheduling adapters — where a business's appointments actually live.
 *
 * The appointments capability decides WHAT to do; an adapter decides WHERE it
 * lands. Swapping athenahealth for Cerner, Google Calendar, or the internal
 * table must be a config change with the prompt untouched, which is only true
 * if the capability never names a backend. Before this existed,
 * `provider === "athenahealth"` was written literally into services/gemini.js
 * twice and into the tool executor once.
 *
 * Every adapter publishes `verifiableFields`: the facts it can actually prove a
 * caller against. That list is what stops an operator configuring a guarantee
 * the backend cannot deliver — a business on a webhook cannot verify a dental
 * number against anything, and the settings UI must not offer to. A promise
 * that is not real is worse than an honest speed bump.
 */

import internal from "./internal.js";
import athenahealth from "./athenahealth.js";
import webhook from "./webhook.js";

const ADAPTERS = [internal, athenahealth, webhook];
const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

/** The adapter used when a business has never chosen one. */
export const DEFAULT_SCHEDULING_ADAPTER = "internal";

/**
 * Resolve the scheduling adapter for a business.
 *
 * Order matters and encodes the dual-read: explicit configuration wins, then an
 * enabled EHR integration (how every business was routed before this table
 * existed), then the internal table. A business mid-migration must keep
 * reaching the same appointment book it did yesterday.
 *
 * @param {object} capabilityCfg - config.capabilities.appointments
 * @param {Array} integrations - the business's integration rows
 * @returns {object} an adapter; never null
 */
export function resolveSchedulingAdapter(capabilityCfg, integrations) {
  const configured = capabilityCfg?.adapter;
  if (configured && BY_ID.has(configured)) return BY_ID.get(configured);

  const list = Array.isArray(integrations) ? integrations : [];
  for (const adapter of ADAPTERS) {
    if (typeof adapter.claimsIntegration === "function" && adapter.claimsIntegration(list)) {
      return adapter;
    }
  }

  return BY_ID.get(DEFAULT_SCHEDULING_ADAPTER);
}

/** @param {string} id */
export function getSchedulingAdapter(id) {
  return BY_ID.get(id) ?? null;
}

export function listSchedulingAdapters() {
  return [...ADAPTERS];
}

/**
 * Facts this business's backend can actually prove a caller against.
 *
 * The settings UI reads this to decide which identity checks it may offer as
 * verified rather than merely collected.
 */
export function verifiableFieldsFor(capabilityCfg, integrations) {
  return resolveSchedulingAdapter(capabilityCfg, integrations).verifiableFields || [];
}
