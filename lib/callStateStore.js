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

/**
 * The Postgres store: the same three methods, across processes.
 *
 * ---------------------------------------------------------------------------
 * Why Postgres and not Memorystore
 * ---------------------------------------------------------------------------
 *
 * Because of the property the top of this file spends thirty lines
 * establishing: nothing here is written per turn. Three scalars, read once at
 * the status callback, written at call boundaries, with `sawCallerFinal` a
 * latch that fires once. A store with those access patterns does not need to be
 * fast, it needs to be SHARED — and there is already a shared, connection-
 * pooled, backed-up database in the request path. Memorystore is $70-100/month
 * to make a handful of writes per call faster than they need to be.
 *
 * The moment that reasoning stops holding is the moment somebody writes inside
 * the turn loop. `app_call_state_merge` raises on any field outside
 * SHARED_FIELDS specifically so that change cannot be made quietly.
 *
 * ---------------------------------------------------------------------------
 * Why it takes a pool instead of making one
 * ---------------------------------------------------------------------------
 *
 * `instances x DB_POOL_MAX` under the instance's `max_connections` is the
 * binding capacity constraint on this system (ledger P7), and a store that
 * opened its own pool would silently double the left-hand side. Taking the
 * pool means call state costs ZERO additional connections, so turning
 * CALL_STATE_STORE on cannot move the number Phase 4 has to size against.
 *
 * It is also what makes the cross-process test honest: the test hands it two
 * genuinely independent pools, which is the thing a single Map can never fake.
 *
 * ---------------------------------------------------------------------------
 * The one known divergence from createMemoryStore
 * ---------------------------------------------------------------------------
 *
 * A field written as an explicit `null` comes back ABSENT here and comes back
 * as `null` from the memory store — `app_call_state_get` strips nulls so that
 * "never written" and "written as null" have one representation. Every consumer
 * reads `shared.x ?? null`, so the two are indistinguishable downstream, and
 * `false` is not stripped, which is the case that would have mattered: a
 * genuinely silent call must read `sawCallerFinal: false`, not "unknown".
 *
 * @param {{ pool: import("pg").Pool, ttlMs?: number, pruneIntervalMs?: number }} opts
 * @returns {CallStateStore & { close: () => void }}
 */
export function createPgStore({ pool, ttlMs = 60 * 60 * 1000, pruneIntervalMs = 5 * 60 * 1000 } = {}) {
  if (!pool) throw new Error("createPgStore: a pg.Pool is required");

  // Seconds, because that is what make_interval takes. Rounded up so a TTL is
  // never shorter than asked for; a negative ttl (the tests' way of forcing
  // expiry) becomes 0, which expires everything, as it does in the memory
  // store.
  const ttlSeconds = Math.max(0, Math.ceil(ttlMs / 1000));

  /**
   * Deleting expired rows, as opposed to merely ignoring them.
   *
   * The read filter in `app_call_state_get` is what makes expiry CORRECT; this
   * is what stops the table growing. Unref'd, so it cannot hold a process open
   * — a Cloud Run instance that will not exit is billed for the privilege, and
   * `scripts/*` that import this module must still terminate.
   *
   * Failures are logged by the query's own catch and never thrown: a cleanup
   * sweep is not something a call may fail on.
   */
  const timer =
    pruneIntervalMs > 0
      ? setInterval(() => {
          pool
            .query("SELECT app_call_state_prune($1) AS removed", [ttlSeconds])
            .catch(() => {});
        }, pruneIntervalMs)
      : null;
  timer?.unref?.();

  return {
    async get(callSid) {
      const { rows } = await pool.query("SELECT app_call_state_get($1, $2) AS state", [callSid, ttlSeconds]);
      return rows[0]?.state ?? null;
    },
    async merge(callSid, patch) {
      // Stringified rather than passed as an object so `pg` sends it as jsonb
      // and not as a text literal the function then cannot index into.
      await pool.query("SELECT app_call_state_merge($1, $2::jsonb)", [callSid, JSON.stringify(patch ?? {})]);
    },
    async delete(callSid) {
      await pool.query("SELECT app_call_state_delete($1)", [callSid]);
    },
    /**
     * Remove expired rows now and report how many. The timer calls the same
     * function; this exists so a test can assert a number instead of asserting
     * that a sweep was scheduled.
     */
    async prune() {
      const { rows } = await pool.query("SELECT app_call_state_prune($1) AS removed", [ttlSeconds]);
      return rows[0]?.removed ?? 0;
    },
    /** Stop the sweep. The POOL is the caller's and is deliberately not closed. */
    close() {
      if (timer) clearInterval(timer);
    },
  };
}
