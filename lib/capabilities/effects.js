/**
 * Capability effect dispatch, shared by both voice pipelines.
 *
 * lib/voice/session.js (v2, the default) and lib/mediaStream.js (v1, reachable
 * via PIPELINE_V2=false) both have to apply what a capability reports. Having
 * one implementation is not tidiness — when the appointment side effects were
 * duplicated in both files, migrating one and forgetting the other meant the
 * rollback path silently stopped notifying owners about bookings and stopped
 * persisting messages entirely. A rollback that loses data is worse than no
 * rollback at all.
 *
 * The engine supplies primitives and call context; it never learns what
 * "booked" or "recorded" means. That stays in the capability pack.
 */

import { getPack } from "../../capabilities/index.js";

/**
 * Merge a per-capability scratchpad patch into a call's state.
 *
 * Shallow per capability, so two tools from the same capability in one turn
 * both contribute. A null VALUE clears that key (how a cancel kills a booking
 * anchor); a null CAPABILITY drops the whole slot.
 *
 * @param {object} state - call state; state.capabilityState is created if absent
 * @param {Record<string, object|null>} patch
 */
export function mergeCapabilityState(state, patch) {
  if (!state || !patch) return;
  state.capabilityState = state.capabilityState || {};
  for (const [capability, value] of Object.entries(patch)) {
    if (value === null) {
      delete state.capabilityState[capability];
    } else {
      state.capabilityState[capability] = {
        ...(state.capabilityState[capability] || {}),
        ...value,
      };
    }
  }
}

/**
 * Hand each effect to the pack that owns it.
 *
 * History notes are RETURNED rather than pushed so the caller controls where in
 * the turn they land — the two pipelines build history slightly differently,
 * and several effects in one turn should still produce a single bracketed note.
 *
 * @param {Array<{capability: string, type: string, data?: object}>} effects
 * @param {object} engine - primitives + context handed to the pack
 * @returns {string[]} history notes to emit
 */
export function dispatchCapabilityEffects(effects, engine) {
  const notes = [];
  if (!Array.isArray(effects) || effects.length === 0) return notes;

  const engineWithNotes = {
    ...engine,
    addHistoryNote(note) {
      if (note) notes.push(note);
    },
  };

  for (const effect of effects) {
    const pack = getPack(effect?.capability);
    if (!pack || typeof pack.onEffect !== "function") {
      engine.deps?.log?.error?.("capability_effect_unhandled", {
        capability: effect?.capability,
        type: effect?.type,
        severity: "warn",
      });
      continue;
    }
    try {
      pack.onEffect(effect, engineWithNotes);
    } catch (err) {
      // One misbehaving capability must not take down the turn — the caller is
      // mid-call and the other effects still need applying.
      engine.deps?.log?.error?.("capability_effect_failed", {
        capability: effect.capability,
        type: effect.type,
        reason: err?.message,
      });
      engine.deps?.captureException?.(err);
    }
  }

  return notes;
}
