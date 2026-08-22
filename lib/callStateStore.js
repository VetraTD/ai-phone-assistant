/**
 * The shared slice of call state, and the store it lives in.
 *
 * ---------------------------------------------------------------------------
 * Why there is a slice at all
 * ---------------------------------------------------------------------------
 *
 * Call state is one object holding two very different kinds of thing:
 *
 *   LOCAL, and unserialisable by nature — the Twilio WebSocket, the Deepgram
 *   connection, a queue of mulaw Buffers, the barge-in epoch. None of it means
 *   anything in another process. A socket is not data.
 *
 *   SHARED, and tiny — the three scalars another process actually reads.
 *
 * Today one process holds both because one process handles the whole call. On
 * Cloud Run that stops being true: `/twilio/status` is an ordinary HTTP POST
 * and the load balancer will route it to whichever instance is free, which is
 * usually not the one holding the WebSocket. The handler then reads a freshly
 * created empty state, and the failure is silent in the worst way — no
 * summary, no missed-call notification, and every short call tagged as spam,
 * because `sawCallerFinal` reads false on a caller who spoke.
 *
 * ---------------------------------------------------------------------------
 * Why the slice is three fields and not thirty
 * ---------------------------------------------------------------------------
 *
 * Because three is what `/twilio/status` reads. It was tempting to share the
 * conversation history, the step, the intent — all serialisable, all "might be
 * useful". Every one of them would be written on a turn boundary, and the
 * design constraint that makes this free is that NOTHING here is written per
 * turn. The measured baseline is a 2,611 ms voice-to-voice p50 with the LLM at
 * 42% of it; a Memorystore round trip inside the turn loop would be the only
 * thing in this migration that made the product worse.
 *
 * So: read once at start, write at call boundaries, never per turn. The one
 * field that looks like an exception is `sawCallerFinal`, and it is not one —
 * it is a latch, written exactly once on the first caller utterance and never
 * again.
 */

/** Fields that cross a process boundary. Everything else stays local. */
export const SHARED_FIELDS = Object.freeze(["dbCallId", "businessId", "sawCallerFinal"]);

/**
 * @typedef {object} CallStateStore
 * @property {(callSid: string) => Promise<object|null>} get
 * @property {(callSid: string, patch: object) => Promise<void>} merge
 * @property {(callSid: string) => Promise<void>} delete
 */

/**
 * The default: a Map in this process.
 *
 * Correct for a single instance, and B2 swaps it for Memorystore without any
 * caller changing, which is the point of there being an interface at all.
 *
 * @param {{ ttlMs?: number }} [opts]
 * @returns {CallStateStore}
 */
export function createMemoryStore({ ttlMs = 60 * 60 * 1000 } = {}) {
  /** @type {Map<string, { value: object, expiresAt: number }>} */
  const entries = new Map();

  function live(callSid) {
    const e = entries.get(callSid);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      entries.delete(callSid);
      return null;
    }
    return e;
  }

  return {
    async get(callSid) {
      return live(callSid)?.value ?? null;
    },
    async merge(callSid, patch) {
      const existing = live(callSid);
      const value = { ...(existing?.value ?? {}), ...patch };
      entries.set(callSid, { value, expiresAt: Date.now() + ttlMs });
    },
    async delete(callSid) {
      entries.delete(callSid);
    },
    /** Test seam. Not part of the interface B2 has to implement. */
    _size: () => entries.size,
  };
}

/**
 * Keep only the shared fields, and only those actually present.
 *
 * `undefined` is dropped rather than written, so a `merge` never clobbers a
 * value another writer already set with nothing. That matters because the two
 * writers are genuinely concurrent: the session sets businessId and dbCallId
 * when it resolves the tenant, and sets sawCallerFinal when the caller first
 * speaks, and there is no ordering guarantee between them.
 *
 * @param {object} state
 * @returns {object}
 */
export function sharedSlice(state) {
  const out = {};
  for (const key of SHARED_FIELDS) {
    if (state?.[key] !== undefined) out[key] = state[key];
  }
  return out;
}
