import { createMemoryStore, createPgStore, sharedSlice } from "./callStateStore.js";
import { log } from "./logger.js";

/**
 * LOCAL state, this process only. Holds the WebSocket, the Deepgram
 * connection, the audio queue — things that are meaningless anywhere else.
 *
 * The three fields another process needs live in the store below. See
 * lib/callStateStore.js for why the split exists and why it is three fields.
 */
/** @type {Map<string, object>} */
const stateByCallSid = new Map();

/** @type {import("./callStateStore.js").CallStateStore} */
let store = createMemoryStore();

/**
 * Swap the shared store. B2 passes a Memorystore-backed one; tests pass
 * whatever they need to prove a second process can read what the first wrote.
 * @param {import("./callStateStore.js").CallStateStore} next
 */
export function setStore(next) {
  store = next;
}

/**
 * Accepted values for CALL_STATE_STORE, and why there are four of them.
 *
 * `postgres` and `memorystore` are the words `var.call_state_store` already
 * uses in `infra/terraform/`, and that variable is what will render this
 * environment variable onto the service. `pg` and `memory` are the words the
 * plan and every code comment use. A mismatch between the two vocabularies is
 * a service that boots with the wrong store because somebody typed the name
 * their own file uses, so both are accepted rather than one being declared
 * correct.
 *
 * `memorystore` maps to the in-process Map DELIBERATELY and is not silently
 * "close enough": no Memorystore adapter exists, and the ledger's costing says
 * one should not be bought until a measurement demands it. Selecting it gets
 * the single-instance store plus a warning that says so, because the failure it
 * would otherwise produce is the silent one this whole change exists to close.
 */
const STORE_KINDS = new Set(["memory", "memorystore", "pg", "postgres"]);

/**
 * Choose the shared store from configuration. Call ONCE, at startup, after the
 * database pool exists.
 *
 * Three refusals rather than three fallbacks, and the reason is the same each
 * time: every fallback here is indistinguishable at runtime from working. A
 * process that meant to share state and did not is a process that answers calls
 * perfectly and loses every summary, notification and spam decision — with no
 * error, on the instance that did not handle the call. That is precisely the
 * bug being fixed, so it must not be reachable by misconfiguration.
 *
 * @param {{ pool?: import("pg").Pool|null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {"memory"|"pg"} which store is now in use
 */
export function initCallStateStore({ pool = null, env = process.env } = {}) {
  const raw = (env.CALL_STATE_STORE ?? "").trim().toLowerCase();

  if (raw && !STORE_KINDS.has(raw)) {
    throw new Error(
      `CALL_STATE_STORE="${raw}" is not a store. Use "pg" (or "postgres") for the shared ` +
        `Postgres store, or "memory" to keep the single-process Map. Refusing to guess, because ` +
        `guessing "memory" here loses every call summary the moment a second instance exists.`
    );
  }

  if (raw === "pg" || raw === "postgres") {
    if (!pool) {
      throw new Error(
        "CALL_STATE_STORE=pg but no database pool exists. Set DATABASE_URL or CLOUD_SQL_INSTANCE. " +
          "Refusing to fall back to the in-process store: it would run, and /twilio/status would " +
          "silently produce no summary, no missed-call notification, and a spam tag on every short call."
      );
    }
    store = createPgStore({ pool });
    log.info("call_state_store_selected", { store: "pg", shared: true });
    return "pg";
  }

  if (raw === "memorystore") {
    log.error("call_state_store_memorystore_unavailable", {
      severity: "warn",
      message:
        "CALL_STATE_STORE=memorystore: no Memorystore adapter exists, using the in-process Map. " +
        "This is NOT shared across instances. Use CALL_STATE_STORE=pg.",
    });
  }

  // Announced even in the default case. A subsystem that is off must say so at
  // boot, or "single instance" and "multi-instance and silently broken" look
  // identical in the logs.
  log.info("call_state_store_selected", { store: "memory", shared: false });
  return "memory";
}

/**
 * Read the shared slice — the call-boundary read, done by a process that did
 * NOT handle the call.
 *
 * Returns `{}` rather than null when nothing is stored, so every caller can
 * destructure without a guard. An absent record and a record with no fields
 * set mean the same thing here: we know nothing about this call.
 *
 * @param {string} callSid
 * @returns {Promise<{dbCallId?: string|null, businessId?: string|null, sawCallerFinal?: boolean}>}
 */
export async function readShared(callSid) {
  if (!callSid) return {};
  try {
    return (await store.get(callSid)) ?? {};
  } catch (err) {
    // A store that is down must not take the status handler with it. The
    // handler degrades — no summary, no spam tag — which is worse than working
    // and much better than a 500 that makes Twilio retry the callback.
    log.error("call_state_store_read_failed", { callSid, message: err?.message, severity: "warn" });
    return {};
  }
}

/**
 * Write the shared slice. Call at call BOUNDARIES — never per turn.
 *
 * Fire-and-forget by design: the caller is on a latency path and the write is
 * not something the turn depends on. A failure is logged, not awaited.
 *
 * @param {string} callSid
 * @param {object} patch - any subset of SHARED_FIELDS
 */
export function writeShared(callSid, patch) {
  if (!callSid) return;
  const slice = sharedSlice(patch);
  if (Object.keys(slice).length === 0) return;
  enqueue(callSid, () => store.merge(callSid, slice), "call_state_store_write_failed");
}

// ---------------------------------------------------------------------------
// Ordering, per call
// ---------------------------------------------------------------------------
//
// FOUND BY THE POSTGRES STORE, AND IT IS A REAL BUG, NOT A TEST ARTEFACT.
//
// There are two boundary writers on a call and they are not synchronised:
//
//   session.js:3145  at pickup, once the tenant resolves, writes the WHOLE
//                    slice — which at that moment includes sawCallerFinal:false
//   session.js:1614  the latch, on the caller's first utterance
//
// Both are fire-and-forget. Against a Map or a file they complete synchronously
// and therefore in issue order. Against Postgres they are two queries on a
// pool, and the pool does not promise order. A caller who speaks over the
// greeting can produce latch-then-pickup, and the pickup write then puts
// `sawCallerFinal` back to false — so `/twilio/status` tags a short REAL call
// as spam, which is the exact failure this whole store exists to prevent,
// reintroduced by the fix for it.
//
// Serialising per call SID is the fix, rather than a latch in SQL: the store
// interface promises last-write-wins per field, and a `saw_caller_final` column
// that refused to go false would make the Postgres store behave differently
// from the memory store — at which point CALL_STATE_STORE is not a switch, it
// is a behaviour change. The ordering belongs where the two writers are.
//
// The queue is per call and drains to nothing, so it holds at most one entry
// per call in flight — the same lifetime the call itself has.

/** @type {Map<string, Promise<void>>} */
const writeChains = new Map();

/**
 * Run `task` after everything already queued for this call SID.
 *
 * Errors are logged and swallowed, exactly as before: the caller is on a
 * latency path, and a store that is down must not take a call with it. Swallowed
 * INSIDE the chain too, so one failed write does not cancel the ones behind it.
 */
function enqueue(callSid, task, event) {
  const next = (writeChains.get(callSid) ?? Promise.resolve())
    .then(task)
    .catch((err) => {
      log.error(event, { callSid, message: err?.message, severity: "warn" });
    })
    .finally(() => {
      // Only the tail clears the entry. A later enqueue has already replaced
      // it, and dropping that would let the next write race the one in flight.
      if (writeChains.get(callSid) === next) writeChains.delete(callSid);
    });

  writeChains.set(callSid, next);
  return next;
}

/**
 * Wait for this call's queued writes to land. Tests only.
 *
 * Nothing in the request path awaits this — the writes are fire-and-forget by
 * design. It exists so a test can assert on what was stored without sleeping.
 *
 * @param {string} callSid
 */
export async function flushShared(callSid) {
  await writeChains.get(callSid);
}

/**
 * Call-flow steps (state machine).
 *   greeting → identify_intent → gather_details → confirm → ending
 * "ending" means say goodbye and hang up.
 */
export const STEPS = {
  GREETING: "greeting",
  IDENTIFY_INTENT: "identify_intent",
  GATHER_DETAILS: "gather_details",
  CONFIRM: "confirm",
  ENDING: "ending",
};

/**
 * Get or create conversation state for a call.
 * @param {string} callSid - Twilio Call SID
 * @returns {object} Mutable state object
 */
export function getState(callSid) {
  let state = stateByCallSid.get(callSid);
  if (!state) {
    state = {
      step: STEPS.GREETING,
      intent: null,
      config: null,
      history: [],
      silenceCount: 0,
      dbCallId: null,
      businessId: null,
      callerNumber: null,
      knowledge: [],
      integrations: [],
      callerContext: null,
      sequenceCounter: 1,
      startedAt: Date.now(),
      // Per-capability scratchpad, keyed by pack id. Replaced the named
      // appointment fields that used to live directly on call state — a
      // capability remembers what it established with this caller without the
      // engine holding a field for it.
      capabilityState: {},
      // Hold-and-redirect state (set when Gemini is processing in background)
      pendingReply: null,
      pendingSpeech: null,
      pendingSpeechHash: null,
      pendingGeminiStart: null,
      pendingRequestId: null,
      // Media Streams state (set when using WebSocket-based real-time audio)
      ws: null,               // WebSocket connection to Twilio
      streamSid: null,        // Twilio media stream SID
      deepgramConn: null,     // Active Deepgram STT connection
      aiSpeaking: false,      // True while AI audio is being sent to caller
      bargedIn: false,        // Set true when barge-in detected; resets each turn
      audioQueue: [],         // Pending mulaw Buffers awaiting send
      turnId: 0,              // Monotonic counter — used for mark events
      // turnId of the most recent turn cut short by a barge-in. Its metrics
      // were already closed as barged, so its -done mark (which Twilio still
      // echoes back, since barge-in leaves queued audio playing) must not
      // close them a second time. See session.js's "mark" handler.
      bargedTurnId: null,
      mediaStream: false,     // True when this call uses Media Streams path
      processingTurn: false,  // True while a Gemini turn is in flight (prevents concurrent calls)
      speakEpoch: 0,          // Incremented on barge-in; TTS checks this to cancel stale synthesis
      // Set true the moment STT delivers ANY non-empty caller final (both
      // pipelines) — read synchronously in-memory by /twilio/status's spam
      // heuristic (server.js) to avoid a race against the fire-and-forget
      // call_transcripts DB insert: the transcript row for a short, real
      // call may not have landed yet by the time the status callback fires,
      // but this flag is set live during the call, well before it ends.
      sawCallerFinal: false,
      // How many caller utterances have been handed to the LLM on this call,
      // and whether any action tool has ever succeeded on it.
      //
      // Both gate end_call (services/tools.js). The gate used to accept only
      // step confirm/ending or an action completed in the SAME turn, which no
      // message-taking or informational call could ever satisfy — so the
      // assistant said goodbye and then could not hang up. These are the
      // call-scoped signals that make wrapping up reachable.
      callerTurnCount: 0,
      completedActionThisCall: false,
    };
    stateByCallSid.set(callSid, state);
  }
  return state;
}

/**
 * Remove call state (e.g. when call ends). Call from status callback.
 *
 * Clears BOTH halves. The local map is this process's, and dropping it on a
 * process that never held the call is a no-op — which is the normal case once
 * the status callback lands on a different instance.
 *
 * @param {string} callSid - Twilio Call SID
 */
export function remove(callSid) {
  stateByCallSid.delete(callSid);
  // Queued behind this call's pending writes for the same reason they are
  // queued behind each other: a delete that overtakes an in-flight merge leaves
  // the row it was meant to remove.
  enqueue(callSid, () => store.delete(callSid), "call_state_store_delete_failed");
}

// ---------------------------------------------------------------------------
// TTL cleanup — evict abandoned call states older than 60 minutes
// ---------------------------------------------------------------------------

const CALL_STATE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - CALL_STATE_TTL_MS;
  for (const [sid, state] of stateByCallSid) {
    if (state.startedAt < cutoff) {
      stateByCallSid.delete(sid);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Don't block process exit
cleanupTimer.unref();
