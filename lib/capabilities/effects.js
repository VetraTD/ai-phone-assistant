/**
 * Capability effect dispatch, shared by both voice pipelines.
 *
 * lib/voice/session.js is the only pipeline now (A10 deleted the v1 one), but
 * the seam stays: the text harness in lib/harness/ also has to apply what
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

  function addHistoryNote(note) {
    if (note) notes.push(note);
  }

  // The caller snapshot has to follow the BATCH, not just the turn.
  //
  // LVX33: this used to build one engine before the loop, so every effect read
  // `engine.call.callerContext` — a value each driver copies into its `call`
  // literal at dispatch time, and one that `setCallerContext` cannot reach,
  // because the setter rebinds the session's own reference. Three cancellations
  // in one turn therefore each recomputed from the SAME starting list and the
  // last write won, leaving two of the three appointments in the snapshot. The
  // assistant then told the caller they still had appointments it had just
  // cancelled, and the existing-appointment guard refused to book anything for
  // the rest of the call.
  //
  // Held HERE rather than in the pack because the contract is that a pack
  // computes the next value and the ENGINE owns the state. Keeping the engine's
  // own view consistent from one effect to the next is the engine's job.
  const tracksCallerContext = typeof engine?.setCallerContext === "function";
  let callerContext = engine?.call?.callerContext ?? null;

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
    // Rebuilt per effect, so the previous one's snapshot write is visible to
    // this one. The setter wrapper is added only when the driver has a setter
    // at all — the text harness deliberately has none and is not at parity,
    // and capabilities/appointments.js bails out on exactly that.
    const engineWithNotes = tracksCallerContext
      ? {
          ...engine,
          addHistoryNote,
          ...(engine.call ? { call: { ...engine.call, callerContext } } : {}),
          setCallerContext(next) {
            callerContext = next || null;
            engine.setCallerContext(next);
          },
        }
      : { ...engine, addHistoryNote };

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
